import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  classifyComplexity,
  route,
  recordRoutingOutcome,
  analyzeRoutingEfficiency,
  getRoutingHistory,
  clearRoutingHistory,
  detectOverkill,
  getMaxTokensForComplexity,
  getTierForComplexity,
  getAdaptiveThresholds,
  resetAdaptiveThresholds,
  getHistoricalTokenAvg,
  initSmartRouter,
  getRoutingZOLState,
  textHash,
  DEFAULT_THRESHOLDS,
  ADJUST_WINDOW
} from '@/services/smartRouter'
import type { TaskComplexity, RouteInput, RoutingDecision } from '@/services/smartRouter'
import type { ModelTier } from '@/models'
import { clearCostRecords, resetBudget } from '@/services/tokenBudget'
import { vault } from '@/vault'

;(globalThis as any).window = {
  electronAPI: {
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
}

describe('smartRouter', () => {
  beforeEach(() => {
    vault.clearCache()
    clearRoutingHistory()
    clearCostRecords()
    resetBudget()
    resetAdaptiveThresholds()
  })

  describe('classifyComplexity', () => {
    it('classifies short input as trivial', () => {
      const result = classifyComplexity({ text: 'hello' })
      expect(result).toBe('trivial')
    })

    it('classifies medium input as simple', () => {
      const result = classifyComplexity({ text: 'a'.repeat(200), dagStepCount: 2 })
      expect(result).toBe('simple')
    })

    it('classifies long input with constraints as moderate', () => {
      const result = classifyComplexity({ text: 'a'.repeat(1000), constraintHitCount: 3, dagStepCount: 4 })
      expect(result).toBe('moderate')
    })

    it('classifies very long input as complex', () => {
      const result = classifyComplexity({ text: 'a'.repeat(3000), constraintHitCount: 6, dagStepCount: 8 })
      expect(result).toBe('complex')
    })

    it('creative task types boost complexity', () => {
      const withoutCreative = classifyComplexity({ text: 'a'.repeat(200), taskType: 'summarize' })
      const withCreative = classifyComplexity({ text: 'a'.repeat(200), taskType: 'creative_write' })
      const tiers: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex']
      expect(tiers.indexOf(withCreative)).toBeGreaterThanOrEqual(tiers.indexOf(withoutCreative))
    })

    it('high historical tokens boost complexity', () => {
      const withoutHist = classifyComplexity({ text: 'short', historicalTokenAvg: 100 })
      const withHist = classifyComplexity({ text: 'short', historicalTokenAvg: 4000 })
      const tiers: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex']
      expect(tiers.indexOf(withHist)).toBeGreaterThanOrEqual(tiers.indexOf(withoutHist))
    })

    it('empty input defaults to trivial', () => {
      expect(classifyComplexity({})).toBe('trivial')
    })

    it('single DAG step with short text is trivial', () => {
      expect(classifyComplexity({ text: 'hi', dagStepCount: 1 })).toBe('trivial')
    })
  })

  describe('route', () => {
    it('trivial complexity maps to nano tier', () => {
      const decision = route({ text: 'hi' })
      expect(decision.tier).toBe('nano')
      expect(decision.complexity).toBe('trivial')
    })

    it('simple complexity maps to mini tier', () => {
      const decision = route({ text: 'a'.repeat(200), dagStepCount: 2 })
      expect(decision.tier).toBe('mini')
    })

    it('moderate complexity maps to standard tier', () => {
      const decision = route({ text: 'a'.repeat(1000), constraintHitCount: 3, dagStepCount: 4 })
      expect(decision.tier).toBe('standard')
    })

    it('complex complexity maps to pro tier', () => {
      const decision = route({ text: 'a'.repeat(3000), constraintHitCount: 6, dagStepCount: 8 })
      expect(decision.tier).toBe('pro')
    })

    it('manifestMaxTier caps the tier', () => {
      const decision = route({ text: 'a'.repeat(3000), constraintHitCount: 6, dagStepCount: 8, manifestMaxTier: 'mini' })
      expect(decision.tier).toBe('mini')
      expect(decision.reason).toContain('manifest')
    })

    it('does not upgrade below manifestMaxTier', () => {
      const decision = route({ text: 'hi', manifestMaxTier: 'pro' })
      expect(decision.tier).toBe('nano')
    })

    it('includes estimatedTokens', () => {
      const decision = route({ text: 'hello world' })
      expect(decision.estimatedTokens).toBeGreaterThan(0)
    })

    it('includes estimatedCost', () => {
      const decision = route({ text: 'hello world' })
      expect(decision.estimatedCost).toBeGreaterThan(0)
    })

    it('includes confidence score', () => {
      const decision = route({ text: 'test' })
      expect(decision.confidence).toBeGreaterThan(0)
      expect(decision.confidence).toBeLessThanOrEqual(1)
    })

    it('reason contains complexity info', () => {
      const decision = route({ text: 'test' })
      expect(decision.reason).toContain('complexity=')
    })

    it('cacheOptimized is false for non-cache routes', () => {
      const decision = route({ text: 'test' })
      expect(decision.cacheOptimized).toBe(false)
    })
  })

  describe('route with cacheHint', () => {
    it('returns cached tier when cacheHit is true with tier', () => {
      const decision = route({ text: 'test', cacheHint: { hit: true, tier: 'mini' } })
      expect(decision.tier).toBe('mini')
      expect(decision.complexity).toBe('trivial')
      expect(decision.cacheOptimized).toBe(true)
      expect(decision.estimatedTokens).toBe(0)
      expect(decision.estimatedCost).toBe(0)
      expect(decision.confidence).toBe(1.0)
    })

    it('returns nano when cacheHit is true without tier', () => {
      const decision = route({ text: 'test', cacheHint: { hit: true } })
      expect(decision.tier).toBe('nano')
      expect(decision.cacheOptimized).toBe(true)
    })

    it('cacheHint hit=false falls through to normal routing', () => {
      const decision = route({ text: 'hi', cacheHint: { hit: false } })
      expect(decision.cacheOptimized).toBe(false)
      expect(decision.tier).toBe('nano')
    })

    it('cache hit reason includes cache info', () => {
      const decision = route({ text: 'test', cacheHint: { hit: true, tier: 'standard' } })
      expect(decision.reason).toContain('cache hit')
    })
  })

  describe('recordRoutingOutcome / analyzeRoutingEfficiency', () => {
    it('records routing history', () => {
      recordRoutingOutcome({
        inputHash: 'hash1',
        taskType: 'chat',
        complexity: 'simple',
        selectedTier: 'mini',
        actualTokens: 500,
        actualCost: 0.01,
        qualityScore: 4,
        overkill: false
      })
      const history = getRoutingHistory()
      expect(history.length).toBe(1)
      expect(history[0].taskType).toBe('chat')
    })

    it('analyzes routing efficiency', () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'simple',
        selectedTier: 'pro', actualTokens: 100, actualCost: 0.01, qualityScore: 5, overkill: true
      })
      recordRoutingOutcome({
        inputHash: 'h2', taskType: 'chat', complexity: 'moderate',
        selectedTier: 'standard', actualTokens: 2000, actualCost: 0.02, qualityScore: 4, overkill: false
      })
      const efficiency = analyzeRoutingEfficiency()
      expect(efficiency.totalEntries).toBe(2)
      expect(efficiency.overkillCount).toBe(1)
      expect(efficiency.overkillRate).toBeCloseTo(0.5, 2)
      expect(efficiency.byComplexity.simple.overkillCount).toBe(1)
      expect(efficiency.byComplexity.moderate.count).toBe(1)
    })

    it('handles empty history', () => {
      const efficiency = analyzeRoutingEfficiency()
      expect(efficiency.totalEntries).toBe(0)
      expect(efficiency.overkillRate).toBe(0)
    })

    it('trims history to MAX_ROUTING_HISTORY', () => {
      for (let i = 0; i < 510; i++) {
        recordRoutingOutcome({
          inputHash: `h${i}`, taskType: 'chat', complexity: 'trivial',
          selectedTier: 'nano', actualTokens: 50, actualCost: 0.001, qualityScore: 3, overkill: false
        })
      }
      const history = getRoutingHistory()
      expect(history.length).toBeLessThanOrEqual(500)
    })
  })

  describe('detectOverkill', () => {
    it('pro tier with 100 tokens is overkill', () => {
      expect(detectOverkill('pro', 100)).toBe(true)
    })

    it('nano tier is never overkill', () => {
      expect(detectOverkill('nano', 10)).toBe(false)
    })

    it('standard tier with 2000 tokens is not overkill', () => {
      expect(detectOverkill('standard', 2000)).toBe(false)
    })

    it('mini tier with 50 tokens is overkill', () => {
      expect(detectOverkill('mini', 50)).toBe(true)
    })

    it('standard tier with exactly 20% tokens is overkill', () => {
      expect(detectOverkill('standard', 819)).toBe(true)
    })

    it('standard tier with 21% tokens is not overkill', () => {
      expect(detectOverkill('standard', 860)).toBe(false)
    })
  })

  describe('getMaxTokensForComplexity', () => {
    it('returns correct max tokens', () => {
      expect(getMaxTokensForComplexity('trivial')).toBe(512)
      expect(getMaxTokensForComplexity('simple')).toBe(1024)
      expect(getMaxTokensForComplexity('moderate')).toBe(4096)
      expect(getMaxTokensForComplexity('complex')).toBe(8192)
    })
  })

  describe('getTierForComplexity', () => {
    it('maps complexity to tier', () => {
      expect(getTierForComplexity('trivial')).toBe('nano')
      expect(getTierForComplexity('simple')).toBe('mini')
      expect(getTierForComplexity('moderate')).toBe('standard')
      expect(getTierForComplexity('complex')).toBe('pro')
    })
  })

  describe('clearRoutingHistory', () => {
    it('clears history', () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 50, actualCost: 0.001, qualityScore: 5, overkill: false
      })
      clearRoutingHistory()
      expect(getRoutingHistory().length).toBe(0)
    })
  })

  describe('adaptive thresholds', () => {
    it('starts with default thresholds', () => {
      const thresholds = getAdaptiveThresholds()
      expect(thresholds.inputLength.trivial).toBe(DEFAULT_THRESHOLDS.inputLength.trivial)
      expect(thresholds.inputLength.simple).toBe(DEFAULT_THRESHOLDS.inputLength.simple)
    })

    it('tightens thresholds when overkill rate > 30%', () => {
      const before = getAdaptiveThresholds().inputLength.simple
      for (let i = 0; i < ADJUST_WINDOW; i++) {
        recordRoutingOutcome({
          inputHash: `h${i}`, taskType: 'chat', complexity: 'moderate',
          selectedTier: 'pro', actualTokens: 50, actualCost: 0.01, qualityScore: 5, overkill: true
        })
      }
      const after = getAdaptiveThresholds().inputLength.simple
      expect(after).toBeGreaterThan(before)
    })

    it('loosens thresholds when almost no overkills', () => {
      for (let i = 0; i < ADJUST_WINDOW; i++) {
        recordRoutingOutcome({
          inputHash: `h${i}`, taskType: 'chat', complexity: 'simple',
          selectedTier: 'mini', actualTokens: 900, actualCost: 0.01, qualityScore: 2, overkill: false
        })
      }
      const after = getAdaptiveThresholds().inputLength.simple
      expect(after).toBeLessThan(DEFAULT_THRESHOLDS.inputLength.simple)
    })

    it('does not adjust when overkill rate is moderate', () => {
      const before = getAdaptiveThresholds().inputLength.simple
      for (let i = 0; i < ADJUST_WINDOW; i++) {
        recordRoutingOutcome({
          inputHash: `h${i}`, taskType: 'chat', complexity: 'simple',
          selectedTier: 'mini', actualTokens: 500, actualCost: 0.01, qualityScore: 4, overkill: i % 5 === 0
        })
      }
      const after = getAdaptiveThresholds().inputLength.simple
      expect(after).toBe(before)
    })

    it('clamps thresholds to ±30% of defaults', () => {
      resetAdaptiveThresholds()
      for (let round = 0; round < 50; round++) {
        for (let i = 0; i < ADJUST_WINDOW; i++) {
          recordRoutingOutcome({
            inputHash: `r${round}h${i}`, taskType: 'chat', complexity: 'moderate',
            selectedTier: 'pro', actualTokens: 10, actualCost: 0.01, qualityScore: 5, overkill: true
          })
        }
      }
      const thresholds = getAdaptiveThresholds()
      const maxAllowed = DEFAULT_THRESHOLDS.inputLength.simple * 1.30
      expect(thresholds.inputLength.simple).toBeLessThanOrEqual(maxAllowed + 1)
    })

    it('resetAdaptiveThresholds restores defaults', () => {
      for (let i = 0; i < ADJUST_WINDOW; i++) {
        recordRoutingOutcome({
          inputHash: `h${i}`, taskType: 'chat', complexity: 'moderate',
          selectedTier: 'pro', actualTokens: 50, actualCost: 0.01, qualityScore: 5, overkill: true
        })
      }
      resetAdaptiveThresholds()
      const thresholds = getAdaptiveThresholds()
      expect(thresholds.inputLength.simple).toBe(DEFAULT_THRESHOLDS.inputLength.simple)
    })

    it('getRoutingZOLState exposes ZOL learner state', () => {
      const state = getRoutingZOLState()
      expect(state.outcomeCount).toBe(0)
      expect(state.recentSuccessRate).toBe(0.5)
      expect(state.thresholds.inputLength_simple).toBe(DEFAULT_THRESHOLDS.inputLength.simple)
    })

    it('getRoutingZOLState tracks outcomes', () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'simple',
        selectedTier: 'mini', actualTokens: 500, actualCost: 0.01, qualityScore: 4, overkill: false
      })
      const state = getRoutingZOLState()
      expect(state.outcomeCount).toBe(1)
    })
  })

  describe('cache-aware routing', () => {
    it('cacheHint hit with tier returns that tier directly', () => {
      const decision = route({ text: 'complex query', cacheHint: { hit: true, tier: 'standard' } })
      expect(decision.tier).toBe('standard')
      expect(decision.estimatedCost).toBe(0)
      expect(decision.cacheOptimized).toBe(true)
    })

    it('cacheHint hit without tier defaults to nano', () => {
      const decision = route({ text: 'complex query', cacheHint: { hit: true } })
      expect(decision.tier).toBe('nano')
    })

    it('cacheHint miss routes normally', () => {
      const without = route({ text: 'hi' })
      const withMiss = route({ text: 'hi', cacheHint: { hit: false } })
      expect(withMiss.tier).toBe(without.tier)
      expect(withMiss.cacheOptimized).toBe(false)
    })
  })

  describe('persistence', () => {
    it('initSmartRouter loads routing history from vault', async () => {
      const historyData = [{
        id: 'rh-1', inputHash: 'test', taskType: 'chat', complexity: 'simple' as TaskComplexity,
        selectedTier: 'mini' as const, actualTokens: 500, actualCost: 0.01,
        qualityScore: 4, overkill: false, timestamp: Date.now()
      }]
      vault.writeCache('routing', 'holo-routing-history', JSON.stringify(historyData))

      clearRoutingHistory()
      await initSmartRouter()

      const history = getRoutingHistory()
      expect(history.length).toBe(1)
      expect(history[0].taskType).toBe('chat')
    })

    it('initSmartRouter filters out entries older than 7 days', async () => {
      const oldEntry = {
        id: 'rh-old', inputHash: 'old', taskType: 'chat', complexity: 'simple' as TaskComplexity,
        selectedTier: 'mini' as const, actualTokens: 500, actualCost: 0.01,
        qualityScore: 4, overkill: false, timestamp: Date.now() - 8 * 24 * 60 * 60 * 1000
      }
      const freshEntry = {
        id: 'rh-fresh', inputHash: 'fresh', taskType: 'chat', complexity: 'trivial' as TaskComplexity,
        selectedTier: 'nano' as const, actualTokens: 50, actualCost: 0.001,
        qualityScore: 5, overkill: false, timestamp: Date.now()
      }
      vault.writeCache('routing', 'holo-routing-history', JSON.stringify([oldEntry, freshEntry]))
      clearRoutingHistory()
      await initSmartRouter()

      const history = getRoutingHistory()
      expect(history.length).toBe(1)
      expect(history[0].inputHash).toBe('fresh')
    })

    it('recordRoutingOutcome schedules save via scheduleSave', async () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 50, actualCost: 0.001, qualityScore: 3, overkill: false
      })
      await new Promise(r => setTimeout(r, 1100))
      const saved = vault.readCache('routing', 'holo-routing-history')
      expect(saved).not.toBeNull()
      const parsed = JSON.parse(saved!)
      expect(parsed.length).toBe(1)
    })
  })

  describe('getHistoricalTokenAvg', () => {
    it('returns 0 for no history', () => {
      expect(getHistoricalTokenAvg()).toBe(0)
    })

    it('returns average across all task types when no filter', () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 100, actualCost: 0.001, qualityScore: 3, overkill: false
      })
      recordRoutingOutcome({
        inputHash: 'h2', taskType: 'summarize', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 200, actualCost: 0.001, qualityScore: 3, overkill: false
      })
      expect(getHistoricalTokenAvg()).toBe(150)
    })

    it('filters by taskType', () => {
      recordRoutingOutcome({
        inputHash: 'h1', taskType: 'chat', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 100, actualCost: 0.001, qualityScore: 3, overkill: false
      })
      recordRoutingOutcome({
        inputHash: 'h2', taskType: 'summarize', complexity: 'trivial',
        selectedTier: 'nano', actualTokens: 200, actualCost: 0.001, qualityScore: 3, overkill: false
      })
      expect(getHistoricalTokenAvg('chat')).toBe(100)
      expect(getHistoricalTokenAvg('summarize')).toBe(200)
    })
  })

  describe('textHash', () => {
    it('returns consistent hash for same input', () => {
      expect(textHash('hello')).toBe(textHash('hello'))
    })

    it('returns different hash for different input', () => {
      expect(textHash('hello')).not.toBe(textHash('world'))
    })

    it('returns string starting with h-', () => {
      expect(textHash('test')).toMatch(/^h-/)
    })
  })

  describe('domain and callerId in route', () => {
    it('legal domain boosts complexity by +1 score', () => {
      const withLegal = classifyComplexity({ text: 'hi', domain: 'legal' })
      const without = classifyComplexity({ text: 'hi' })
      const tiers: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex']
      expect(tiers.indexOf(withLegal)).toBeGreaterThanOrEqual(tiers.indexOf(without))
    })

    it('hr domain reduces complexity by -1 score', () => {
      const withHr = classifyComplexity({ text: 'a'.repeat(200), domain: 'hr' })
      const without = classifyComplexity({ text: 'a'.repeat(200) })
      const tiers: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex']
      expect(tiers.indexOf(withHr)).toBeLessThanOrEqual(tiers.indexOf(without))
    })

    it('finance domain does not change complexity (bias=0)', () => {
      const withFinance = classifyComplexity({ text: 'hi', domain: 'finance' })
      const without = classifyComplexity({ text: 'hi' })
      expect(withFinance).toBe(without)
    })

    it('legal domain can push trivial to simple', () => {
      const withoutDomain = classifyComplexity({ text: 'a'.repeat(150) })
      const withLegal = classifyComplexity({ text: 'a'.repeat(150), domain: 'legal' })
      const tiers: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex']
      expect(tiers.indexOf(withLegal)).toBeGreaterThan(tiers.indexOf(withoutDomain))
    })

    it('hr domain can push simple to trivial', () => {
      const result = classifyComplexity({ text: 'short', domain: 'hr' })
      expect(result).toBe('trivial')
    })

    it('accepts callerId without affecting routing', () => {
      const withCaller = route({ text: 'hi', callerId: 'test' })
      const withoutCaller = route({ text: 'hi' })
      expect(withCaller.tier).toBe(withoutCaller.tier)
    })

    it('accepts taskType creative_write to boost complexity', () => {
      const normal = route({ text: 'a'.repeat(200), taskType: 'summarize' })
      const creative = route({ text: 'a'.repeat(200), taskType: 'creative_write' })
      const tiers: ModelTier[] = ['nano', 'mini', 'standard', 'pro']
      expect(tiers.indexOf(creative.tier)).toBeGreaterThanOrEqual(tiers.indexOf(normal.tier))
    })
  })
})
