import type {
  DomainConstraint,
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintReliability,
  ConstraintSource,
  ConstraintApplicability,
  ConstraintTestCase,
  RuleStatus,
  ExtractedEntity
} from '@/models'
import { extractEntities } from './nerExtractor'

const ACTIVE_CONSTRAINTS: DomainConstraint[] = []
const EXTERNAL_CONSTRAINT_IDS = new Set<string>()

/**
 * 规格书 8.8（Phase 2 适配器，P3.5/R12 修订）：pack 约束注入 runConstraints 管道。
 * - P3.5 起内置约束退出生产注入路径，本管道是约束库唯一装载入口；
 * - 同 id 先装载者优先、后到跳过并告警（避免双重拦截）；
 * - 注入仅接受已按 DSL 引擎编译完成的 DomainConstraint 对象；
 * - 返回 { injected, skipped } 供加载器记录并对账。
 */
export function injectExternalConstraints(constraints: DomainConstraint[]): {
  injected: string[]
  skipped: Array<{ id: string; reason: string }>
} {
  const injected: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const c of constraints) {
    if (ACTIVE_CONSTRAINTS.some(existing => existing.id === c.id)) {
      skipped.push({ id: c.id, reason: 'duplicate-id' })
      continue
    }
    ACTIVE_CONSTRAINTS.push(c)
    EXTERNAL_CONSTRAINT_IDS.add(c.id)
    injected.push(c.id)
  }
  return { injected, skipped }
}

/** 规格书 8.8：pack 卸载时摘除其注入的约束（仅经 injectExternalConstraints 装载的 id 可摘除）。 */
export function removeExternalConstraints(ids: string[]): number {
  let removed = 0
  for (const id of ids) {
    if (!EXTERNAL_CONSTRAINT_IDS.has(id)) continue
    const idx = ACTIVE_CONSTRAINTS.findIndex(c => c.id === id)
    if (idx >= 0) {
      ACTIVE_CONSTRAINTS.splice(idx, 1)
      removed++
    }
    EXTERNAL_CONSTRAINT_IDS.delete(id)
  }
  return removed
}

export function getExternalConstraintIds(): string[] {
  return [...EXTERNAL_CONSTRAINT_IDS]
}

function createConstraint(
  id: string,
  domain: DomainConstraint['domain'],
  category: string,
  description: string,
  severity: ConstraintResult['severity'],
  applicability: ConstraintApplicability,
  reliability: ConstraintReliability,
  testCases: ConstraintTestCase[],
  checkFn: (context: ConstraintCheckContext) => ConstraintResult | null,
  automationLevel: 'full' | 'semi' = 'full',
  humanJudgmentPrompt?: string,
  reviewType: 'auto' | 'manual' = 'auto'
): DomainConstraint {
  return {
    id,
    domain,
    category,
    description,
    severity,
    applicability,
    reliability,
    testCases,
    status: 'draft',
    triggerCount: 0,
    falsePositiveCount: 0,
    lastTriggeredAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    automationLevel,
    humanJudgmentPrompt,
    reviewType,
    check: checkFn
  }
}

