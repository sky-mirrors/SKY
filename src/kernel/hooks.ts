import type { HookLayer, LayerId } from '@/host/types'

/**
 * 规格 5：三档钩子执行器（M5 步骤 1-4 / M6 / M7 / M13 / M15）。
 *
 * 职责边界：
 * - HookRunner 只管"注册表 + 快照 + 执行/合并/聚合"，不知道六层语义（层序与门值由内核插件持有）；
 * - 注册顺序 = 插件注册顺序：入表时分配单调递增 seq，全序稳定（M13 确定性前提）；
 * - 权限（M14）由注册方（插件适配层）复查后置 hasPermission；false → 运行时跳过 + warning。
 */

export type VetoGatePosition = 'pre-execute' | 'pre-output'

export interface HookContext {
  domain?: string
  packId?: string
  metadata?: Record<string, string>
}

/** 规格 5.1：顾问贡献（M13 合并对象）。candidates 仅要求可去重的 id，其余字段对合并器不透明 */
export interface AdvisoryContribution {
  scoreDelta?: number
  candidates?: Array<{ id: string; [key: string]: unknown }>
  keywords?: string[]
  fewShots?: unknown[]
  terminology?: Record<string, string>
  exploreTemplate?: unknown
}

/** 规格 5.1：否决结果 */
export interface VetoResult {
  veto: boolean
  severity: 'block' | 'warn'
  reason: string
  humanJudgmentPrompt?: string
}

/** 覆盖实现结果：miss=true → 该层未命中，走降级（实现可主动放弃，但不能改降级去向）；T 为具体层产出类型（默认透传） */
export type OverrideOutcome = { miss: true } | { miss: false; value: unknown }

export interface AdvisoryHookEntry {
  pluginId: string
  layer: LayerId
  seq: number
  hasPermission?: boolean
  contribute(input: string, ctx: HookContext): AdvisoryContribution
}

export interface VetoHookEntry {
  pluginId: string
  position: VetoGatePosition
  seq: number
  hasPermission?: boolean
  check(payload: unknown, ctx: HookContext): VetoResult
}

export interface OverrideHookEntry<T = OverrideOutcome> {
  pluginId: string
  layer: LayerId
  priority: number
  seq: number
  hasPermission?: boolean
  impl(input: string, merged: AdvisoryContribution | null, ctx: HookContext): T | Promise<T>
}

export interface AdvisoryRunResult {
  merged: AdvisoryContribution
  warnings: string[]
}

/** 规格 5.4：否决门聚合报告 */
export interface VetoGateReport {
  blocked: boolean
  entries: Array<{ pluginId: string; severity: 'block' | 'warn'; reason: string }>
  warnings: string[]
  humanJudgmentPrompts: string[]
}

export type HookRunnerEvent =
  | { type: 'override-displaced'; layer: LayerId; incumbent: string; challenger: string }
  | { type: 'override-conflict'; layer: LayerId; incumbent: string; challenger: string }
  | { type: 'override-released'; layer: LayerId; pluginId: string }

/** M13 合并规则的可配置项（数量上限由内核插件配置） */
export interface MergeOptions {
  fewShotLimit?: number
}

/** M15 请求级快照：unmount/换簇只清注册表，不动快照；在途请求用快照跑完 */
export interface HookSnapshot<T = OverrideOutcome> {
  advisories: AdvisoryHookEntry[]
  vetoes: VetoHookEntry[]
  overrideOccupants: Partial<Record<LayerId, OverrideHookEntry<T>>>
}

export class HookRunner<T = OverrideOutcome> {
  private advisories: AdvisoryHookEntry[] = []
  private vetoes: VetoHookEntry[] = []
  private overrideSlots: Partial<Record<LayerId, OverrideHookEntry<T>>> = {}
  private nextSeq = 1
  private onEvent?: (e: HookRunnerEvent) => void

  constructor(onEvent?: (e: HookRunnerEvent) => void) {
    this.onEvent = onEvent
  }

  // ---- 注册（M7 / 注册顺序 seq）----

  registerAdvisory(entry: Omit<AdvisoryHookEntry, 'seq'>): AdvisoryHookEntry {
    const full: AdvisoryHookEntry = { ...entry, seq: this.nextSeq++ }
    this.advisories.push(full)
    return full
  }

  registerVeto(entry: Omit<VetoHookEntry, 'seq'>): VetoHookEntry {
    const full: VetoHookEntry = { ...entry, seq: this.nextSeq++ }
    this.vetoes.push(full)
    return full
  }

