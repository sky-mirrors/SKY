import { describe, it, expect } from 'vitest'
import { runFactGuardV2 } from '@/services/factGuard'
import type { ExtractedEntity } from '@/models'

describe('runFactGuardV2', () => {
  const amountEntity: ExtractedEntity = {
    type: 'amount',
    raw: '60万元',
    normalized: '600000.00',
    confidence: 1,
    source: 'regex'
  }

  const dateEntity: ExtractedEntity = {
    type: 'date',
    raw: '2024年3月1日',
    normalized: '2024-03-01',
    confidence: 1,
    source: 'regex'
  }

  it('returns ok for matching entities with no constraint violations', () => {
    const groundTruth: ExtractedEntity[] = [amountEntity, dateEntity]
    const output: ExtractedEntity[] = [
      { ...amountEntity },
      { ...dateEntity }
    ]
    const result = runFactGuardV2(groundTruth, output, '合同金额60万元，日期2024年3月1日')
    expect(result.ok).toBe(true)
    expect(result.severity).toBe('ok')
    expect(result.layer1Entities).toHaveLength(2)
    expect(result.allConstraintResults).toBeDefined()
  })

  it('returns critical for mismatched amounts', () => {
    const groundTruth: ExtractedEntity[] = [amountEntity]
    const output: ExtractedEntity[] = [
      { type: 'amount', raw: '30万元', normalized: '300000.00', confidence: 1, source: 'regex' }
    ]
    const result = runFactGuardV2(groundTruth, output, '金额30万元')
    expect(result.severity).toBe('critical')
    expect(result.conflicts.length).toBeGreaterThan(0)
  })

  it('includes layer2 constraint results', () => {
    const groundTruth: ExtractedEntity[] = []
    const output: ExtractedEntity[] = []
    const text = '甲方应向乙方支付违约金60万元'
    const result = runFactGuardV2(groundTruth, output, text)
    expect(result.layer2ConstraintResults).toBeDefined()
    expect(Array.isArray(result.layer2ConstraintResults)).toBe(true)
  })

  it('includes layer3 cross-doc results when documents provided', () => {
    const groundTruth: ExtractedEntity[] = [amountEntity]
    const output: ExtractedEntity[] = [{ ...amountEntity }]
    const documents = [
      { docId: 'doc1', text: '合同金额60万元' },
      { docId: 'doc2', text: '合同金额60万元' }
    ]
    const result = runFactGuardV2(groundTruth, output, '金额60万元', documents)
    expect(result.layer3CrossDocResults).toBeDefined()
    expect(Array.isArray(result.layer3CrossDocResults)).toBe(true)
  })

  it('skips layer3 when no documents provided', () => {
    const result = runFactGuardV2([], [], '测试文本')
    expect(result.layer3CrossDocResults).toHaveLength(0)
  })

  it('detects hallucinated entities when source has no matching type', () => {
    const groundTruth: ExtractedEntity[] = [amountEntity]
    const output: ExtractedEntity[] = [
      { ...amountEntity },
      { type: 'percentage', raw: '5%', normalized: '5.00', confidence: 0.8, source: 'regex' }
    ]
    const result = runFactGuardV2(groundTruth, output, '金额60万元，涨幅5%')
    expect(result.hallucinatedEntities.length).toBeGreaterThan(0)
    expect(result.hallucinatedEntities[0].type).toBe('percentage')
  })

  it('auto-corrects minor conflicts', () => {
    const groundTruth: ExtractedEntity[] = [
      { type: 'person_name', raw: '张三', normalized: '张三', confidence: 1, source: 'regex' }
    ]
    const output: ExtractedEntity[] = [
      { type: 'person_name', raw: '张二', normalized: '张二', confidence: 0.9, source: 'regex' }
    ]
    const result = runFactGuardV2(groundTruth, output, '张二签署了合同')
    expect(result.severity).toBe('minor')
  })
})
