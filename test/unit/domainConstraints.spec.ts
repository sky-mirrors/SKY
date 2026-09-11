import { describe, it, expect } from 'vitest'
import {
  getAllConstraints,
  getConstraintsByDomain,
  getActiveConstraints,
  getConstraintById,
  validateConstraintTestCases,
  validateAllConstraints,
  runConstraints,
  getConstraintsByAutomationLevel
} from '@/services/domainConstraints'
import type { ConstraintCheckContext } from '@/models'
import { extractEntities } from '@/services/nerExtractor'

function makeContext(text: string, domain: string = 'legal'): ConstraintCheckContext {
  return {
    entities: extractEntities(text),
    sourceText: text,
    outputText: '',
    stepResults: {},
    manifestRoles: [domain]
  }
}

function firesOn(text: string, constraintId: string, domain: string = 'legal'): boolean {
  const ctx = makeContext(text, domain)
  const all = getAllConstraints()
  const constraint = all.find(c => c.id === constraintId)
  if (!constraint) return false
  ctx.entities = extractEntities(text)
  try {
    const result = constraint.check(ctx)
    return result !== null
  } catch {
    return false
  }
}

describe('domainConstraints', () => {
  describe('constraint library structure', () => {
    it('has at least 55 constraints loaded', () => {
      const all = getAllConstraints()
      expect(all.length).toBeGreaterThanOrEqual(55)
    })

    it('has at least 50 legal constraints', () => {
      const legal = getConstraintsByDomain('legal')
      expect(legal.length).toBeGreaterThanOrEqual(50)
    })

    it('has at least 5 finance constraints', () => {
      const finance = getConstraintsByDomain('finance')
      expect(finance.length).toBeGreaterThanOrEqual(5)
    })

    it('every constraint has required fields', () => {
      const all = getAllConstraints()
      for (const c of all) {
        expect(c.id).toBeTruthy()
        expect(c.domain).toBeTruthy()
        expect(c.description).toBeTruthy()
        expect(c.reliability.source.name).toBeTruthy()
        expect(c.reliability.source.article).toBeTruthy()
        expect(c.reliability.source.effectiveDate).toBeTruthy()
        expect(c.testCases.length).toBeGreaterThanOrEqual(2)
      }
    })

    it('every constraint has automationLevel', () => {
      const all = getAllConstraints()
      for (const c of all) {
        expect(['full', 'semi']).toContain(c.automationLevel)
      }
    })
  })

  describe('each constraint fires on its own positive test cases', () => {
    const all = getAllConstraints()
    for (const constraint of all) {
      describe(constraint.id, () => {
        const positiveCases = constraint.testCases.filter(tc => tc.expectedTrigger)
        for (const tc of positiveCases) {
          it(`triggers: ${tc.description}`, () => {
            const ctx = makeContext(tc.input, constraint.domain)
            try {
              const result = constraint.check(ctx)
              expect(result).not.toBeNull()
            } catch {
              expect.unreachable('check function threw')
            }
          })
        }

        const negativeCases = constraint.testCases.filter(tc => !tc.expectedTrigger)
        for (const tc of negativeCases) {
          it(`does not trigger: ${tc.description}`, () => {
            const ctx = makeContext(tc.input, constraint.domain)
            try {
              const result = constraint.check(ctx)
              expect(result).toBeNull()
            } catch {
              expect.unreachable('check function threw')
            }
          })
        }
      })
    }
  })

  describe('constraint result metadata', () => {
    it('full constraints produce results with automationLevel full or undefined (defaults to full)', () => {
      const ctx = makeContext('员工张三于2024年1月1日入职，至今未签订劳动合同')
      const all = getAllConstraints()
      const constraint = all.find(c => c.id === 'legal-labor-contract-written')
      const result = constraint!.check(ctx)
      expect(result).not.toBeNull()
      expect(result!.automationLevel === 'full' || result!.automationLevel === undefined).toBe(true)
    })

    it('semi constraints produce results with requiresHumanConfirmation', () => {
      const ctx = makeContext('公司签订集体合同，未经职工代表大会讨论')
      const all = getAllConstraints()
      const constraint = all.find(c => c.id === 'legal-labor-collective-contract')
      const result = constraint!.check(ctx)
      expect(result).not.toBeNull()
      expect(result!.automationLevel).toBe('semi')
      expect(result!.requiresHumanConfirmation).toBe(true)
      expect(result!.humanJudgmentPrompt).toBeTruthy()
    })

    it('former assist constraints now produce semi results with requiresHumanConfirmation', () => {
      const ctx = makeContext('本要约为购买商品的意思表示，但未约定价格和数量')
      const all = getAllConstraints()
      const constraint = all.find(c => c.id === 'legal-contract-formation-offer-acceptance')
      const result = constraint!.check(ctx)
      expect(result).not.toBeNull()
      expect(result!.automationLevel).toBe('semi')
      expect(result!.requiresHumanConfirmation).toBe(true)
    })
  })

  describe('automationLevel distribution', () => {
    it('has full automationLevel constraints', () => {
      const all = getAllConstraints()
      const full = all.filter(c => c.automationLevel === 'full')
      expect(full.length).toBeGreaterThanOrEqual(20)
    })

    it('has semi automationLevel constraints', () => {
      const all = getAllConstraints()
      const semi = all.filter(c => c.automationLevel === 'semi')
      expect(semi.length).toBeGreaterThanOrEqual(10)
    })

    it('semi constraints have humanJudgmentPrompt', () => {
      const all = getAllConstraints()
      const semi = all.filter(c => c.automationLevel === 'semi')
      for (const c of semi) {
        expect(c.humanJudgmentPrompt).toBeTruthy()
      }
    })
  })

  describe('constraint validation', () => {
    it('all constraints pass test case validation', () => {
      const result = validateAllConstraints()
      for (const detail of result.details) {
        if (!detail.valid) {
          console.warn(`Constraint ${detail.id} validation issues: ${detail.errors.join(', ')}`)
        }
      }
      expect(result.valid).toBeGreaterThanOrEqual(result.total * 0.95)
    })

    it('validation checks at least 55 constraints', () => {
      const result = validateAllConstraints()
      expect(result.total).toBeGreaterThanOrEqual(55)
    })
  })

  describe('constraint status management', () => {
    it('getConstraintById returns correct constraint', () => {
      const c = getConstraintById('legal-labor-contract-written')
      expect(c).toBeTruthy()
      expect(c!.id).toBe('legal-labor-contract-written')
      expect(c!.domain).toBe('legal')
    })

    it('getConstraintById returns undefined for unknown id', () => {
      const c = getConstraintById('non-existent')
      expect(c).toBeUndefined()
    })

    it('getActiveConstraints returns only active rules', () => {
      const active = getActiveConstraints()
      expect(active.length).toBeGreaterThan(0)
      for (const c of active) {
        expect(c.status).toBe('active')
      }
    })

    it('getConstraintsByAutomationLevel returns filtered constraints', () => {
      const full = getConstraintsByAutomationLevel('full')
      expect(full.length).toBeGreaterThanOrEqual(20)
      for (const c of full) {
        expect(c.automationLevel).toBe('full')
      }
    })
  })

  describe('cross-domain isolation', () => {
    it('legal constraints do not fire on finance-only context', () => {
      const ctx = makeContext('增值税税率为20%', 'finance')
      const results = runConstraints(ctx, 'finance')
      expect(results.some(r => r.constraintId.startsWith('legal-'))).toBe(false)
    })

    it('finance constraints do not fire on legal-only context', () => {
      const ctx = makeContext('公司未为员工缴纳社会保险')
      const results = runConstraints(ctx, 'legal')
      expect(results.every(r => !r.constraintId.startsWith('finance-'))).toBe(true)
    })
  })

  describe('negative cases - irrelevant text', () => {
    it('no constraints fire on cooking recipe', () => {
      const ctx = makeContext('今天做了一道红烧肉，加了酱油和冰糖')
      const results = runConstraints(ctx, 'legal')
      expect(results.length).toBe(0)
    })

    it('no constraints fire on weather description', () => {
      const ctx = makeContext('明天天气晴朗，气温25度')
      const results = runConstraints(ctx, 'legal')
      expect(results.length).toBe(0)
    })

    it('no constraints fire on tech news', () => {
      const ctx = makeContext('新款手机发布，搭载最新芯片', 'finance')
      const results = runConstraints(ctx, 'finance')
      expect(results.length).toBe(0)
    })
  })
})
