import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getZOLState, resetZOL, recordStrategyOutcome, DOMAIN_REWRITE_OFFSETS, DOMAIN_DISAMBIG_OFFSETS } from '@/services/strategySelector'
import { getRoutingZOLState, DOMAIN_ROUTING_TIER_BIAS } from '@/services/smartRouter'
import { setBudgetMode, resetBudget, getSessionSpent } from '@/services/tokenBudget'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
    get length() { return Object.keys(store).length },
    key: (idx: number) => Object.keys(store)[idx] ?? null
  }
})()
vi.stubGlobal('localStorage', localStorageMock)

describe('ZolWidget data access', () => {
  beforeEach(() => {
    localStorageMock.clear()
    resetZOL()
    resetBudget()
  })

  it('getZOLState returns all three learners', () => {
    const state = getZOLState()
    expect(state.rewrite).toBeDefined()
    expect(state.disambig).toBeDefined()
    expect(state.rewrite.outcomeCount).toBe(0)
    expect(state.disambig.outcomeCount).toBe(0)
  })

  it('getRoutingZOLState returns routing learner', () => {
    const state = getRoutingZOLState()
    expect(state.outcomeCount).toBe(0)
    expect(state.recentSuccessRate).toBeGreaterThanOrEqual(0)
  })

  it('after recording outcomes, success rate updates', () => {
    for (let i = 0; i < 25; i++) {
      recordStrategyOutcome({ strategyType: 'rewrite', strategy: 'keyword_extract', outcome: 'success', contextSnapshot: {} })
    }
    const state = getZOLState()
    expect(state.rewrite.outcomeCount).toBe(25)
    expect(state.rewrite.recentSuccessRate).toBe(1.0)
  })

  it('domain offset tables are accessible and have expected keys', () => {
    expect(DOMAIN_REWRITE_OFFSETS.legal).toBeDefined()
    expect(DOMAIN_REWRITE_OFFSETS.legal!.minLawArticleCount).toBe(-1)
    expect(DOMAIN_DISAMBIG_OFFSETS.finance).toBeDefined()
    expect(DOMAIN_ROUTING_TIER_BIAS.legal).toBe(1)
  })

  it('budget mode and spend are accessible for widget', () => {
    setBudgetMode('zero')
    expect(getSessionSpent()).toBe(0)
    setBudgetMode('standard')
  })
})