  /**
   * M7 覆盖槽消解：槽空 → 入槽；新者 priority 更高 → 替换（原占用者收 displaced 事件）；
   * 相等或更低 → 拒绝注册 + conflict warning。unmount 释放槽 → 不自动晋升。
   */
  registerOverride(entry: Omit<OverrideHookEntry<T>, 'seq'>): { ok: boolean; entry?: OverrideHookEntry<T> } {
    const incumbent = this.overrideSlots[entry.layer]
    if (incumbent) {
      if (entry.priority > incumbent.priority) {
        const full: OverrideHookEntry<T> = { ...entry, seq: this.nextSeq++ }
        this.overrideSlots[entry.layer] = full
        this.onEvent?.({ type: 'override-displaced', layer: entry.layer, incumbent: incumbent.pluginId, challenger: full.pluginId })
        return { ok: true, entry: full }
      }
      this.onEvent?.({ type: 'override-conflict', layer: entry.layer, incumbent: incumbent.pluginId, challenger: entry.pluginId })
      return { ok: false }
    }
    const full: OverrideHookEntry<T> = { ...entry, seq: this.nextSeq++ }
    this.overrideSlots[entry.layer] = full
    return { ok: true, entry: full }
  }

  unregisterPlugin(pluginId: string): void {
    this.advisories = this.advisories.filter(h => h.pluginId !== pluginId)
    this.vetoes = this.vetoes.filter(h => h.pluginId !== pluginId)
    for (const layer of Object.keys(this.overrideSlots) as LayerId[]) {
      const occupant = this.overrideSlots[layer]
      if (occupant && occupant.pluginId === pluginId) {
        delete this.overrideSlots[layer]
        this.onEvent?.({ type: 'override-released', layer, pluginId })
      }
    }
  }

  // ---- 查询与快照（M15）----

  getAdvisories(layer?: LayerId): AdvisoryHookEntry[] {
    const list = layer ? this.advisories.filter(h => h.layer === layer) : this.advisories
    return [...list].sort((a, b) => a.seq - b.seq)
  }

  getVetoes(position?: VetoGatePosition): VetoHookEntry[] {
    const list = position ? this.vetoes.filter(h => h.position === position) : this.vetoes
    return [...list].sort((a, b) => a.seq - b.seq)
  }

  getOverrideOccupant(layer: LayerId): OverrideHookEntry<T> | undefined {
    return this.overrideSlots[layer]
  }

  /** 请求开始时捕获全部钩子引用（M15：生命周期 = 请求生命周期） */
  snapshot(): HookSnapshot<T> {
    return {
      advisories: this.getAdvisories(),
      vetoes: this.getVetoes(),
      overrideOccupants: { ...this.overrideSlots }
    }
  }
}

// ---- M5 步骤 2：顾问执行（单个失败跳过 + warning，继续其余）----

export function runAdvisories(
  hooks: AdvisoryHookEntry[],
  input: string,
  ctx: HookContext
): AdvisoryRunResult {
  const warnings: string[] = []
  const contributions: AdvisoryContribution[] = []
  for (const hook of hooks) {
    if (hook.hasPermission === false) {
      warnings.push(`advisory-skip{pluginId=${hook.pluginId}, layer=${hook.layer}}: permission not declared`)
      continue
    }
    try {
      contributions.push(hook.contribute(input, ctx))
    } catch (err) {
      warnings.push(`advisory-failed{pluginId=${hook.pluginId}, layer=${hook.layer}}: ${(err as Error).message}`)
    }
  }
  const merged = mergeAdvisories(contributions, warnings)
  return { merged, warnings }
}

// ---- M13：顾问贡献确定性合并 ----

export function mergeAdvisories(
  contributions: AdvisoryContribution[],
  warnings: string[] = [],
  opts: MergeOptions = {}
): AdvisoryContribution {
  const fewShotLimit = opts.fewShotLimit
  const merged: AdvisoryContribution = {}

  let scoreDelta = 0
  let hasScore = false
  const candidates: Array<{ id: string; [key: string]: unknown }> = []
  const seenCandidateIds = new Set<string>()
  const keywords: string[] = []
  const seenKeywords = new Set<string>()
  const fewShots: unknown[] = []
  let fewShotsTruncated = false
  const terminology: Record<string, string> = {}
  const seenTermKeys = new Set<string>()
  let exploreTemplate: unknown
  let hasExplore = false

  for (const c of contributions) {
    if (typeof c.scoreDelta === 'number' && Number.isFinite(c.scoreDelta)) {
      scoreDelta += c.scoreDelta
      hasScore = true
    }
    if (Array.isArray(c.candidates)) {
      for (const cand of c.candidates) {
        if (cand && typeof cand === 'object' && typeof (cand as { id: unknown }).id === 'string') {
          const id = (cand as { id: string }).id
          if (seenCandidateIds.has(id)) continue
          seenCandidateIds.add(id)
          candidates.push(cand)
        }
      }
    }
    if (Array.isArray(c.keywords)) {
      for (const kw of c.keywords) {
        if (typeof kw !== 'string' || seenKeywords.has(kw)) continue
        seenKeywords.add(kw)
        keywords.push(kw)
      }
    }
    if (Array.isArray(c.fewShots)) {
      for (const fs of c.fewShots) {
        if (fewShotLimit !== undefined && fewShots.length >= fewShotLimit) {
          fewShotsTruncated = true
          break
        }
        fewShots.push(fs)
      }
    }
    if (c.terminology && typeof c.terminology === 'object') {
      for (const [key, value] of Object.entries(c.terminology)) {
        if (typeof value !== 'string') continue
        if (seenTermKeys.has(key)) {
          warnings.push(`terminology-conflict{key=${key}}: first-registered wins, later override dropped`)
          continue
        }
        seenTermKeys.add(key)
        terminology[key] = value
      }
    }
    if (c.exploreTemplate !== undefined && !hasExplore) {
      exploreTemplate = c.exploreTemplate
      hasExplore = true
    } else if (c.exploreTemplate !== undefined && hasExplore) {
      warnings.push('explore-template-conflict: first-registered wins')
    }
  }

  if (hasScore) merged.scoreDelta = scoreDelta
  if (candidates.length > 0) merged.candidates = candidates
  if (keywords.length > 0) merged.keywords = keywords
  if (fewShots.length > 0) merged.fewShots = fewShots
  if (fewShotsTruncated) warnings.push(`few-shots-truncated: limit=${fewShotLimit}`)
  if (Object.keys(terminology).length > 0) merged.terminology = terminology
  if (hasExplore) merged.exploreTemplate = exploreTemplate
  return merged
}

