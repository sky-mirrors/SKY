import { ModelTier, type DetectedDomain } from '@/models'
import { estimateTokens } from '@/services/tokenEstimate'
import { checkBudget, clearCostRecords, resetBudget } from '@/services/tokenBudget'
import { debugLog } from '@/services/debugLog'
import { ZeroTokenLearner, DEFAULT_ZOL_CONFIG } from '@/services/zeroTokenLearning'
import type { ZOLAdjustFn, ZOLState } from '@/services/zeroTokenLearning'
import { vault } from '@/vault'

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex'

export interface RouteInput {
  text?: string
  constraintHitCount?: number
  dagStepCount?: number
  taskType?: string
  historicalTokenAvg?: number
  manifestMaxTier?: ModelTier
  cacheHint?: { hit: boolean; tier?: ModelTier }
  domain?: DetectedDomain
  callerId?: string
}

export interface RoutingDecision {
  tier: ModelTier
  complexity: TaskComplexity
  reason: string
  estimatedTokens: number
  estimatedCost: number
  confidence: number
  budgetCapped: boolean
  cacheOptimized: boolean
}

export interface RoutingHistoryEntry {
  id: string
  inputHash: string
  taskType: string
  complexity: TaskComplexity
  selectedTier: ModelTier
  actualTokens: number
  actualCost: number
  qualityScore: number
  overkill: boolean
  timestamp: number
}

export interface AdaptiveThresholds {
  inputLength: { trivial: number; simple: number; moderate: number }
  constraintHits: { trivial: number; simple: number; moderate: number }
  dagSteps: { trivial: number; simple: number; moderate: number }
}

interface FlatRoutingThresholds {
  [key: string]: number
  inputLength_trivial: number
  inputLength_simple: number
  inputLength_moderate: number
  constraintHits_trivial: number
  constraintHits_simple: number
  constraintHits_moderate: number
  dagSteps_trivial: number
  dagSteps_simple: number
  dagSteps_moderate: number
}

const DEFAULT_FLAT: FlatRoutingThresholds = {
  inputLength_trivial: 100,
  inputLength_simple: 500,
  inputLength_moderate: 2000,
  constraintHits_trivial: 0,
  constraintHits_simple: 2,
  constraintHits_moderate: 5,
  dagSteps_trivial: 1,
  dagSteps_simple: 3,
  dagSteps_moderate: 6,
}

const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
  inputLength: { trivial: 100, simple: 500, moderate: 2000 },
  constraintHits: { trivial: 0, simple: 2, moderate: 5 },
  dagSteps: { trivial: 1, simple: 3, moderate: 6 }
}

const COMPLEXITY_TIER_MAP: Record<TaskComplexity, ModelTier> = {
  trivial: 'nano',
  simple: 'mini',
  moderate: 'standard',
  complex: 'pro'
}

const COMPLEXITY_MAX_TOKENS: Record<TaskComplexity, number> = {
  trivial: 512,
  simple: 1024,
  moderate: 4096,
  complex: 8192
}

const TIER_MAX_TOKENS: Record<ModelTier, number> = {
  nano: 512,
  mini: 1024,
  standard: 4096,
  pro: 8192
}

const ADJUST_WINDOW = DEFAULT_ZOL_CONFIG.adjustWindow

const MAX_ROUTING_HISTORY = 500
const ROUTING_HISTORY_KEY = 'holo-routing-history'

const routingAdjustFn: ZOLAdjustFn<FlatRoutingThresholds> = (
  thresholds,
  _successRate,
  _defaults,
  config,
  overkillRate,
) => {
  // G-4 拆分：档位阈值按预算浪费率（overkillRate）驱动，不再把成功执行伪造成
  // failure。触发点与原"successRate<0.7 收紧 / >0.95 放松"完全等价
  //（overkillRate>0.3 ⇔ successRate<0.7；overkillRate<0.05 ⇔ successRate>0.95）
  const step = config.adjustStep
  if (overkillRate > 0.3) {
    for (const key of Object.keys(thresholds) as (keyof FlatRoutingThresholds)[]) {
      thresholds[key] *= (1 + step)
    }
    debugLog(`[smartRouter] ZOL: overkillRate=${(overkillRate * 100).toFixed(0)}% > 30%, tightening thresholds (too many overkills)`)
  } else if (overkillRate < 0.05) {
    for (const key of Object.keys(thresholds) as (keyof FlatRoutingThresholds)[]) {
      thresholds[key] *= (1 - step)
    }
    debugLog(`[smartRouter] ZOL: overkillRate=${(overkillRate * 100).toFixed(0)}% < 5%, loosening thresholds (few overkills, improve quality)`)
  }
}

const routingLearner = new ZeroTokenLearner<FlatRoutingThresholds>({
  decisionPoint: 'routing',
  defaultThresholds: DEFAULT_FLAT,
  adjustFn: routingAdjustFn,
  storageKey: 'holo-zol-routing',
  migrationKeys: [],
})

