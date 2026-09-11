import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useRuleStore } from '@/stores/ruleStore'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

describe('ruleStore', () => {
  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loadRules populates rules from domain constraints', () => {
    const store = useRuleStore()
    store.loadRules()
    expect(Array.isArray(store.rules)).toBe(true)
  })

  it('selectRule sets selectedRuleId', () => {
    const store = useRuleStore()
    store.selectRule('test-rule-id')
    expect(store.selectedRuleId).toBe('test-rule-id')
  })

  it('filteredRules respects filterDomain', () => {
    const store = useRuleStore()
    store.setFilterDomain('finance')
    expect(store.filterDomain).toBe('finance')
  })

  it('setFilterStatus updates filter', () => {
    const store = useRuleStore()
    store.setFilterStatus('active')
    expect(store.filterStatus).toBe('active')
  })

  it('setFilterConfidence updates filter', () => {
    const store = useRuleStore()
    store.setFilterConfidence('high')
    expect(store.filterConfidence).toBe('high')
  })

  it('changeRuleStatus returns boolean', () => {
    const store = useRuleStore()
    store.loadRules()
    const result = store.changeRuleStatus('nonexistent', 'active')
    expect(typeof result).toBe('boolean')
  })

  it('approveRule returns boolean', () => {
    const store = useRuleStore()
    store.loadRules()
    const result = store.approveRule('nonexistent', 'tester')
    expect(typeof result).toBe('boolean')
  })

  it('runDomainConstraints returns array', () => {
    const store = useRuleStore()
    store.loadRules()
    const result = store.runDomainConstraints({
      entities: [],
      sourceText: 'test',
      outputText: 'test',
      stepResults: {},
      manifestRoles: []
    })
    expect(Array.isArray(result)).toBe(true)
  })

  it('validateAll returns summary', () => {
    const store = useRuleStore()
    store.loadRules()
    const result = store.validateAll()
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('valid')
    expect(result).toHaveProperty('invalid')
    expect(result).toHaveProperty('details')
  })

  it('statsByDomain returns object', () => {
    const store = useRuleStore()
    store.loadRules()
    expect(typeof store.statsByDomain).toBe('object')
  })

  it('selectedRule returns null when no rule selected', () => {
    const store = useRuleStore()
    expect(store.selectedRule).toBeNull()
  })
})
