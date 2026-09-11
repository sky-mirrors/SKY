import { describe, it, expect } from 'vitest'
import { runRuleEngine, buildRuleContext } from '@/services/ruleEngine'
import type { L2RuleBasedFallback } from '@/models'

function makeFallback(overrides: Partial<L2RuleBasedFallback> = {}): L2RuleBasedFallback {
  return {
    enabled: true,
    rules: [],
    defaultOutput: '',
    ...overrides
  }
}

describe('ruleEngine', () => {
  describe('runRuleEngine', () => {
    it('returns unmatched when disabled', () => {
      const fallback = makeFallback({ enabled: false, rules: [{ id: 'r1', conditions: [], action: { outputTemplate: 'out' }, priority: 1 }] })
      const result = runRuleEngine(fallback, { input: 'test' })
      expect(result.matched).toBe(false)
      expect(result.output).toBe('')
    })

    it('returns unmatched when rules array is empty', () => {
      const fallback = makeFallback()
      const result = runRuleEngine(fallback, { input: 'test' })
      expect(result.matched).toBe(false)
    })

    it('matches rule with contains operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'input', operator: 'contains', value: 'hello' }],
          action: { outputTemplate: 'Hello found!', severity: 'info' as const, tags: ['greeting'] },
          priority: 10
        }]
      })
      const result = runRuleEngine(fallback, { input: 'hello world' })
      expect(result.matched).toBe(true)
      expect(result.output).toBe('Hello found!')
      expect(result.matchedRuleId).toBe('r1')
      expect(result.severity).toBe('info')
      expect(result.tags).toEqual(['greeting'])
    })

    it('does not match when contains condition fails', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'input', operator: 'contains', value: 'goodbye' }],
          action: { outputTemplate: 'Goodbye found!' },
          priority: 10
        }]
      })
      const result = runRuleEngine(fallback, { input: 'hello world' })
      expect(result.matched).toBe(false)
    })

    it('matches rule with not_contains operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'input', operator: 'not_contains', value: 'bad' }],
          action: { outputTemplate: 'No bad content' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { input: 'good content' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { input: 'bad content' }).matched).toBe(false)
    })

    it('matches rule with eq operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'status', operator: 'eq', value: 'active' }],
          action: { outputTemplate: 'Active!' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { status: 'active' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { status: 'inactive' }).matched).toBe(false)
    })

    it('matches rule with neq operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'status', operator: 'neq', value: 'closed' }],
          action: { outputTemplate: 'Not closed' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { status: 'active' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { status: 'closed' }).matched).toBe(false)
    })

    it('matches rule with regex operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'input', operator: 'regex', value: '\\d+万元' }],
          action: { outputTemplate: 'Amount detected' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { input: '金额100万元' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { input: '无金额' }).matched).toBe(false)
    })

    it('handles invalid regex gracefully', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'input', operator: 'regex', value: '[invalid' }],
          action: { outputTemplate: 'Should not match' },
          priority: 5
        }]
      })
      const result = runRuleEngine(fallback, { input: 'test' })
      expect(result.matched).toBe(false)
    })

    it('matches rule with gt operator on numeric values in text', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'amount', operator: 'gt', value: '50' }],
          action: { outputTemplate: 'Large amount' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { amount: '金额100万元' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { amount: '金额30万元' }).matched).toBe(false)
    })

    it('matches rule with between operator', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'amount', operator: 'between', value: '10', valueMax: '100' }],
          action: { outputTemplate: 'In range' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { amount: '金额50万元' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { amount: '金额5万元' }).matched).toBe(false)
      expect(runRuleEngine(fallback, { amount: '金额200万元' }).matched).toBe(false)
    })

    it('selects highest priority rule when multiple match', () => {
      const fallback = makeFallback({
        rules: [
          { id: 'low', conditions: [{ field: 'input', operator: 'contains', value: 'test' }], action: { outputTemplate: 'Low priority' }, priority: 1 },
          { id: 'high', conditions: [{ field: 'input', operator: 'contains', value: 'test' }], action: { outputTemplate: 'High priority' }, priority: 10 }
        ]
      })
      const result = runRuleEngine(fallback, { input: 'test input' })
      expect(result.matched).toBe(true)
      expect(result.matchedRuleId).toBe('high')
      expect(result.output).toBe('High priority')
    })

    it('requires all conditions to match (AND logic)', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [
            { field: 'input', operator: 'contains', value: 'hello' },
            { field: 'status', operator: 'eq', value: 'active' }
          ],
          action: { outputTemplate: 'Both match' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, { input: 'hello', status: 'active' }).matched).toBe(true)
      expect(runRuleEngine(fallback, { input: 'hello', status: 'inactive' }).matched).toBe(false)
      expect(runRuleEngine(fallback, { input: 'goodbye', status: 'active' }).matched).toBe(false)
    })

    it('fills template variables in output', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'name', operator: 'contains', value: 'test' }],
          action: { outputTemplate: 'Hello {{name}}, your input was: {{input}}' },
          priority: 5
        }]
      })
      const result = runRuleEngine(fallback, { name: 'test-user', input: 'some data' })
      expect(result.output).toBe('Hello test-user, your input was: some data')
    })

    it('excludes dates from numeric extraction for gt/gte/lt/lte', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'text', operator: 'gt', value: '100' }],
          action: { outputTemplate: 'found' },
          priority: 5
        }]
      })
      const result = runRuleEngine(fallback, { text: '日期2024年1月1日 金额50元' })
      expect(result.matched).toBe(false)
    })

    it('handles missing field gracefully', () => {
      const fallback = makeFallback({
        rules: [{
          id: 'r1',
          conditions: [{ field: 'nonexistent', operator: 'contains', value: 'test' }],
          action: { outputTemplate: 'found' },
          priority: 5
        }]
      })
      expect(runRuleEngine(fallback, {}).matched).toBe(false)
    })
  })

  describe('buildRuleContext', () => {
    it('builds context from userInput', () => {
      const ctx = buildRuleContext({ inputText: 'hello', filePath: '/test.txt', context: 'ctx' }, {})
      expect(ctx.input).toBe('hello')
      expect(ctx.user_file).toBe('/test.txt')
      expect(ctx.context).toBe('ctx')
    })

    it('handles undefined userInput fields', () => {
      const ctx = buildRuleContext({}, {})
      expect(ctx.input).toBe('')
      expect(ctx.user_file).toBe('')
      expect(ctx.context).toBe('')
    })

    it('includes step results in context', () => {
      const ctx = buildRuleContext({ inputText: 'query' }, { 1: 'result1', 2: 'result2' })
      expect(ctx.step_1_result).toBe('result1')
      expect(ctx.step_2_result).toBe('result2')
    })

    it('extracts numeric values from step results', () => {
      const ctx = buildRuleContext({}, { 1: '金额100万元和200万元' })
      expect(ctx.step_1_amount).toBe('200')
      expect(ctx.step_1_total).toBe('300')
    })

    it('does not add amount/total when no numbers in step result', () => {
      const ctx = buildRuleContext({}, { 1: 'no numbers here' })
      expect(ctx.step_1_amount).toBeUndefined()
      expect(ctx.step_1_total).toBeUndefined()
    })
  })
})
