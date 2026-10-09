import type { TaskPlan } from '@/models'
import type { LayerId } from '@/host/types'
import {
  runAdvisories,
  runVetoGate,
  runOverrideWithFallback,
  snapshotAdvisoriesForLayer,
  type HookRunner,
  type HookSnapshot,
  type AdvisoryContribution,
  type VetoGateReport
} from './hooks'

/**
 * 规格 4.3 M5：强六层路由 dispatch 编排核。
 *
 * 本模块是"编排核"：只持有层级顺序、门值评估、钩子插桩、降级与两道门位置；
 * 每层的默认实现由内核插件注入（src/kernels/default/），可被 override 钩子替换。
 * 门值由内核插件配置（FunnelGates），领域钩子只能经 advisory（scoreDelta）影响打分。
 */

export interface FunnelGates {
  /** L0.5 快配过门置信（现状 0.6） */
  l05Pass: number
  /** L0.5 高置信自动执行（现状 0.9，另需计划无 shell） */
  l05Auto: number
  /** L1 能力直调过门置信（现状 0.6） */
  l1Pass: number
}

// 2026-09-30：l05Pass 由 0.8 降到 0.6。原 0.8 等价于 hitRatio ≥ 0.533，实测 L0.5 对典型
// 输入只有 ~8% 命中（近死层）；且该门当时被 tryL05QuickMatch 内的硬编码 0.8 遮蔽、调低无效
// （现已移除内层硬门，本 gate 是唯一过门判定点）。0.6 与内层"基本过滤"下限（hitRatio 0.4）
// 对齐，也与 l1Pass 同档。l05Auto（自动执行门）保持 0.9 不变——降门只放宽"进入快配"，
// 高置信才自动执行。
export const DEFAULT_FUNNEL_GATES: FunnelGates = { l05Pass: 0.6, l05Auto: 0.9, l1Pass: 0.6 }

/** 层产出：plan（带分值时过门评估）/ 交互暂停点 / MCP 直调 / miss（降级） */
export type LayerResult =
  | { kind: 'plan'; plan: TaskPlan; macroManifestId?: string | null; score?: number; autoExecutable?: boolean; competition?: CompetitionRecord }
  | { kind: 'candidates'; candidates: Array<{ id: string; name: string; score: number }> }
  | { kind: 'intent-confirm'; intent: string; manifestId: string; params: Record<string, unknown>; originalInput: string }
  | { kind: 'slot-fill'; manifestId: string; manifestName: string; slots: Array<{ name: string; description: string; required: boolean; value: string }> }
  | { kind: 'mcp-direct'; toolName: string }
  | { kind: 'miss' }

/**
 * M16 竞争记录：胜者 pack 与败者 pack 集。
 * 由 l2() 竞争分支产出，随 plan 层产出与 FunnelOutcome 透传给适配层（影子评估 + EMA 更新接线点）。
 */
export interface CompetitionRecord {
  winnerPackId: string
  loserPackIds: string[]
}

export type LayerImpl<T extends FunnelBaseContext> = (
  input: string,
  merged: AdvisoryContribution | null,
  ctx: T
) => Promise<LayerResult> | LayerResult

/** 请求级上下文（默认内核插件经泛型扩展挂载数据：manifests/toolIndex 等） */
export interface FunnelBaseContext {
  domain?: string
  stream?: boolean
  /** 空输入/纯空白 → 跳过 L0-L3 直达 L4 */
  isEmptyInput?: boolean
  /** L3 进入时（即将调 LLM）的簇点位回调：route + budget + security；不允许 → 中止 */
  beforeLlm?: () => Promise<{ allowed: boolean; reason?: string }>
  /** veto 严格契约模式 flag（M6.2，默认关） */
  strictVeto?: boolean
  metadata?: Record<string, string>
}

export interface FunnelLayerSet<T extends FunnelBaseContext> {
  l0: LayerImpl<T>
  l05: LayerImpl<T>
  l1: LayerImpl<T>
  l2: LayerImpl<T>
  l3: LayerImpl<T>
  l4: LayerImpl<T>
}

export interface FunnelConfig<T extends FunnelBaseContext> {
  layers: FunnelLayerSet<T>
  hooks: HookRunner<LayerResult>
  gates?: Partial<FunnelGates>
  overrideTimeoutMs?: number
  fewShotLimit?: number
}