function makeLawSource(name: string, article: string, effectiveDate: string, originalText?: string): ConstraintSource {
  return {
    type: 'law',
    name,
    article,
    effectiveDate,
    originalText,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function makeRegulationSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'regulation',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function makeStandardSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'standard',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

const PRC_APPLICABILITY: ConstraintApplicability = { jurisdiction: 'PRC' }

function findEntitiesByType(entities: ExtractedEntity[], type: string): ExtractedEntity[] {
  return entities.filter(e => e.type === type)
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

// 内置领域约束（法务 / 财务）已移出开源仓库，随闭源领域包分发。
// 约束仍经 pack 挂载注入（injectExternalConstraints），引擎与下面这组 API 不变。
export function getAllConstraints(): DomainConstraint[] {
  return [...ACTIVE_CONSTRAINTS]
}

export function getConstraintsByDomain(domain: DomainConstraint['domain']): DomainConstraint[] {
  return ACTIVE_CONSTRAINTS.filter(c => c.domain === domain)
}

export function getConstraintsByAutomationLevel(level: DomainConstraint['automationLevel']): DomainConstraint[] {
  return ACTIVE_CONSTRAINTS.filter(c => c.automationLevel === level)
}

export function getActiveConstraints(): DomainConstraint[] {
  return ACTIVE_CONSTRAINTS.filter(c => c.status === 'active')
}

export function getConstraintById(id: string): DomainConstraint | undefined {
  return ACTIVE_CONSTRAINTS.find(c => c.id === id)
}

export function updateConstraintStatus(id: string, status: RuleStatus): boolean {
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return false
  constraint.status = status
  constraint.updatedAt = Date.now()
  return true
}

export function approveConstraint(id: string, reviewerName: string): boolean {
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return false
  constraint.reliability.source.verifiedBy = reviewerName
  constraint.reliability.source.verifiedAt = Date.now()
  constraint.status = 'active'
  constraint.updatedAt = Date.now()
  return true
}

export function recordConstraintTrigger(id: string, isFalsePositive: boolean): void {
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return
  constraint.triggerCount++
  if (isFalsePositive) constraint.falsePositiveCount++
  constraint.lastTriggeredAt = Date.now()

  if (constraint.triggerCount >= 10) {
    const fpRate = constraint.falsePositiveCount / constraint.triggerCount
    if (fpRate > 0.3 && constraint.status === 'active') {
      constraint.status = 'deprecated'
      constraint.updatedAt = Date.now()
    } else if (fpRate > 0.2 && constraint.status === 'active') {
      if (constraint.reliability.confidence === 'high') {
        constraint.reliability.confidence = 'medium'
      } else if (constraint.reliability.confidence === 'medium') {
        constraint.reliability.confidence = 'low'
      }
      constraint.updatedAt = Date.now()
    }
  }

  if (constraint.status === 'testing' && constraint.triggerCount >= 5) {
    const fpRate = constraint.falsePositiveCount / constraint.triggerCount
    if (fpRate < 0.2) {
      constraint.status = 'active'
      constraint.updatedAt = Date.now()
    }
  }
}

export function runConstraints(
  context: ConstraintCheckContext,
  domain?: DomainConstraint['domain']
): ConstraintResult[] {
  const constraints = domain
    ? ACTIVE_CONSTRAINTS.filter(c => c.domain === domain)
    : ACTIVE_CONSTRAINTS

  context.entities = extractEntities(context.sourceText + ' ' + context.outputText)

  const results: ConstraintResult[] = []
  for (const constraint of constraints) {
    if (constraint.status !== 'active' && constraint.status !== 'testing') continue
    try {
      const result = constraint.check(context)
      if (result) {
        results.push(result)
        recordConstraintTrigger(constraint.id, false)
      }
    } catch {
      // constraint check errors are non-critical
    }
  }

  return results
}

export function validateConstraintTestCases(constraint: DomainConstraint): {
  valid: boolean
  errors: string[]
  passedTests: number
  failedTests: number
} {
  const errors: string[] = []

  if (!constraint.reliability.source.name) {
    errors.push('Missing source name')
  }
  if (!constraint.reliability.source.article) {
    errors.push('Missing source article')
  }
  if (!constraint.reliability.source.effectiveDate) {
    errors.push('Missing source effective date')
  }
  if (constraint.testCases.length < 2) {
    errors.push('Must have at least 2 test cases')
  }

  let passedTests = 0
  let failedTests = 0

  for (const tc of constraint.testCases) {
    const context: ConstraintCheckContext = {
      entities: extractEntities(tc.input),
      sourceText: tc.input,
      outputText: '',
      stepResults: {},
      manifestRoles: [constraint.domain]
    }

    try {
      const result = constraint.check(context)
      const triggered = result !== null
      if (triggered === tc.expectedTrigger) {
        passedTests++
      } else {
        failedTests++
        errors.push(`Test case "${tc.description}" failed: expected ${tc.expectedTrigger ? 'trigger' : 'no trigger'}, got ${triggered ? 'trigger' : 'no trigger'}`)
      }
    } catch (err) {
      failedTests++
      errors.push(`Test case "${tc.description}" threw error: ${(err as Error).message}`)
    }
  }

  return {
    valid: errors.length === 0 && failedTests === 0,
    errors,
    passedTests,
    failedTests
  }
}

export function validateAllConstraints(): {
  total: number
  valid: number
  invalid: number
  details: { id: string; valid: boolean; errors: string[]; passedTests: number; failedTests: number }[]
} {
  const details = ACTIVE_CONSTRAINTS.map(c => {
    const result = validateConstraintTestCases(c)
    return { id: c.id, ...result }
  })

  return {
    total: details.length,
    valid: details.filter(d => d.valid).length,
    invalid: details.filter(d => !d.valid).length,
    details
  }
}
