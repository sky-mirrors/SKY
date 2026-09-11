import type { ConstraintResult, ConstraintFeedbackEntry, RuleStatus } from '@/models'
import { getConstraintById, updateConstraintStatus } from './domainConstraints'

const feedbackLog: ConstraintFeedbackEntry[] = []

export function recordFeedback(entry: ConstraintFeedbackEntry): void {
  feedbackLog.push(entry)
  checkAutoDowngrade(entry.constraintId)
}

export function getFeedbackLog(): ConstraintFeedbackEntry[] {
  return [...feedbackLog]
}

export function getFeedbackForConstraint(constraintId: string): ConstraintFeedbackEntry[] {
  return feedbackLog.filter(f => f.constraintId === constraintId)
}

function checkAutoDowngrade(constraintId: string): void {
  const recent = feedbackLog
    .filter(f => f.constraintId === constraintId)
    .slice(-100)

  if (recent.length < 10) return

  const falsePositives = recent.filter(f => f.isFalsePositive).length
  const fpRate = falsePositives / recent.length

  if (fpRate > 0.3) {
    disableConstraint(constraintId, '误报率超过30%，自动禁用')
  } else if (fpRate > 0.2) {
    downgradeConstraint(constraintId, 'testing', '误报率超过20%，自动降级为testing')
  }
}

function disableConstraint(constraintId: string, reason: string): void {
  const constraint = getConstraintById(constraintId)
  if (constraint && constraint.status !== 'deprecated') {
    updateConstraintStatus(constraintId, 'deprecated')
    recordFeedback({
      constraintId,
      timestamp: Date.now(),
      reviewer: 'auto-downgrade',
      action: 'status_change',
      fromStatus: constraint.status,
      toStatus: 'deprecated',
      comment: reason,
      isFalsePositive: false
    })
  }
}

function downgradeConstraint(constraintId: string, targetStatus: RuleStatus, reason: string): void {
  const constraint = getConstraintById(constraintId)
  if (constraint && constraint.status !== targetStatus && constraint.status !== 'deprecated') {
    updateConstraintStatus(constraintId, targetStatus)
    recordFeedback({
      constraintId,
      timestamp: Date.now(),
      reviewer: 'auto-downgrade',
      action: 'status_change',
      fromStatus: constraint.status,
      toStatus: targetStatus,
      comment: reason,
      isFalsePositive: false
    })
  }
}

export function calculateFalsePositiveRate(constraintId: string): number {
  const entries = feedbackLog.filter(f => f.constraintId === constraintId)
  if (entries.length === 0) return 0
  const fpCount = entries.filter(f => f.isFalsePositive).length
  return fpCount / entries.length
}

export function calculateStatsForConstraint(constraintId: string): {
  totalEvaluations: number
  falsePositives: number
  truePositives: number
  falsePositiveRate: number
  lastEvaluated: number | null
} {
  const entries = feedbackLog.filter(f => f.constraintId === constraintId)
  const fp = entries.filter(f => f.isFalsePositive).length
  return {
    totalEvaluations: entries.length,
    falsePositives: fp,
    truePositives: entries.length - fp,
    falsePositiveRate: entries.length > 0 ? fp / entries.length : 0,
    lastEvaluated: entries.length > 0 ? entries[entries.length - 1].timestamp : null
  }
}

export function processConstraintResults(
  results: ConstraintResult[],
  documentId?: string
): void {
  for (const result of results) {
    if (result.triggered) {
      recordFeedback({
        constraintId: result.constraintId,
        timestamp: Date.now(),
        reviewer: 'system',
        action: 'triggered',
        fromStatus: null,
        toStatus: null,
        comment: result.message,
        isFalsePositive: false,
        documentId
      })
    }
  }
}

export function clearFeedbackLog(): void {
  feedbackLog.length = 0
}
