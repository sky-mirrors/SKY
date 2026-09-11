import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFeedback,
  getFeedbackLog,
  getFeedbackForConstraint,
  calculateFalsePositiveRate,
  calculateStatsForConstraint,
  processConstraintResults,
  clearFeedbackLog
} from '@/services/constraintFeedback'
import type { ConstraintFeedbackEntry, ConstraintResult } from '@/models'

vi.mock('@/services/domainConstraints', () => ({
  getConstraintById: vi.fn(() => ({ status: 'active' })),
  updateConstraintStatus: vi.fn()
}))

describe('constraintFeedback', () => {
  beforeEach(() => {
    clearFeedbackLog()
  })

  describe('recordFeedback', () => {
    it('records a feedback entry', () => {
      const entry: ConstraintFeedbackEntry = {
        constraintId: 'test-constraint',
        timestamp: Date.now(),
        reviewer: 'test-user',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: 'test',
        isFalsePositive: false
      }
      recordFeedback(entry)
      const log = getFeedbackLog()
      expect(log).toHaveLength(1)
      expect(log[0].constraintId).toBe('test-constraint')
    })
  })

  describe('getFeedbackForConstraint', () => {
    it('filters feedback by constraint ID', () => {
      recordFeedback({
        constraintId: 'c1',
        timestamp: Date.now(),
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: false
      })
      recordFeedback({
        constraintId: 'c2',
        timestamp: Date.now(),
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: false
      })
      recordFeedback({
        constraintId: 'c1',
        timestamp: Date.now(),
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: true
      })
      const c1Feedback = getFeedbackForConstraint('c1')
      expect(c1Feedback).toHaveLength(2)
      const c2Feedback = getFeedbackForConstraint('c2')
      expect(c2Feedback).toHaveLength(1)
    })
  })

  describe('calculateFalsePositiveRate', () => {
    it('returns 0 for no feedback', () => {
      expect(calculateFalsePositiveRate('no-such-constraint')).toBe(0)
    })

    it('calculates FP rate correctly', () => {
      for (let i = 0; i < 8; i++) {
        recordFeedback({
          constraintId: 'fp-test',
          timestamp: Date.now(),
          reviewer: 'test',
          action: 'triggered',
          fromStatus: null,
          toStatus: null,
          comment: '',
          isFalsePositive: i < 2
        })
      }
      const rate = calculateFalsePositiveRate('fp-test')
      expect(rate).toBe(0.25)
    })
  })

  describe('calculateStatsForConstraint', () => {
    it('returns empty stats for unknown constraint', () => {
      const stats = calculateStatsForConstraint('unknown')
      expect(stats.totalEvaluations).toBe(0)
      expect(stats.falsePositives).toBe(0)
      expect(stats.truePositives).toBe(0)
      expect(stats.falsePositiveRate).toBe(0)
      expect(stats.lastEvaluated).toBeNull()
    })

    it('calculates stats correctly', () => {
      recordFeedback({
        constraintId: 'stats-test',
        timestamp: 1000,
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: false
      })
      recordFeedback({
        constraintId: 'stats-test',
        timestamp: 2000,
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: true
      })
      recordFeedback({
        constraintId: 'stats-test',
        timestamp: 3000,
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: false
      })
      const stats = calculateStatsForConstraint('stats-test')
      expect(stats.totalEvaluations).toBe(3)
      expect(stats.falsePositives).toBe(1)
      expect(stats.truePositives).toBe(2)
      expect(stats.falsePositiveRate).toBeCloseTo(1 / 3)
      expect(stats.lastEvaluated).toBe(3000)
    })
  })

  describe('processConstraintResults', () => {
    it('records feedback for triggered results', () => {
      const results: ConstraintResult[] = [
        {
          triggered: true,
          constraintId: 'legal-employment-protection',
          severity: 'error',
          message: '违反保护期规定',
          reliability: {
            confidence: 'high',
            source: {
              type: 'law',
              name: '劳动合同法',
              article: '第四十二条',
              effectiveDate: '2008-01-01'
            }
          }
        },
        {
          triggered: false,
          constraintId: 'legal-labor-dispatch',
          severity: 'info',
          message: '通过',
          reliability: { confidence: 'high', source: { type: 'law', name: '', article: '', effectiveDate: '' } }
        }
      ]
      processConstraintResults(results, 'doc-123')
      const log = getFeedbackLog()
      expect(log).toHaveLength(1)
      expect(log[0].constraintId).toBe('legal-employment-protection')
      expect(log[0].documentId).toBe('doc-123')
    })
  })

  describe('auto-downgrade', () => {
    it('does not downgrade with low FP rate', () => {
      for (let i = 0; i < 10; i++) {
        recordFeedback({
          constraintId: 'safe-constraint',
          timestamp: Date.now(),
          reviewer: 'test',
          action: 'triggered',
          fromStatus: null,
          toStatus: null,
          comment: '',
          isFalsePositive: i < 1
        })
      }
    })
  })

  describe('clearFeedbackLog', () => {
    it('clears all feedback entries', () => {
      recordFeedback({
        constraintId: 'c1',
        timestamp: Date.now(),
        reviewer: 'test',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: '',
        isFalsePositive: false
      })
      expect(getFeedbackLog()).toHaveLength(1)
      clearFeedbackLog()
      expect(getFeedbackLog()).toHaveLength(0)
    })
  })
})
