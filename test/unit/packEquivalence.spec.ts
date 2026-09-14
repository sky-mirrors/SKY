import { describe, it, expect } from 'vitest'
import { LEGAL_CONSTRAINTS, FINANCE_CONSTRAINTS } from '@/services/domainConstraints'
import { extractEntities } from '@/services/nerExtractor'
import { createBuiltinPackSource } from '@/host/pack/loader'
import { compilePackConstraint, validatePackConstraint } from '@/host/pack/dsl'
import type { DomainConstraint, ConstraintCheckContext, ConstraintResult } from '@/models'
import type { PackConstraint } from '@/host/pack/types'

/**
 * 规格 8.6 等价验收：pack 声明式约束与内置 LEGAL/FINANCE 约束在全部 testCases 上逐字段等价。
 * 对照字段：triggered / severity / message / reliability / matchedEntities /
 *          requiresHumanConfirmation / humanJudgmentPrompt / automationLevel（按约束级兜底归一）。
 */

const source = createBuiltinPackSource()

function loadPackConstraints(packId: string): { constraints: PackConstraint[]; domain: DomainConstraint['domain'] } {
  const manifest = source.readManifest(packId) as { domain?: string } | null
  expect(manifest, `${packId}/pack.json 缺失或不可读`).toBeTruthy()
  const raw = source.readConstraints(packId)
  expect(Array.isArray(raw), `${packId}/boundary/constraints.json 缺失或不是数组`).toBeTruthy()
  const list = raw as unknown[]

  const errors: string[] = []
  list.forEach((item, index) => {
    errors.push(...validatePackConstraint(item, index).map(e => `${packId} constraints.json#/items/${index}: ${e.message}`))
  })
  expect(errors, errors.join('\n')).toEqual([])

  const evaluators = source.listEvaluators(packId)
  const constraints = (list as PackConstraint[]).map(pc => {
    let evaluator = null
    if (pc.evaluator) {
      evaluator = evaluators[pc.evaluator] ?? null
      expect(evaluator, `${packId} evaluator 模块缺失: ${pc.evaluator}`).toBeTruthy()
    }
    return compilePackConstraint(pc, { packId, domain: (manifest!.domain ?? packId) as DomainConstraint['domain'], evaluator })
  })
  return { constraints, domain: (manifest!.domain ?? packId) as DomainConstraint['domain'] }
}

function makeCtx(input: string, domain: DomainConstraint['domain']): ConstraintCheckContext {
  return {
    entities: extractEntities(input),
    sourceText: input,
    outputText: '',
    stepResults: {},
    manifestRoles: [domain]
  }
}

interface ComparisonFailure {
  id: string
  case: string
  field: string
  expected: unknown
  actual: unknown
}

function compareResults(
  expected: ConstraintResult | null,
  actual: ConstraintResult | null,
  original: DomainConstraint,
  tcDescription: string,
  failures: ComparisonFailure[]
): void {
  const push = (field: string, exp: unknown, act: unknown) => {
    failures.push({ id: original.id, case: tcDescription, field, expected: exp, actual: act })
  }

  if ((expected !== null) !== (actual !== null)) {
    push('triggered', expected !== null, actual !== null)
    return
  }
  if (expected === null || actual === null) return

  if (expected.severity !== actual.severity) push('severity', expected.severity, actual.severity)
  if (expected.message !== actual.message) push('message', expected.message, actual.message)
  expect(JSON.stringify(actual.reliability)).toBeDefined()
  if (JSON.stringify(expected.reliability) !== JSON.stringify(actual.reliability)) {
    push('reliability', JSON.stringify(expected.reliability), JSON.stringify(actual.reliability))
  }
  const expMatched = (expected.matchedEntities ?? []).map(e => `${e.type}:${e.raw}`).sort()
  const actMatched = (actual.matchedEntities ?? []).map(e => `${e.type}:${e.raw}`).sort()
  if (JSON.stringify(expMatched) !== JSON.stringify(actMatched)) {
    push('matchedEntities', JSON.stringify(expMatched), JSON.stringify(actMatched))
  }
  if ((expected.requiresHumanConfirmation ?? undefined) !== (actual.requiresHumanConfirmation ?? undefined)) {
    push('requiresHumanConfirmation', expected.requiresHumanConfirmation, actual.requiresHumanConfirmation)
  }
  if ((expected.humanJudgmentPrompt ?? undefined) !== (actual.humanJudgmentPrompt ?? undefined)) {
    push('humanJudgmentPrompt', expected.humanJudgmentPrompt, actual.humanJudgmentPrompt)
  }
  const expAutomation = expected.automationLevel ?? original.automationLevel ?? 'full'
  const actAutomation = actual.automationLevel ?? 'full'
  if (expAutomation !== actAutomation) {
    push('automationLevel', expAutomation, actAutomation)
  }
}

function runEquivalence(packId: string, originals: DomainConstraint[]): ComparisonFailure[] {
  const { constraints, domain } = loadPackConstraints(packId)
  const compiledById = new Map(constraints.map(c => [c.id, c]))

  const failures: ComparisonFailure[] = []
  const coveredIds = new Set<string>()

  for (const original of originals) {
    const compiled = compiledById.get(original.id)
    if (!compiled) {
      failures.push({ id: original.id, case: '(completeness)', field: 'missing-in-pack', expected: 'present', actual: 'absent' })
      continue
    }
    coveredIds.add(original.id)
    expect(original.testCases.length).toBeGreaterThanOrEqual(2)
    for (const tc of original.testCases) {
      const ctx = makeCtx(tc.input, domain)
      const expected = original.check({ ...ctx, entities: extractEntities(tc.input) })
      const actual = compiled.check({ ...ctx, entities: extractEntities(tc.input) })
      compareResults(expected, actual, original, tc.description, failures)
    }
  }

  for (const id of compiledById.keys()) {
    if (!coveredIds.has(id)) {
      failures.push({ id, case: '(completeness)', field: 'extra-in-pack', expected: 'absent', actual: 'present' })
    }
  }
  return failures
}

describe('pack 等价验收：finance pack（#51-#55）', () => {
  it('全部 testCases 逐字段与内置 FINANCE_CONSTRAINTS 等价', () => {
    const failures = runEquivalence('finance', FINANCE_CONSTRAINTS)
    const detail = failures.map(f => `${f.id} [${f.case}] ${f.field}: expected=${JSON.stringify(f.expected)}, actual=${JSON.stringify(f.actual)}`).join('\n')
    expect(failures, detail).toEqual([])
  })

  it('约束数量 5 条、id 一一对应', () => {
    const { constraints } = loadPackConstraints('finance')
    expect(constraints).toHaveLength(5)
    expect(constraints.map(c => c.id).sort()).toEqual(FINANCE_CONSTRAINTS.map(c => c.id).sort())
  })
})

describe('pack 等价验收：legal pack（#1-#50）', () => {
  it('全部 testCases 逐字段与内置 LEGAL_CONSTRAINTS 等价', () => {
    const failures = runEquivalence('legal', LEGAL_CONSTRAINTS)
    const detail = failures.map(f => `${f.id} [${f.case}] ${f.field}: expected=${JSON.stringify(f.expected)}, actual=${JSON.stringify(f.actual)}`).join('\n')
    expect(failures, detail).toEqual([])
  })

  it('约束数量 50 条、id 一一对应', () => {
    const { constraints } = loadPackConstraints('legal')
    expect(constraints).toHaveLength(50)
    expect(constraints.map(c => c.id).sort()).toEqual(LEGAL_CONSTRAINTS.map(c => c.id).sort())
  })
})
