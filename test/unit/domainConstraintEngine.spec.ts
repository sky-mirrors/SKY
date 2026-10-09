import { describe, it, expect, afterEach } from 'vitest'
import {
  getAllConstraints,
  getConstraintById,
  getActiveConstraints,
  getConstraintsByAutomationLevel,
  getExternalConstraintIds,
  injectExternalConstraints,
  removeExternalConstraints,
  updateConstraintStatus,
  runConstraints
} from '@/services/domainConstraints'
import type {
  DomainConstraint,
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintSource
} from '@/models'

/**
 * 约束引擎测试（注入式，**不含任何领域业务内容**）。
 *
 * 背景（2026-10）：内置领域约束（法务 / 财务）已移出开源仓库、随闭源领域包分发，
 * 原先以「至少 55 条约束 / 50 条法务 / 5 条财务 / 逐条用例触发」为核心的
 * `domainConstraints.spec.ts` 随之删除（它验证的对象即被闭源的内容）。
 * 本文件补回**引擎层**覆盖：约束经外部注入（pack 挂载走的正是这条路径）之后的
 * 注册、检索、过滤、触发、状态流转与移除。
 *
 * 注：`DomainConstraint['domain']` 是 `'finance' | 'legal' | 'geotech'` 的字面量枚举
 * （类型层面无法扩展），下方取 `'legal'` **仅作类型标签**——约束的描述、来源、判据
 * 与法务业务无关。
 */

const TEST_SOURCE: ConstraintSource = {
  type: 'standard',
  name: 'unit-test-source',
  article: 'T-1',
  effectiveDate: '2026-01-01'
}

function makeConstraint(id: string, automationLevel: 'full' | 'semi', token: number): DomainConstraint {
  const check = (ctx: ConstraintCheckContext): ConstraintResult | null => {
    if (!ctx.sourceText.includes(String(token))) return null
    const base: ConstraintResult = {
      triggered: true,
      constraintId: id,
      severity: 'warning',
      message: `输入中出现了测试标记 ${token}`,
      reliability: { confidence: 'high', source: TEST_SOURCE },
      automationLevel
    }
    return automationLevel === 'semi'
      ? { ...base, requiresHumanConfirmation: true, humanJudgmentPrompt: '请人工确认' }
      : base
  }

  return {
    id,
    domain: 'legal',
    category: 'unit-test',
    description: `中性测试约束 ${id}`,
    severity: 'warning',
    applicability: { jurisdiction: 'TEST' },
    reliability: { confidence: 'high', source: TEST_SOURCE },
    testCases: [
      { description: '命中', input: String(token), expectedTrigger: true },
      { description: '不命中', input: 'no-match', expectedTrigger: false }
    ],
    status: 'active',
    triggerCount: 0,
    falsePositiveCount: 0,
    lastTriggeredAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    automationLevel,
    reviewType: 'auto',
    check
  }
}

function contextOf(sourceText: string): ConstraintCheckContext {
  return { entities: [], sourceText, outputText: '', stepResults: {}, manifestRoles: [] }
}

afterEach(() => {
  removeExternalConstraints(getExternalConstraintIds())
})

describe('约束引擎（注入式，无领域内容）', () => {
  it('内置领域约束已移出：未注入时约束集为空', () => {
    expect(getAllConstraints()).toEqual([])
    expect(getExternalConstraintIds()).toEqual([])
    expect(getConstraintById('any-id')).toBeUndefined()
    expect(getActiveConstraints()).toEqual([])
  })

  it('注入后可按 id / automationLevel 检索，移除后回落', () => {
    injectExternalConstraints([makeConstraint('ut-full', 'full', 111), makeConstraint('ut-semi', 'semi', 222)])

    expect(getAllConstraints()).toHaveLength(2)
    expect(getExternalConstraintIds().sort()).toEqual(['ut-full', 'ut-semi'])
    expect(getConstraintById('ut-semi')?.automationLevel).toBe('semi')
    expect(getConstraintsByAutomationLevel('full').map((c) => c.id)).toEqual(['ut-full'])

    expect(removeExternalConstraints(['ut-full'])).toBe(1)
    expect(getAllConstraints()).toHaveLength(1)
    expect(removeExternalConstraints(['ut-semi'])).toBe(1)
    expect(getAllConstraints()).toEqual([])
  })

  it('runConstraints 只返回命中的约束；semi 带人工确认标记', () => {
    injectExternalConstraints([makeConstraint('ut-full', 'full', 111), makeConstraint('ut-semi', 'semi', 222)])

    expect(runConstraints(contextOf('没有任何命中'))).toEqual([])

    const hits = runConstraints(contextOf('输入里含 222'))
    expect(hits.map((r) => r.constraintId)).toEqual(['ut-semi'])
    expect(hits[0].requiresHumanConfirmation).toBe(true)

    const fullOnly = runConstraints(contextOf('输入里含 111'))
    expect(fullOnly.map((r) => r.constraintId)).toEqual(['ut-full'])
    expect(fullOnly[0].requiresHumanConfirmation).toBeUndefined()
  })

  it('状态流转：只有 active 的约束出现在 getActiveConstraints', () => {
    injectExternalConstraints([makeConstraint('ut-a', 'full', 1)])
    expect(getActiveConstraints().map((c) => c.id)).toEqual(['ut-a'])

    expect(updateConstraintStatus('ut-a', 'draft')).toBe(true)
    expect(getActiveConstraints()).toEqual([])
    expect(getAllConstraints()).toHaveLength(1)

    expect(updateConstraintStatus('ut-a', 'active')).toBe(true)
    expect(getActiveConstraints().map((c) => c.id)).toEqual(['ut-a'])

    expect(updateConstraintStatus('unknown-id', 'active')).toBe(false)
  })
})
