import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DomainConstraint, RuleStatus, ConstraintResult, ConstraintCheckContext } from '@/models'
import {
  getAllConstraints,
  getConstraintsByDomain,
  getConstraintById,
  updateConstraintStatus,
  approveConstraint,
  recordConstraintTrigger,
  runConstraints,
  validateConstraintTestCases,
  validateAllConstraints
} from '@/services/domainConstraints'

export const useRuleStore = defineStore('rule', () => {
  const rules = ref<DomainConstraint[]>([])
  const selectedRuleId = ref<string | null>(null)
  const filterDomain = ref<'all' | 'finance' | 'legal' | 'hr'>('all')
  const filterStatus = ref<'all' | RuleStatus>('all')
  const filterConfidence = ref<'all' | 'high' | 'medium' | 'low'>('all')

  function loadRules(): void {
    rules.value = getAllConstraints()
  }

  const filteredRules = computed(() => {
    return rules.value.filter(r => {
      if (filterDomain.value !== 'all' && r.domain !== filterDomain.value) return false
      if (filterStatus.value !== 'all' && r.status !== filterStatus.value) return false
      if (filterConfidence.value !== 'all' && r.reliability.confidence !== filterConfidence.value) return false
      return true
    })
  })

  const selectedRule = computed(() => {
    if (!selectedRuleId.value) return null
    return rules.value.find(r => r.id === selectedRuleId.value) || null
  })

  const statsByDomain = computed(() => {
    const stats: Record<string, { total: number; active: number; draft: number; deprecated: number }> = {}
    for (const r of rules.value) {
      if (!stats[r.domain]) stats[r.domain] = { total: 0, active: 0, draft: 0, deprecated: 0 }
      stats[r.domain].total++
      if (r.status === 'active') stats[r.domain].active++
      if (r.status === 'draft') stats[r.domain].draft++
      if (r.status === 'deprecated') stats[r.domain].deprecated++
    }
    return stats
  })

  function selectRule(ruleId: string): void {
    selectedRuleId.value = ruleId
  }

  function setFilterDomain(domain: 'all' | 'finance' | 'legal' | 'hr'): void {
    filterDomain.value = domain
  }

  function setFilterStatus(status: 'all' | RuleStatus): void {
    filterStatus.value = status
  }

  function setFilterConfidence(confidence: 'all' | 'high' | 'medium' | 'low'): void {
    filterConfidence.value = confidence
  }

  function changeRuleStatus(ruleId: string, status: RuleStatus): boolean {
    const ok = updateConstraintStatus(ruleId, status)
    if (ok) loadRules()
    return ok
  }

  function approveRule(ruleId: string, reviewerName: string): boolean {
    const ok = approveConstraint(ruleId, reviewerName)
    if (ok) loadRules()
    return ok
  }

  function markFalsePositive(ruleId: string): void {
    recordConstraintTrigger(ruleId, true)
    loadRules()
  }

  function runTestOnRule(ruleId: string, testInput: string): ConstraintResult | null {
    const rule = getConstraintById(ruleId)
    if (!rule) return null
    const context: ConstraintCheckContext = {
      entities: [],
      sourceText: testInput,
      outputText: '',
      stepResults: {},
      manifestRoles: [rule.domain]
    }
    return rule.check(context)
  }

  function runAllTestCases(ruleId: string): {
    passed: number
    failed: number
    results: { description: string; passed: boolean; actual: boolean; expected: boolean }[]
  } {
    const rule = getConstraintById(ruleId)
    if (!rule) return { passed: 0, failed: 0, results: [] }

    const results = rule.testCases.map(tc => {
      const context: ConstraintCheckContext = {
        entities: [],
        sourceText: tc.input,
        outputText: '',
        stepResults: {},
        manifestRoles: [rule.domain]
      }
      const result = rule.check(context)
      const actual = result !== null
      const passed = actual === tc.expectedTrigger
      return { description: tc.description, passed, actual, expected: tc.expectedTrigger }
    })

    return {
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      results
    }
  }

  function runDomainConstraints(context: ConstraintCheckContext, domain?: DomainConstraint['domain']): ConstraintResult[] {
    return runConstraints(context, domain)
  }

  function validateRule(ruleId: string): { valid: boolean; errors: string[]; passedTests: number; failedTests: number } {
    const rule = getConstraintById(ruleId)
    if (!rule) return { valid: false, errors: ['Rule not found'], passedTests: 0, failedTests: 0 }
    return validateConstraintTestCases(rule)
  }

  function validateAll(): { total: number; valid: number; invalid: number; details: { id: string; valid: boolean; errors: string[]; passedTests: number; failedTests: number }[] } {
    return validateAllConstraints()
  }

  loadRules()

  return {
    rules,
    selectedRuleId,
    filterDomain,
    filterStatus,
    filterConfidence,
    filteredRules,
    selectedRule,
    statsByDomain,
    loadRules,
    selectRule,
    setFilterDomain,
    setFilterStatus,
    setFilterConfidence,
    changeRuleStatus,
    approveRule,
    markFalsePositive,
    runTestOnRule,
    runAllTestCases,
    runDomainConstraints,
    validateRule,
    validateAll
  }
})