// ---- M6：否决门（全量评估不短路 / fail-open / 聚合）----

export interface VetoGateOptions {
  /** 严格契约模式（flag，默认关）：钩子抛错 → fail-closed（视作 block） */
  strict?: boolean
}

export function runVetoGate(
  hooks: VetoHookEntry[],
  payload: unknown,
  ctx: HookContext,
  opts: VetoGateOptions = {}
): VetoGateReport {
  const warnings: string[] = []
  const entries: VetoGateReport['entries'] = []
  const humanJudgmentPrompts: string[] = []
  let blocked = false

  for (const hook of hooks) {
    if (hook.hasPermission === false) {
      warnings.push(`veto-skip{pluginId=${hook.pluginId}}: permission not declared`)
      continue
    }
    let result: VetoResult
    try {
      result = hook.check(payload, ctx)
    } catch (err) {
      if (opts.strict) {
        warnings.push(`veto-hook-error{pluginId=${hook.pluginId}}: ${(err as Error).message} (strict: fail-closed)`)
        entries.push({ pluginId: hook.pluginId, severity: 'block', reason: 'strict-mode: veto hook failed' })
        blocked = true
        continue
      }
      warnings.push(`veto-hook-error{pluginId=${hook.pluginId}}: ${(err as Error).message} (fail-open)`)
      continue
    }
    if (!result || typeof result !== 'object') continue
    if (result.veto) {
      const severity = result.severity === 'block' ? 'block' : 'warn'
      if (severity === 'block') blocked = true
      entries.push({ pluginId: hook.pluginId, severity, reason: String(result.reason ?? '') })
      if (result.humanJudgmentPrompt) {
        humanJudgmentPrompts.push(result.humanJudgmentPrompt)
      }
    }
  }

  return { blocked, entries, warnings, humanJudgmentPrompts }
}

// ---- M5 步骤 4：覆盖执行（超时/抛错 → 回退内核默认 + 审计）----

export interface OverrideAuditEvent {
  type: 'override:fallback'
  layer: LayerId
  pluginId: string
  reason: string
}

export interface OverrideRunResult<T> {
  outcome: T
  usedOverride: boolean
  audit?: OverrideAuditEvent
}

const NO_OUTCOME: unique symbol = Symbol('no-outcome')

export async function runOverrideWithFallback<T>(
  occupant: OverrideHookEntry<T> | null | undefined,
  defaultImpl: () => T | Promise<T>,
  input: string,
  merged: AdvisoryContribution | null,
  ctx: HookContext,
  opts: { timeoutMs: number; layer: LayerId }
): Promise<OverrideRunResult<T>> {
  if (!occupant || occupant.hasPermission === false) {
    return { outcome: await defaultImpl(), usedOverride: false }
  }
  try {
    const outcome = await withTimeout(
      Promise.resolve(occupant.impl(input, merged, ctx)),
      opts.timeoutMs
    )
    return { outcome, usedOverride: true }
  } catch (err) {
    const reason = err instanceof TimeoutError ? `timeout after ${opts.timeoutMs}ms` : (err as Error).message
    console.warn(`[hooks] override:fallback{layer=${opts.layer}, pluginId=${occupant.pluginId}}: ${reason}`)
    const outcome = await defaultImpl()
    return {
      outcome,
      usedOverride: false,
      audit: { type: 'override:fallback', layer: opts.layer, pluginId: occupant.pluginId, reason }
    }
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`)
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 簇点位便捷取值：快照中某层的 advisory 钩子（dispatch 内每层调用） */
export function snapshotAdvisoriesForLayer<T>(snapshot: HookSnapshot<T>, layer: HookLayer): AdvisoryHookEntry[] {
  if (layer === 'boundary') return []
  return snapshot.advisories.filter(h => h.layer === layer)
}