let routingHistory: RoutingHistoryEntry[] = []
let saveScheduled = false

function textHash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return `h-${Math.abs(h).toString(36)}`
}

function flatToNested(flat: Readonly<FlatRoutingThresholds>): AdaptiveThresholds {
  return {
    inputLength: { trivial: flat.inputLength_trivial, simple: flat.inputLength_simple, moderate: flat.inputLength_moderate },
    constraintHits: { trivial: flat.constraintHits_trivial, simple: flat.constraintHits_simple, moderate: flat.constraintHits_moderate },
    dagSteps: { trivial: flat.dagSteps_trivial, simple: flat.dagSteps_simple, moderate: flat.dagSteps_moderate },
  }
}

const DOMAIN_ROUTING_TIER_BIAS: Record<string, number> = {
  legal: 1,
  finance: 0,
  hr: -1,
}

export { DOMAIN_ROUTING_TIER_BIAS }

export function classifyComplexity(input: {
  text?: string
  constraintHitCount?: number
  dagStepCount?: number
  taskType?: string
  historicalTokenAvg?: number
  domain?: DetectedDomain
}): TaskComplexity {
  const textLen = (input.text || '').length
  const constraintHits = input.constraintHitCount || 0
  const dagSteps = input.dagStepCount || 1
  const histTokens = input.historicalTokenAvg || 0

  let score = 0
  const t = routingLearner.getThresholds()
  if (textLen <= t.inputLength_trivial) score += 0
  else if (textLen <= t.inputLength_simple) score += 1
  else if (textLen <= t.inputLength_moderate) score += 2
  else score += 3

  if (constraintHits <= t.constraintHits_trivial) score += 0
  else if (constraintHits <= t.constraintHits_simple) score += 1
  else if (constraintHits <= t.constraintHits_moderate) score += 2
  else score += 3

  if (dagSteps <= t.dagSteps_trivial) score += 0
  else if (dagSteps <= t.dagSteps_simple) score += 1
  else if (dagSteps <= t.dagSteps_moderate) score += 2
  else score += 3

  if (histTokens > 3000) score += 2
  else if (histTokens > 800) score += 1

  const isCreative = (input.taskType || '').includes('creative') || (input.taskType || '').includes('write')
  if (isCreative) score += 1

  const domainBias = DOMAIN_ROUTING_TIER_BIAS[input.domain || ''] ?? 0
  score += domainBias

  if (score <= 1) return 'trivial'
  if (score <= 3) return 'simple'
  if (score <= 6) return 'moderate'
  return 'complex'
}

export function route(input: RouteInput): RoutingDecision {
  if (input.cacheHint?.hit) {
    const cachedTier = input.cacheHint.tier || 'nano'
    return {
      tier: cachedTier,
      complexity: 'trivial',
      reason: `cache hit, reuse tier=${cachedTier}`,
      estimatedTokens: 0,
      estimatedCost: 0,
      confidence: 1.0,
      budgetCapped: false,
      cacheOptimized: true
    }
  }

  const complexity = classifyComplexity(input)
  let tier = COMPLEXITY_TIER_MAP[complexity]
  const reason: string[] = [`complexity=${complexity}`]
  let budgetCapped = false

  if (input.manifestMaxTier) {
    const TIER_ORDER: ModelTier[] = ['nano', 'mini', 'standard', 'pro']
    const tierIdx = TIER_ORDER.indexOf(tier)
    const maxIdx = TIER_ORDER.indexOf(input.manifestMaxTier)
    if (tierIdx > maxIdx && maxIdx >= 0) {
      tier = input.manifestMaxTier
      reason.push(`capped by manifest=${input.manifestMaxTier}`)
    }
  }

  const estimatedTokens = estimateTokens(input.text || '')
  const budgetCheck = checkBudget(estimatedTokens, tier)
  if (budgetCheck.recommendedTier !== tier) {
    reason.push(`budget capped: ${tier}→${budgetCheck.recommendedTier}`)
    tier = budgetCheck.recommendedTier
    budgetCapped = true
  }

  return {
    tier,
    complexity,
    reason: reason.join(', '),
    estimatedTokens,
    estimatedCost: budgetCheck.estimatedCost,
    confidence: budgetCapped ? 0.6 : 0.9,
    budgetCapped,
    cacheOptimized: false
  }
}

