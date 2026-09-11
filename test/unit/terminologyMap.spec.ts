import { describe, it, expect, vi } from 'vitest'
import { t, getAllTerms } from '@/services/terminologyMap'

describe('terminologyMap', () => {
  it('returns plain term by default', () => {
    expect(t('circuitBreaker')).toBe('连接保护')
  })

  it('returns technical term when style is technical', () => {
    expect(t('circuitBreaker', 'technical')).toBe('熔断器')
  })

  it('returns plain term when style is plain', () => {
    expect(t('circuitBreaker', 'plain')).toBe('连接保护')
  })

  it('returns key itself when term not found', () => {
    expect(t('unknownTerm')).toBe('unknownTerm')
  })

  it('maps all expected terms correctly', () => {
    expect(t('debugProbe', 'technical')).toBe('调试探针')
    expect(t('debugProbe', 'plain')).toBe('执行记录')
    expect(t('factGuard', 'technical')).toBe('FactGuard')
    expect(t('factGuard', 'plain')).toBe('事实校验')
    expect(t('dagPipeline', 'technical')).toBe('DAG流水线')
    expect(t('dagPipeline', 'plain')).toBe('多步工作流')
    expect(t('constraintConfirm', 'technical')).toBe('ConstraintConfirmCard')
    expect(t('constraintConfirm', 'plain')).toBe('高风险操作确认')
    expect(t('smartRouter', 'technical')).toBe('SmartRouter')
    expect(t('smartRouter', 'plain')).toBe('智能路由')
  })

  it('getAllTerms returns full map', () => {
    const map = getAllTerms()
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(18)
    expect(map.circuitBreaker).toEqual({ technical: '熔断器', plain: '连接保护' })
  })
})