export type FunnelOutcome =
  | { kind: 'plan'; plan: TaskPlan; macroManifestId: string | null; autoExecutable: boolean; source: LayerId; competition?: CompetitionRecord }
  | { kind: 'candidates'; candidates: Array<{ id: string; name: string; score: number }>; source: LayerId }
  | { kind: 'intent-confirm'; intent: string; manifestId: string; params: Record<string, unknown>; originalInput: string; source: LayerId }
  | { kind: 'slot-fill'; manifestId: string; manifestName: string; slots: Array<{ name: string; description: string; required: boolean; value: string }>; source: LayerId }
  | { kind: 'mcp-direct'; toolName: string; source: LayerId }
  | { kind: 'blocked'; veto: VetoGateReport }
  | { kind: 'budget-blocked'; reason: string }
  | { kind: 'error'; error: string }

const LAYER_ORDER: LayerId[] = ['L0', 'L0.5', 'L1', 'L2', 'L3', 'L4']

export function planContainsShellExec(plan: TaskPlan): boolean {
  return plan.steps.some(s => s.tool === 'shell_exec')
}

/**
 * M5 逐层执行。对每层：钩子收集（快照）→ 顾问执行（M5.2）→ M13 合并 →
 * 覆盖/默认实现（M5.4）→ 门评估 → 未过降级。
 * pre-execute 否决门：最终计划确定后、返回前全量评估（M6）。
 */
