import { vault } from '@/vault'
import { PLUGIN_ID_RE } from '@/host/types'
import type { HookContext, VetoResult } from '@/kernel/hooks'

/**
 * 规格 9（M16）竞争模型纯逻辑：竞标分 / 竞争消解 / 质量 EMA 存储 / 影子评估。
 *
 * 纯度约束（M18）：本模块只操作抽象 packId，不引入任何领域字符串字面量；
 * 审计与钩子访问经依赖注入（auditSink / vetoes），不 import store 与内核注册表。
 */

export interface PackBidder {
  packId: string
  confidence: number
  weight: number
  ema: number
  /** 注册顺序（候选序），全平分时的确定性兜底 */
  seq: number
}

export interface CompetitionResolution {
  winner: PackBidder
  losers: PackBidder[]
}

/** EMA outcome 归一常量（规格 9.1）：执行成功=1.0、执行失败=0.0、用户负反馈=0.2 */
export const EMA_OUTCOME_SUCCESS = 1.0
export const EMA_OUTCOME_FAILURE = 0.0
export const EMA_OUTCOME_NEGATIVE_FEEDBACK = 0.2

const EMA_ALPHA = 0.1
const EMA_INITIAL = 1.0

function safeNumber(v: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 竞标分 = 置信度 × weight × 质量EMA（规格 9.1）；非法值按 0 计 */
export function computeBidScore(b: PackBidder): number {
  const confidence = safeNumber(b.confidence, 0)
  const weight = safeNumber(b.weight, 1)
  const ema = safeNumber(b.ema, EMA_INITIAL)
  return Math.max(0, confidence) * Math.max(0, weight) * Math.max(0, ema)
}

/**
 * 竞争消解：竞标分降序 → weight 再平 → seq 小者胜（注册顺序确定性兜底，规格 9.1 边界情况）。
 * 少于 2 个投标者 → 返回 null（无竞争，调用方维持原路径）。
 */
export function resolveCompetition(bidders: PackBidder[]): CompetitionResolution | null {
  if (!Array.isArray(bidders) || bidders.length < 2) return null
  const sorted = [...bidders].sort((a, b) => {
    const diff = computeBidScore(b) - computeBidScore(a)
    if (diff !== 0) return diff
    const weightDiff = safeNumber(b.weight, 1) - safeNumber(a.weight, 1)
    if (weightDiff !== 0) return weightDiff
    return safeNumber(a.seq, 0) - safeNumber(b.seq, 0)
  })
  return { winner: sorted[0], losers: sorted.slice(1) }
}

/** vault 持久化接口（测试可注入内存实现） */
export interface EmaPersistence {
  list(namespace?: string): Promise<string[]>
  read(namespace: string, key: string): Promise<string | null>
  writeThrough(namespace: string, key: string, value: string): void
}

const PACK_STATS_NS = 'packStats'

/**
 * 质量评分 EMA 存储：内存 Map + vault namespace 'packStats' 持久化
 * （writeThrough 经 vault 客户端既有批量合并语义落盘）。
 * 初始 1.0；ema = 0.9×ema + 0.1×outcome，clamp [0,1]。
 */
export class QualityEmaStore {
  private ema = new Map<string, number>()
  private readonly persistence: EmaPersistence

  constructor(persistence: EmaPersistence = vault) {
    this.persistence = persistence
  }

  get(packId: string): number {
    const v = this.ema.get(packId)
    return typeof v === 'number' && Number.isFinite(v) ? v : EMA_INITIAL
  }

  update(packId: string, outcome: number): void {
    const clampedOutcome = Math.min(1, Math.max(0, safeNumber(outcome, 0)))
    const next = 0.9 * this.get(packId) + EMA_ALPHA * clampedOutcome
    this.ema.set(packId, Math.min(1, Math.max(0, next)))
    try {
      this.persistence.writeThrough(PACK_STATS_NS, packId, String(this.ema.get(packId)))
    } catch { /* 持久化失败不阻断内存 EMA（读不到时回退 1.0） */ }
  }

  /** App 启动时调用（vault syncFromVault 之后）；键值经 A1-20 式格式校验，非法条目忽略 */
  async load(): Promise<void> {
    let keys: string[] = []
    try {
      keys = await this.persistence.list(PACK_STATS_NS)
    } catch {
      return
    }
    for (const fullKey of keys) {
      const colonIdx = fullKey.indexOf(':')
      const packId = colonIdx >= 0 ? fullKey.slice(colonIdx + 1) : fullKey
      if (!PLUGIN_ID_RE.test(packId)) continue
      try {
        const raw = await this.persistence.read(PACK_STATS_NS, packId)
        if (raw === null) continue
        const value = Number.parseFloat(raw)
        if (Number.isFinite(value)) {
          this.ema.set(packId, Math.min(1, Math.max(0, value)))
        }
      } catch { /* 单键损坏跳过 */ }
    }
  }

  /** 测试辅助：清空内存态 */
  clearForTest(): void {
    this.ema.clear()
  }
}

/** 生产单例：内核 l2() 与适配层 EMA 更新共用 */
export const qualityEmaStore = new QualityEmaStore()

/** 影子评估审计条目（适配层包装成 memoryStore.addAuditLog / bus 事件落审计） */
export interface ShadowAuditEntry {
  packId: string
  wouldVeto: boolean
  severity?: 'block' | 'warn'
  reason?: string
  ts: number
}

export interface ShadowEvalDeps {
  /** 激活内核 HookRunner 的 pre-output veto 钩子（getVetoes('pre-output')） */
  vetoes?: Array<{ pluginId: string; check(payload: unknown, ctx: HookContext): VetoResult }>
  /** 审计出口；缺省时仅 console 输出 */
  auditSink?: (entry: ShadowAuditEntry) => void
}

/**
 * 影子评估（规格 9.1）：败者 pack 对最终产出做只读 wouldVeto 判定。
 * 零副作用铁律：不写缓存、无 UI 事件、无状态变更；单 pack 失败静默 + console.warn，
 * 绝不影响主流程。逐 pack 落审计条目（含无钩子 pack 的 wouldVeto=false 记录）。
 */
export async function runShadowEvaluation(packIds: string[], payload: unknown, deps: ShadowEvalDeps = {}): Promise<void> {
  if (!Array.isArray(packIds) || packIds.length === 0) return
  for (const packId of packIds) {
    let entry: ShadowAuditEntry
    const hook = deps.vetoes?.find(v => v.pluginId === packId)
    if (!hook) {
      entry = { packId, wouldVeto: false, ts: Date.now() }
    } else {
      try {
        const result = hook.check(payload, {})
        const vetoed = !!(result && typeof result === 'object' && result.veto)
        entry = {
          packId,
          wouldVeto: vetoed,
          ...(vetoed ? { severity: result.severity === 'block' ? 'block' as const : 'warn' as const, reason: String(result.reason ?? '') } : {}),
          ts: Date.now()
        }
      } catch (err) {
        // 影子绝不影响主流程：失败按"未否决"记录
        console.warn(`[competition] shadow eval failed (pack=${packId}): ${(err as Error).message}`)
        entry = { packId, wouldVeto: false, ts: Date.now() }
      }
    }
    try {
      if (deps.auditSink) {
        deps.auditSink(entry)
      } else {
        console.log(`[competition] shadow-eval ${JSON.stringify(entry)}`)
      }
    } catch (err) {
      console.warn(`[competition] shadow audit sink failed (pack=${packId}): ${(err as Error).message}`)
    }
  }
}
