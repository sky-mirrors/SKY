import { TokenBudget, BudgetStatus, BudgetPeriodStatus, ModelTier, OverBudgetStrategy, DEFAULT_TOKEN_BUDGET, CostRecord, BudgetMode, TierWhitelist, BUDGET_MODE_TIERS, DEFAULT_TIER_WHITELIST } from '@/models'
import { estimateStepCost, calculateCost } from '@/services/tokenPricing'
import { vault } from '@/vault'

const BUDGET_STORAGE_KEY = 'holo-token-budget'
const COST_RECORDS_KEY = 'holo-cost-records'
const MAX_COST_RECORDS = 1000

let currentBudget: TokenBudget = { ...DEFAULT_TOKEN_BUDGET }
let sessionSpent = 0
let costRecords: CostRecord[] = []

const MODE_TIER_WHITELIST: Record<BudgetMode, TierWhitelist> = {
  zero:     { nano: true, mini: false, standard: false, pro: false },
  economy:  { nano: true, mini: true,  standard: false, pro: false },
  standard: { nano: true, mini: true,  standard: true,  pro: true  },
}

function getTodayStart(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function getMonthStart(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function calculateDailySpent(): number {
  const todayStart = getTodayStart()
  return costRecords.filter(r => r.timestamp >= todayStart).reduce((sum, r) => sum + r.totalCost, 0)
}

function calculateMonthlySpent(): number {
  const monthStart = getMonthStart()
  return costRecords.filter(r => r.timestamp >= monthStart).reduce((sum, r) => sum + r.totalCost, 0)
}

function getPeriodStatus(spent: number, budget: number, warnThreshold: number): BudgetPeriodStatus {
  const percent = budget > 0 ? spent / budget : 0
  const overBudget = spent >= budget
  let warnLevel: BudgetPeriodStatus['warnLevel'] = 'ok'
  if (overBudget) warnLevel = 'exceeded'
  else if (percent >= 0.95) warnLevel = 'critical'
  else if (percent >= warnThreshold) warnLevel = 'warning'
  return { spent, budget, percent, overBudget, warnLevel }
}

export function getBudget(): TokenBudget {
  return { ...currentBudget }
}

export function setBudget(budget: Partial<TokenBudget>): void {
  currentBudget = { ...currentBudget, ...budget }
  saveBudgetToStorage()
}

export function resetBudget(): void {
  currentBudget = { ...DEFAULT_TOKEN_BUDGET, tierWhitelist: { ...DEFAULT_TIER_WHITELIST } }
  saveBudgetToStorage()
}

export function getBudgetMode(): BudgetMode {
  return currentBudget.budgetMode
}

export function setBudgetMode(mode: BudgetMode): void {
  currentBudget.budgetMode = mode
  currentBudget.tierWhitelist = { ...MODE_TIER_WHITELIST[mode] }
  saveBudgetToStorage()
}

export function getTierWhitelist(): TierWhitelist {
  return { ...currentBudget.tierWhitelist }
}

export function setTierWhitelist(whitelist: Partial<TierWhitelist>): void {
  currentBudget.tierWhitelist = { ...currentBudget.tierWhitelist, ...whitelist }
  saveBudgetToStorage()
}

export function getBudgetStatus(): BudgetStatus {
  const dailySpent = calculateDailySpent()
  const monthlySpent = calculateMonthlySpent()
  const daily = getPeriodStatus(dailySpent + sessionSpent, currentBudget.dailyBudgetCny, currentBudget.warnThreshold)
  const session = getPeriodStatus(sessionSpent, currentBudget.sessionBudgetCny, currentBudget.warnThreshold)
  const monthly = getPeriodStatus(monthlySpent + sessionSpent, currentBudget.monthlyBudgetCny, currentBudget.warnThreshold)
  const recommendedTier = getRecommendedTier(daily, session, monthly)
  return {
    daily,
    session,
    monthly,
    recommendedTier,
    strategy: currentBudget.overBudgetStrategy
  }
}

export function getRecommendedTier(
  daily: BudgetPeriodStatus,
  session: BudgetPeriodStatus,
  monthly: BudgetPeriodStatus
): ModelTier {
  const worstLevel = [daily, session, monthly].reduce((worst, s) => {
    const levels: BudgetPeriodStatus['warnLevel'][] = ['ok', 'warning', 'critical', 'exceeded']
    return levels.indexOf(s.warnLevel) > levels.indexOf(worst) ? s.warnLevel : worst
  }, 'ok' as BudgetPeriodStatus['warnLevel'])

  if (worstLevel === 'exceeded') return 'nano'
  if (worstLevel === 'critical') return 'mini'
  if (worstLevel === 'warning') return 'standard'
  return 'pro'
}

export interface BudgetCheckResult {
  allowed: boolean
  recommendedTier: ModelTier
  reason: string
  estimatedCost: number
  budgetStatus: BudgetStatus
}

export function checkBudget(
  estimatedInputTokens: number,
  requestedTier: ModelTier
): BudgetCheckResult {
  const status = getBudgetStatus()
  const estimatedCost = estimateStepCost(requestedTier, estimatedInputTokens)

  const { recommendedTier, strategy } = status

  const whitelist = currentBudget.tierWhitelist
  if (!whitelist[requestedTier]) {
    const downgraded = findWhitelistedTier(requestedTier, whitelist)
    return {
      allowed: true,
      recommendedTier: downgraded,
      reason: `Tier ${requestedTier} blocked by budget mode (${currentBudget.budgetMode}), downgraded to ${downgraded}`,
      estimatedCost: estimateStepCost(downgraded, estimatedInputTokens),
      budgetStatus: status
    }
  }

  if (status.daily.overBudget || status.session.overBudget || status.monthly.overBudget) {
    if (strategy === 'block') {
      return {
        allowed: false,
        recommendedTier: 'nano',
        reason: 'Budget exceeded (block strategy)',
        estimatedCost,
        budgetStatus: status
      }
    }
    if (strategy === 'warn') {
      return {
        allowed: true,
        recommendedTier: requestedTier,
        reason: 'Budget exceeded (warn strategy)',
        estimatedCost,
        budgetStatus: status
      }
    }
    if (strategy === 'degrade') {
      const effectiveTier = downgradeTier(requestedTier, recommendedTier)
      return {
        allowed: true,
        recommendedTier: effectiveTier,
        reason: `Budget exceeded, degraded from ${requestedTier} to ${effectiveTier}`,
        estimatedCost: estimateStepCost(effectiveTier, estimatedInputTokens),
        budgetStatus: status
      }
    }
  }

  if (strategy === 'degrade' && requestedTier !== downgradeTier(requestedTier, recommendedTier)) {
    const effectiveTier = downgradeTier(requestedTier, recommendedTier)
    if (effectiveTier !== requestedTier) {
      return {
        allowed: true,
        recommendedTier: effectiveTier,
        reason: `Budget warning, capped at ${effectiveTier}`,
        estimatedCost: estimateStepCost(effectiveTier, estimatedInputTokens),
        budgetStatus: status
      }
    }
  }

  return {
    allowed: true,
    recommendedTier: requestedTier,
    reason: 'Within budget',
    estimatedCost,
    budgetStatus: status
  }
}

function findWhitelistedTier(requested: ModelTier, whitelist: TierWhitelist): ModelTier {
  const idx = TIER_ORDER.indexOf(requested)
  for (let i = idx; i < TIER_ORDER.length; i++) {
    if (whitelist[TIER_ORDER[i]]) return TIER_ORDER[i]
  }
  return 'nano'
}

const TIER_ORDER: ModelTier[] = ['pro', 'standard', 'mini', 'nano']

export function downgradeTier(requested: ModelTier, maxAllowed: ModelTier): ModelTier {
  const requestedIdx = TIER_ORDER.indexOf(requested)
  const maxIdx = TIER_ORDER.indexOf(maxAllowed)
  if (requestedIdx < 0 || maxIdx < 0) return requested
  return TIER_ORDER[Math.max(requestedIdx, maxIdx)]
}

export function recordCost(record: Omit<CostRecord, 'id' | 'timestamp'>): CostRecord {
  const entry: CostRecord = {
    id: `cost-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    ...record,
    timestamp: Date.now()
  }
  costRecords.push(entry)
  sessionSpent += record.totalCost
  if (costRecords.length > MAX_COST_RECORDS) {
    costRecords = costRecords.slice(-MAX_COST_RECORDS)
  }
  saveCostRecordsToStorage()
  return entry
}

export function recordLlmCost(
  tier: ModelTier,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number,
  category: string,
  local?: boolean
): CostRecord {
  // M17/M20：本地 Ollama 调用零费用——token 照记（口径不变），费用记 0
  const cost = local
    ? { inputCost: 0, outputCost: 0, cacheSaving: 0, totalCost: 0 }
    : calculateCost(promptTokens, completionTokens, cacheHitTokens)
  return recordCost({
    tier,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    cacheHitTokens,
    inputCost: cost.inputCost,
    outputCost: cost.outputCost,
    cacheSaving: cost.cacheSaving,
    totalCost: cost.totalCost,
    category
  })
}

export function getSessionSpent(): number {
  return sessionSpent
}

export function getDailySpent(): number {
  return calculateDailySpent() + sessionSpent
}

export function getMonthlySpent(): number {
  return calculateMonthlySpent() + sessionSpent
}

export function getCostRecords(since?: number): CostRecord[] {
  if (since) return costRecords.filter(r => r.timestamp >= since)
  return [...costRecords]
}

export function resetSessionSpent(): void {
  sessionSpent = 0
}

export function clearCostRecords(): void {
  costRecords = []
  sessionSpent = 0
  saveCostRecordsToStorage()
}

function saveBudgetToStorage(): void {
  try {
    vault.writeThrough('budget', BUDGET_STORAGE_KEY, JSON.stringify(currentBudget))
  } catch { /* non-critical */ }
}

function loadBudgetFromStorage(): void {
  try {
    const raw = vault.readCache('budget', BUDGET_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TokenBudget>
      currentBudget = {
        ...DEFAULT_TOKEN_BUDGET,
        ...parsed,
        tierWhitelist: { ...DEFAULT_TIER_WHITELIST, ...(parsed.tierWhitelist || {}) },
      }
    }
  } catch { /* non-critical */ }
}

function saveCostRecordsToStorage(): void {
  try {
    vault.writeThrough('budget', COST_RECORDS_KEY, JSON.stringify(costRecords.slice(-MAX_COST_RECORDS)))
  } catch { /* non-critical */ }
}

function loadCostRecordsFromStorage(): void {
  try {
    const raw = vault.readCache('budget', COST_RECORDS_KEY)
    if (raw) {
      costRecords = JSON.parse(raw) as CostRecord[]
    }
  } catch { /* non-critical */ }
}

export async function initBudgetSystem(): Promise<void> {
  const budgetRaw = await vault.read('budget', BUDGET_STORAGE_KEY)
  if (budgetRaw) {
    try {
      const parsed = JSON.parse(budgetRaw) as Partial<TokenBudget>
      currentBudget = {
        ...DEFAULT_TOKEN_BUDGET,
        ...parsed,
        tierWhitelist: { ...DEFAULT_TIER_WHITELIST, ...(parsed.tierWhitelist || {}) },
      }
    } catch { /* non-critical */ }
  }

  const costRaw = await vault.read('budget', COST_RECORDS_KEY)
  if (costRaw) {
    try {
      costRecords = JSON.parse(costRaw) as CostRecord[]
    } catch { /* non-critical */ }
  }
}

export function getCostBreakdownByTier(): Record<string, { cost: number; callCount: number; totalTokens: number }> {
  const result: Record<string, { cost: number; callCount: number; totalTokens: number }> = {}
  for (const r of costRecords) {
    if (!result[r.tier]) {
      result[r.tier] = { cost: 0, callCount: 0, totalTokens: 0 }
    }
    result[r.tier].cost += r.totalCost
    result[r.tier].callCount += 1
    result[r.tier].totalTokens += r.inputTokens + r.outputTokens
  }
  return result
}

export function getCostBreakdownByCategory(): Record<string, { cost: number; callCount: number }> {
  const result: Record<string, { cost: number; callCount: number }> = {}
  for (const r of costRecords) {
    if (!result[r.category]) {
      result[r.category] = { cost: 0, callCount: 0 }
    }
    result[r.category].cost += r.totalCost
    result[r.category].callCount += 1
  }
  return result
}