export function recordRoutingOutcome(entry: Omit<RoutingHistoryEntry, 'id' | 'timestamp'>): void {
  const full: RoutingHistoryEntry = {
    id: `rh-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    ...entry,
    timestamp: Date.now()
  }
  routingHistory.push(full)
  if (routingHistory.length > MAX_ROUTING_HISTORY) {
    routingHistory = routingHistory.slice(-MAX_ROUTING_HISTORY)
  }
  routingLearner.recordOutcome(
    entry.selectedTier,
    // G-4：预算浪费与执行成败拆分——overkill 不再伪造 failure 污染成功率口径
    entry.overkill ? 'overkill' : 'success',
    { actualTokens: entry.actualTokens, overkill: entry.overkill ? 1 : 0, qualityScore: entry.qualityScore }
  )
  scheduleSave()
}

export function analyzeRoutingEfficiency(): {
  totalEntries: number
  overkillCount: number
  overkillRate: number
  byComplexity: Record<TaskComplexity, { count: number; overkillCount: number; avgTokens: number }>
} {
  const byComplexity: Record<TaskComplexity, { count: number; overkillCount: number; avgTokens: number }> = {
    trivial: { count: 0, overkillCount: 0, avgTokens: 0 },
    simple: { count: 0, overkillCount: 0, avgTokens: 0 },
    moderate: { count: 0, overkillCount: 0, avgTokens: 0 },
    complex: { count: 0, overkillCount: 0, avgTokens: 0 }
  }
  let totalOverkill = 0
  for (const e of routingHistory) {
    byComplexity[e.complexity].count++
    byComplexity[e.complexity].avgTokens += e.actualTokens
    if (e.overkill) {
      byComplexity[e.complexity].overkillCount++
      totalOverkill++
    }
  }
  for (const c of Object.values(byComplexity)) {
    if (c.count > 0) c.avgTokens = c.avgTokens / c.count
  }
  return {
    totalEntries: routingHistory.length,
    overkillCount: totalOverkill,
    overkillRate: routingHistory.length > 0 ? totalOverkill / routingHistory.length : 0,
    byComplexity
  }
}

export function getRoutingHistory(): RoutingHistoryEntry[] {
  return [...routingHistory]
}

export function clearRoutingHistory(): void {
  routingHistory = []
  scheduleSave()
}

export function detectOverkill(selectedTier: ModelTier, actualTokens: number): boolean {
  const maxForTier = TIER_MAX_TOKENS[selectedTier]
  return actualTokens < maxForTier * 0.2 && selectedTier !== 'nano'
}

export function getMaxTokensForComplexity(complexity: TaskComplexity): number {
  return COMPLEXITY_MAX_TOKENS[complexity]
}

export function getTierForComplexity(complexity: TaskComplexity): ModelTier {
  return COMPLEXITY_TIER_MAP[complexity]
}

export function getAdaptiveThresholds(): AdaptiveThresholds {
  return flatToNested(routingLearner.getThresholds())
}

export function resetAdaptiveThresholds(): void {
  routingLearner.reset()
}

export function getRoutingZOLState(): ZOLState<FlatRoutingThresholds> {
  return routingLearner.getState()
}

export function getHistoricalTokenAvg(taskType?: string): number {
  const relevant = taskType
    ? routingHistory.filter(e => e.taskType === taskType)
    : routingHistory
  if (relevant.length === 0) return 0
  return relevant.reduce((s, e) => s + e.actualTokens, 0) / relevant.length
}

function scheduleSave(): void {
  if (saveScheduled) return
  saveScheduled = true
  setTimeout(() => {
    saveScheduled = false
    saveToStorage()
  }, 1000)
}

function saveToStorage(): void {
  try {
    const toSave = routingHistory.slice(-100)
    vault.writeThrough('routing', ROUTING_HISTORY_KEY, JSON.stringify(toSave))
  } catch (e) {
    debugLog(`[smartRouter] saveToStorage failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function loadRoutingHistory(): void {
  try {
    const histStr = vault.readCache('routing', ROUTING_HISTORY_KEY)
    if (histStr) {
      const parsed = JSON.parse(histStr) as RoutingHistoryEntry[]
      if (Array.isArray(parsed)) {
        const now = Date.now()
        const dayMs = 24 * 60 * 60 * 1000
        routingHistory = parsed.filter(e => e.timestamp && (now - e.timestamp) < 7 * dayMs)
      }
    }
  } catch { /* ignore */ }
}

export async function initSmartRouter(): Promise<void> {
  const histStr = await vault.read('routing', ROUTING_HISTORY_KEY)
  if (histStr) {
    try {
      const parsed = JSON.parse(histStr) as RoutingHistoryEntry[]
      if (Array.isArray(parsed)) {
        const now = Date.now()
        const dayMs = 24 * 60 * 60 * 1000
        routingHistory = parsed.filter(e => e.timestamp && (now - e.timestamp) < 7 * dayMs)
      }
    } catch { /* ignore */ }
  }
  const t = routingLearner.getThresholds()
  const zolState = routingLearner.getState()
  debugLog(`[smartRouter] initialized, history=${routingHistory.length} entries, ZOL thresholds il=${t.inputLength_simple.toFixed(0)}, successRate=${(zolState.recentSuccessRate * 100).toFixed(0)}%`)
}

export { textHash, DEFAULT_THRESHOLDS, ADJUST_WINDOW }