export async function runFunnel<T extends FunnelBaseContext>(
  config: FunnelConfig<T>,
  input: string,
  ctx: T
): Promise<FunnelOutcome> {
  const gates: FunnelGates = { ...DEFAULT_FUNNEL_GATES, ...config.gates }
  const overrideTimeoutMs = config.overrideTimeoutMs ?? 3000
  const snapshot: HookSnapshot<LayerResult> = config.hooks.snapshot()

  const runLayer = async (layer: LayerId, impl: LayerImpl<T>): Promise<LayerResult> => {
    // 1. 钩子收集（快照）+ 2. 顾问执行 + 3. M13 合并
    const advisoryHooks = snapshotAdvisoriesForLayer(snapshot, layer)
    let merged: AdvisoryContribution | null = null
    if (advisoryHooks.length > 0) {
      const run = runAdvisories(advisoryHooks, input, {
        domain: ctx.domain,
        metadata: ctx.metadata
      })
      merged = run.merged
      for (const w of run.warnings) console.warn(`[funnel] ${layer} ${w}`)
    }
    // 4. 覆盖执行（M7 槽 occupant + 超时回退）/ 默认实现
    const occupant = snapshot.overrideOccupants[layer]
    const run = await runOverrideWithFallback(
      occupant ?? null,
      () => impl(input, merged, ctx),
      input,
      merged,
      { domain: ctx.domain, metadata: ctx.metadata },
      { timeoutMs: overrideTimeoutMs, layer }
    )
    if (run.audit) {
      console.warn(`[funnel] ${JSON.stringify(run.audit)}`)
    }
    return run.outcome
  }

  const gateEvaluate = (layer: LayerId, result: LayerResult): LayerResult | 'degrade' => {
    if (result.kind !== 'plan') return result
    if (layer === 'L0.5') {
      const score = result.score ?? 0
      if (score < gates.l05Pass) return 'degrade'
      return {
        ...result,
        autoExecutable: score >= gates.l05Auto && !planContainsShellExec(result.plan)
      }
    }
    if (layer === 'L1') {
      const score = result.score ?? 0
      if (score < gates.l1Pass) return 'degrade'
    }
    if (layer === 'L0' || layer === 'L4') {
      // 2026-10-01：L0 直通（tryL0Skill 命中）对齐 L4 既有口径 —— 计划无 shell 即自动执行。
      // 原实现 L0 落到末尾裸 return（不设 autoExecutable）⇒ 一律 acquirePausePoint('confirmation') 弹确认条
      // ⇒ 零干预率恒为 0。实测（历史成绩单 2026-09-30-v2-full50，50 题；报告已移出仓库）：39 题走 L0/L1 直通
      // 全部要确认；而 L4 探索模式早在无 shell 时无确认地执行写操作（V2-M03 静默写出 mp3）。
      // 二者同为零 shell 的写操作却口径不一，此处对齐（带 shell 的计划仍走确认）。
      return { ...result, autoExecutable: result.autoExecutable ?? !planContainsShellExec(result.plan) }
    }
    return result
  }

  // 边界情况：空输入 → 跳过 L0-L3 直达 L4
  const startIdx = ctx.isEmptyInput ? 5 : 0

  // L3 进入时簇点位（route/budget/security）——预算不允许 → budget-blocked（不降级 L4）
  let llmGateChecked = false
  const ensureLlmGate = async (): Promise<FunnelOutcome | null> => {
    if (llmGateChecked || !ctx.beforeLlm) return null
    llmGateChecked = true
    const gate = await ctx.beforeLlm()
    if (!gate.allowed) {
      return { kind: 'budget-blocked', reason: gate.reason ?? 'llm gate denied' }
    }
    return null
  }

  for (let i = startIdx; i < LAYER_ORDER.length; i++) {
    const layer = LAYER_ORDER[i]
    const impl = config.layers[implKeyOf(layer)]
    let result: LayerResult
    try {
      if (layer === 'L3') {
        const blocked = await ensureLlmGate()
        if (blocked) return blocked
      }
      result = await runLayer(layer, impl)
    } catch (err) {
      // M5 错误路径：层实现抛错 → 视为该层未命中，降级下一层 + layer-error 日志
      console.error(`[funnel] layer-error{layer=${layer}}: ${(err as Error).message}`)
      continue
    }

    const evaluated = gateEvaluate(layer, result)
    if (evaluated === 'degrade') continue
    if (evaluated.kind === 'miss') continue

    // 交互暂停点产出：不经 pre-execute 门（尚无最终计划）
    if (evaluated.kind === 'candidates') return { ...evaluated, source: layer }
    if (evaluated.kind === 'intent-confirm') return { ...evaluated, source: layer }
    if (evaluated.kind === 'slot-fill') return { ...evaluated, source: layer }
    if (evaluated.kind === 'mcp-direct') return { ...evaluated, source: layer }

    // 最终计划确定 → pre-execute 否决门（M6 全量评估，不短路）
    const vetoReport = runVetoGate(snapshot.vetoes.filter(v => v.position === 'pre-execute'), evaluated.plan, {
      domain: ctx.domain,
      metadata: ctx.metadata
    }, { strict: ctx.strictVeto })
    for (const w of vetoReport.warnings) console.warn(`[funnel] pre-execute ${w}`)
    if (vetoReport.blocked) {
      return { kind: 'blocked', veto: vetoReport }
    }
    if (vetoReport.humanJudgmentPrompts.length > 0) {
      // M6.4：带 humanJudgmentPrompt → 保守不执行（人工复核暂停点由适配层驱动）
      return { kind: 'blocked', veto: vetoReport }
    }

    return {
      kind: 'plan',
      plan: evaluated.plan,
      macroManifestId: evaluated.macroManifestId ?? null,
      autoExecutable: evaluated.autoExecutable ?? false,
      source: layer,
      ...(evaluated.competition ? { competition: evaluated.competition } : {})
    }
  }

  // L4 也未产出（抛错/miss）→ all-layers-failed
  return { kind: 'error', error: 'all-layers-failed' }
}

function implKeyOf(layer: LayerId): 'l0' | 'l05' | 'l1' | 'l2' | 'l3' | 'l4' {
  switch (layer) {
    case 'L0': return 'l0'
    case 'L0.5': return 'l05'
    case 'L1': return 'l1'
    case 'L2': return 'l2'
    case 'L3': return 'l3'
    case 'L4': return 'l4'
  }
}

/**
 * M13 语义：advisory scoreDelta 叠加到层匹配分。
 * 供默认实现内部调用（L0.5/L1 打分后、门评估前）。
 */
export function applyScoreDelta(score: number, merged: AdvisoryContribution | null): number {
  if (merged && typeof merged.scoreDelta === 'number' && Number.isFinite(merged.scoreDelta)) {
    return score + merged.scoreDelta
  }
  return score
}

export type { HookSnapshot }
