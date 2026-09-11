import { describe, it, expect, beforeEach } from 'vitest'
import {
  getUserPricing,
  setUserPricing,
  resetUserPricing,
  getPricingForTier,
  calculateCost,
  calculateCostByTier,
  estimateStepCost
} from '@/services/tokenPricing'

describe('tokenPricing', () => {
  beforeEach(() => {
    resetUserPricing()
  })

  describe('getUserPricing / setUserPricing', () => {
    it('returns default user pricing', () => {
      const p = getUserPricing()
      expect(p.inputPricePer1k).toBe(0.005)
      expect(p.outputPricePer1k).toBe(0.015)
      expect(p.cacheHitDiscount).toBe(0.5)
    })

    it('updates partial pricing', () => {
      setUserPricing({ inputPricePer1k: 0.02 })
      const p = getUserPricing()
      expect(p.inputPricePer1k).toBe(0.02)
      expect(p.outputPricePer1k).toBe(0.015)
    })

    it('resetUserPricing restores defaults', () => {
      setUserPricing({ inputPricePer1k: 0.1, outputPricePer1k: 0.2 })
      resetUserPricing()
      const p = getUserPricing()
      expect(p.inputPricePer1k).toBe(0.005)
      expect(p.outputPricePer1k).toBe(0.015)
    })
  })

  describe('getPricingForTier', () => {
    it('nano tier is cheapest', () => {
      const p = getPricingForTier('nano')
      expect(p.inputPricePer1k).toBeLessThan(getPricingForTier('mini').inputPricePer1k)
    })

    it('pro tier is most expensive', () => {
      const p = getPricingForTier('pro')
      expect(p.inputPricePer1k).toBeGreaterThan(getPricingForTier('standard').inputPricePer1k)
    })

    it('tier order: nano < mini < standard < pro', () => {
      const nano = getPricingForTier('nano')
      const mini = getPricingForTier('mini')
      const standard = getPricingForTier('standard')
      const pro = getPricingForTier('pro')
      expect(nano.inputPricePer1k).toBeLessThan(mini.inputPricePer1k)
      expect(mini.inputPricePer1k).toBeLessThan(standard.inputPricePer1k)
      expect(standard.inputPricePer1k).toBeLessThan(pro.inputPricePer1k)
    })
  })

  describe('calculateCost', () => {
    it('calculates cost with default pricing', () => {
      const cost = calculateCost(1000, 500, 0)
      expect(cost.inputCost).toBeCloseTo(0.005, 6)
      expect(cost.outputCost).toBeCloseTo(0.0075, 6)
      expect(cost.totalCost).toBeCloseTo(0.0125, 6)
    })

    it('applies cache saving', () => {
      const cost = calculateCost(1000, 500, 500)
      expect(cost.cacheSaving).toBeGreaterThan(0)
      expect(cost.totalCost).toBeLessThan(calculateCost(1000, 500, 0).totalCost)
    })

    it('never returns negative total cost', () => {
      const cost = calculateCost(0, 0, 1000)
      expect(cost.totalCost).toBeGreaterThanOrEqual(0)
    })

    it('uses updated user pricing', () => {
      setUserPricing({ inputPricePer1k: 0.02, outputPricePer1k: 0.08 })
      const cost = calculateCost(1000, 1000, 0)
      expect(cost.inputCost).toBeCloseTo(0.02, 6)
      expect(cost.outputCost).toBeCloseTo(0.08, 6)
    })
  })

  describe('calculateCostByTier', () => {
    it('calculates cost by tier name', () => {
      const cost = calculateCostByTier(1000, 500, 'mini')
      expect(cost.inputCost).toBeCloseTo(0.0015, 6)
      expect(cost.outputCost).toBeCloseTo(0.003, 6)
    })

    it('pro tier costs more than nano', () => {
      const pro = calculateCostByTier(1000, 500, 'pro')
      const nano = calculateCostByTier(1000, 500, 'nano')
      expect(pro.totalCost).toBeGreaterThan(nano.totalCost)
    })
  })

  describe('estimateStepCost', () => {
    it('nano step is cheaper than pro step', () => {
      const nanoCost = estimateStepCost('nano', 1000)
      const proCost = estimateStepCost('pro', 1000)
      expect(nanoCost).toBeLessThan(proCost)
    })

    it('returns positive cost for any tier', () => {
      for (const tier of ['nano', 'mini', 'standard', 'pro'] as const) {
        expect(estimateStepCost(tier, 500)).toBeGreaterThan(0)
      }
    })
  })
})
