import { describe, it, expect, beforeEach } from 'vitest'
import {
  getBudget,
  setBudget,
  resetBudget,
  getBudgetStatus,
  getRecommendedTier,
  checkBudget,
  downgradeTier,
  recordCost,
  recordLlmCost,
  getSessionSpent,
  getCostRecords,
  resetSessionSpent,
  clearCostRecords,
  initBudgetSystem,
  getCostBreakdownByTier,
  getCostBreakdownByCategory,
  getBudgetMode,
  setBudgetMode,
  getTierWhitelist,
  setTierWhitelist
} from '@/services/tokenBudget'
import { DEFAULT_TOKEN_BUDGET, DEFAULT_TIER_WHITELIST } from '@/models'

describe('tokenBudget', () => {
  beforeEach(() => {
    clearCostRecords()
    resetBudget()
  })

  describe('getBudget / setBudget', () => {
    it('returns default budget', () => {
      const budget = getBudget()
      expect(budget.dailyBudgetCny).toBe(DEFAULT_TOKEN_BUDGET.dailyBudgetCny)
      expect(budget.sessionBudgetCny).toBe(DEFAULT_TOKEN_BUDGET.sessionBudgetCny)
      expect(budget.monthlyBudgetCny).toBe(DEFAULT_TOKEN_BUDGET.monthlyBudgetCny)
      expect(budget.overBudgetStrategy).toBe('degrade')
    })

    it('updates partial budget', () => {
      setBudget({ dailyBudgetCny: 20, overBudgetStrategy: 'block' })
      const budget = getBudget()
      expect(budget.dailyBudgetCny).toBe(20)
      expect(budget.overBudgetStrategy).toBe('block')
      expect(budget.sessionBudgetCny).toBe(DEFAULT_TOKEN_BUDGET.sessionBudgetCny)
    })

    it('resetBudget restores defaults', () => {
      setBudget({ dailyBudgetCny: 999 })
      resetBudget()
      const budget = getBudget()
      expect(budget.dailyBudgetCny).toBe(DEFAULT_TOKEN_BUDGET.dailyBudgetCny)
    })
  })

  describe('getBudgetStatus', () => {
    it('returns ok status when no spend', () => {
      const status = getBudgetStatus()
      expect(status.daily.warnLevel).toBe('ok')
      expect(status.session.warnLevel).toBe('ok')
      expect(status.monthly.warnLevel).toBe('ok')
      expect(status.recommendedTier).toBe('pro')
    })

    it('returns warning when approaching threshold', () => {
      setBudget({ sessionBudgetCny: 0.1, warnThreshold: 0.8 })
      recordCost({
        tier: 'standard',
        inputTokens: 100, outputTokens: 100, cacheHitTokens: 0,
        inputCost: 0.08, outputCost: 0.002, cacheSaving: 0, totalCost: 0.082, category: 'test'
      })
      const status = getBudgetStatus()
      expect(status.session.warnLevel).toBe('warning')
      expect(status.recommendedTier).toBe('standard')
    })

    it('returns exceeded when budget exhausted', () => {
      setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'degrade' })
      recordCost({
        tier: 'pro',
        inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0,
        inputCost: 0.05, outputCost: 0.035, cacheSaving: 0, totalCost: 0.085, category: 'test'
      })
      const status = getBudgetStatus()
      expect(status.session.warnLevel).toBe('exceeded')
      expect(status.recommendedTier).toBe('nano')
    })
  })

  describe('getRecommendedTier', () => {
    it('returns pro when all ok', () => {
      const ok = { spent: 0, budget: 10, percent: 0, overBudget: false, warnLevel: 'ok' as const }
      expect(getRecommendedTier(ok, ok, ok)).toBe('pro')
    })

    it('returns standard when warning', () => {
      const warn = { spent: 8, budget: 10, percent: 0.8, overBudget: false, warnLevel: 'warning' as const }
      const ok = { spent: 0, budget: 10, percent: 0, overBudget: false, warnLevel: 'ok' as const }
      expect(getRecommendedTier(warn, ok, ok)).toBe('standard')
    })

    it('returns nano when exceeded', () => {
      const exceeded = { spent: 11, budget: 10, percent: 1.1, overBudget: true, warnLevel: 'exceeded' as const }
      const ok = { spent: 0, budget: 10, percent: 0, overBudget: false, warnLevel: 'ok' as const }
      expect(getRecommendedTier(exceeded, ok, ok)).toBe('nano')
    })

    it('takes worst across all periods', () => {
      const ok = { spent: 0, budget: 10, percent: 0, overBudget: false, warnLevel: 'ok' as const }
      const critical = { spent: 9.5, budget: 10, percent: 0.95, overBudget: false, warnLevel: 'critical' as const }
      expect(getRecommendedTier(ok, critical, ok)).toBe('mini')
    })
  })

  describe('downgradeTier', () => {
    it('keeps tier if within allowed', () => {
      expect(downgradeTier('nano', 'pro')).toBe('nano')
      expect(downgradeTier('standard', 'pro')).toBe('standard')
    })

    it('downgrades when max is lower', () => {
      expect(downgradeTier('pro', 'mini')).toBe('mini')
      expect(downgradeTier('standard', 'nano')).toBe('nano')
    })

    it('same tier stays same', () => {
      expect(downgradeTier('mini', 'mini')).toBe('mini')
    })
  })

  describe('checkBudget', () => {
    it('allows request within budget', () => {
      const result = checkBudget(1000, 'pro')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('pro')
    })

    it('degrades when budget exceeded with degrade strategy', () => {
      setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'degrade' })
      recordCost({
        tier: 'pro',
        inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0,
        inputCost: 0.05, outputCost: 0.035, cacheSaving: 0, totalCost: 0.085, category: 'test'
      })
      const result = checkBudget(1000, 'pro')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).not.toBe('pro')
    })

    it('blocks when budget exceeded with block strategy', () => {
      setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'block' })
      recordCost({
        tier: 'pro',
        inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0,
        inputCost: 0.05, outputCost: 0.035, cacheSaving: 0, totalCost: 0.085, category: 'test'
      })
      const result = checkBudget(1000, 'pro')
      expect(result.allowed).toBe(false)
    })

    it('warns but allows with warn strategy', () => {
      setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'warn' })
      recordCost({
        tier: 'pro',
        inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0,
        inputCost: 0.05, outputCost: 0.035, cacheSaving: 0, totalCost: 0.085, category: 'test'
      })
      const result = checkBudget(1000, 'pro')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('pro')
    })

    it('includes estimated cost', () => {
      const result = checkBudget(1000, 'pro')
      expect(result.estimatedCost).toBeGreaterThan(0)
    })
  })

  describe('recordCost / recordLlmCost', () => {
    it('records a cost entry', () => {
      recordCost({
        tier: 'standard',
        inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0,
        inputCost: 0.005, outputCost: 0.0075, cacheSaving: 0, totalCost: 0.0125, category: 'llm'
      })
      expect(getSessionSpent()).toBeCloseTo(0.0125, 4)
      const records = getCostRecords()
      expect(records.length).toBe(1)
      expect(records[0].tier).toBe('standard')
    })

    it('recordLlmCost calculates cost automatically', () => {
      const entry = recordLlmCost('pro', 1000, 500, 0, 'chat')
      expect(entry.inputCost).toBeCloseTo(0.005, 6)
      expect(entry.outputCost).toBeCloseTo(0.0075, 6)
      expect(entry.totalCost).toBeCloseTo(0.0125, 6)
    })

    it('recordLlmCost handles cache hit savings', () => {
      const entry = recordLlmCost('pro', 1000, 500, 500, 'chat')
      expect(entry.cacheHitTokens).toBe(500)
      expect(entry.cacheSaving).toBeGreaterThan(0)
    })

    it('accumulates session spend', () => {
      recordLlmCost('mini', 500, 200, 0, 'chat')
      recordLlmCost('mini', 300, 100, 0, 'summarize')
      expect(getSessionSpent()).toBeGreaterThan(0)
    })
  })

  describe('resetSessionSpent / clearCostRecords', () => {
    it('resetSessionSpent resets only session', () => {
      recordLlmCost('pro', 1000, 500, 0, 'chat')
      resetSessionSpent()
      expect(getSessionSpent()).toBe(0)
    })

    it('clearCostRecords resets everything', () => {
      recordLlmCost('pro', 1000, 500, 0, 'chat')
      clearCostRecords()
      expect(getSessionSpent()).toBe(0)
      expect(getCostRecords().length).toBe(0)
    })
  })

  describe('cost breakdowns', () => {
    beforeEach(() => {
      recordLlmCost('pro', 1000, 500, 0, 'chat')
      recordLlmCost('mini', 500, 200, 0, 'summarize')
      recordLlmCost('standard', 800, 400, 100, 'analysis')
    })

    it('getCostBreakdownByTier groups by tier', () => {
      const byTier = getCostBreakdownByTier()
      expect(byTier['pro']).toBeDefined()
      expect(byTier['mini']).toBeDefined()
      expect(byTier['standard']).toBeDefined()
      expect(byTier['pro'].callCount).toBe(1)
    })

    it('getCostBreakdownByCategory groups by category', () => {
      const byCategory = getCostBreakdownByCategory()
      expect(byCategory['chat']).toBeDefined()
      expect(byCategory['summarize']).toBeDefined()
      expect(byCategory['analysis']).toBeDefined()
    })
  })

  describe('getCostRecords', () => {
    it('filters by since timestamp', () => {
      const before = Date.now()
      recordLlmCost('pro', 1000, 500, 0, 'chat')
      const after = Date.now() + 1
      expect(getCostRecords(before).length).toBe(1)
      expect(getCostRecords(after).length).toBe(0)
    })
  })

  describe('initBudgetSystem', () => {
    it('does not throw', () => {
      expect(() => initBudgetSystem()).not.toThrow()
    })
  })

  describe('budgetMode', () => {
    it('defaults to standard', () => {
      expect(getBudgetMode()).toBe('standard')
    })

    it('setBudgetMode changes mode and updates whitelist', () => {
      setBudgetMode('zero')
      expect(getBudgetMode()).toBe('zero')
      const wl = getTierWhitelist()
      expect(wl.nano).toBe(true)
      expect(wl.mini).toBe(false)
      expect(wl.standard).toBe(false)
      expect(wl.pro).toBe(false)
    })

    it('economy mode allows nano and mini', () => {
      setBudgetMode('economy')
      const wl = getTierWhitelist()
      expect(wl.nano).toBe(true)
      expect(wl.mini).toBe(true)
      expect(wl.standard).toBe(false)
      expect(wl.pro).toBe(false)
    })

    it('standard mode allows all tiers', () => {
      setBudgetMode('standard')
      const wl = getTierWhitelist()
      expect(wl.nano).toBe(true)
      expect(wl.mini).toBe(true)
      expect(wl.standard).toBe(true)
      expect(wl.pro).toBe(true)
    })

    it('resetBudget restores standard mode', () => {
      setBudgetMode('zero')
      resetBudget()
      expect(getBudgetMode()).toBe('standard')
    })
  })

  describe('tierWhitelist', () => {
    it('getTierWhitelist returns copy', () => {
      const wl = getTierWhitelist()
      wl.pro = false
      expect(getTierWhitelist().pro).toBe(true)
    })

    it('setTierWhitelist partially overrides', () => {
      setBudgetMode('economy')
      setTierWhitelist({ standard: true })
      const wl = getTierWhitelist()
      expect(wl.standard).toBe(true)
      expect(wl.pro).toBe(false)
    })
  })

  describe('checkBudget with tier whitelist', () => {
    it('zero mode downgrades pro to nano', () => {
      setBudgetMode('zero')
      const result = checkBudget(1000, 'pro')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('nano')
      expect(result.reason).toContain('budget mode')
    })

    it('zero mode allows nano', () => {
      setBudgetMode('zero')
      const result = checkBudget(1000, 'nano')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('nano')
      expect(result.reason).toBe('Within budget')
    })

    it('economy mode downgrades standard to mini', () => {
      setBudgetMode('economy')
      const result = checkBudget(1000, 'standard')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('mini')
    })

    it('economy mode allows mini', () => {
      setBudgetMode('economy')
      const result = checkBudget(1000, 'mini')
      expect(result.allowed).toBe(true)
      expect(result.recommendedTier).toBe('mini')
      expect(result.reason).toBe('Within budget')
    })

    it('standard mode allows all tiers', () => {
      setBudgetMode('standard')
      const result = checkBudget(1000, 'pro')
      expect(result.recommendedTier).toBe('pro')
    })

    it('whitelist override can grant access in zero mode', () => {
      setBudgetMode('zero')
      setTierWhitelist({ mini: true })
      const result = checkBudget(1000, 'mini')
      expect(result.recommendedTier).toBe('mini')
      expect(result.reason).toBe('Within budget')
    })
  })
})
