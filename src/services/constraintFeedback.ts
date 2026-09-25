import type { ConstraintResult, ConstraintFeedbackEntry, RuleStatus, ConstraintFeedbackStat } from '@/models'
import { getConstraintById, updateConstraintStatus } from './domainConstraints'
import { globalBus } from '@/kernel/bus'

const feedbackLog: ConstraintFeedbackEntry[] = []

/**
 * 自治阈值的**唯一来源**（2026-09-25 机制体检）：checkAutoDowngrade 的判据与
 * 审计快照 listConstraintStats 的动作预测必须取自同一处——否则面板显示的自治
 * 会与真实行为漂移（两处各写一份魔法数迟早对不上）。
 */
export const AUTONOMY_THRESHOLDS = {
  /** 自治动作所需的最小样本数 */
  minSamples: 10,
  /** 只看最近 N 条（自治的实际口径） */
  window: 100,
  /** 窗口误报率高于此值 → 自动禁用 */
  disableAbove: 0.3,
  /** 窗口误报率高于此值（且未达 disableAbove）→ 自动降级为 testing */
  downgradeAbove: 0.2
} as const

export const AUDIT_CHANNEL = 'debug:constraint-feedback'

/** 把当前自治审计快照广播出去；广播失败绝不影响主流程（审计是旁路） */
function broadcastAudit(): void {
  try {
    globalBus.emit(AUDIT_CHANNEL, listConstraintStats())
  } catch {
    /* 审计广播非关键路径 */
  }
}

export function recordFeedback(entry: ConstraintFeedbackEntry): void {
  feedbackLog.push(entry)
  checkAutoDowngrade(entry.constraintId)
  broadcastAudit()
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
    .slice(-AUTONOMY_THRESHOLDS.window)

  if (recent.length < AUTONOMY_THRESHOLDS.minSamples) return

  const falsePositives = recent.filter(f => f.isFalsePositive).length
  const fpRate = falsePositives / recent.length

  if (fpRate > AUTONOMY_THRESHOLDS.disableAbove) {
    disableConstraint(constraintId, `误报率超过${AUTONOMY_THRESHOLDS.disableAbove * 100}%，自动禁用`)
  } else if (fpRate > AUTONOMY_THRESHOLDS.downgradeAbove) {
    downgradeConstraint(constraintId, 'testing', `误报率超过${AUTONOMY_THRESHOLDS.downgradeAbove * 100}%，自动降级为testing`)
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

/**
 * 自治审计快照（2026-09-25）：把此前「写侧在跑、读侧零消费者」的自治结果
 * 变成可观测形态，供调试台「约束反馈自治」面板渲染。
 *
 * 口径与 checkAutoDowngrade **逐字对齐**：窗口取最近 AUTONOMY_THRESHOLDS.window 条、
 * 样本需 ≥ minSamples；autonomy 字段预测当前口径下自治会/已采取的动作。
 */
export function listConstraintStats(): ConstraintFeedbackStat[] {
  const ids = [...new Set(feedbackLog.map(f => f.constraintId))]
  return ids.map(constraintId => {
    const entries = feedbackLog.filter(f => f.constraintId === constraintId)
    const fp = entries.filter(f => f.isFalsePositive).length
    const recent = entries.slice(-AUTONOMY_THRESHOLDS.window)
    const recentFp = recent.filter(f => f.isFalsePositive).length
    const recentFalsePositiveRate = recent.length > 0 ? recentFp / recent.length : 0

    const constraint = getConstraintById(constraintId)
    let autonomy: ConstraintFeedbackStat['autonomy'] = 'none'
    if (recent.length >= AUTONOMY_THRESHOLDS.minSamples) {
      if (recentFalsePositiveRate > AUTONOMY_THRESHOLDS.disableAbove) autonomy = 'disable'
      else if (recentFalsePositiveRate > AUTONOMY_THRESHOLDS.downgradeAbove) autonomy = 'downgrade'
    }

    return {
      constraintId,
      totalEvaluations: entries.length,
      falsePositives: fp,
      truePositives: entries.length - fp,
      falsePositiveRate: entries.length > 0 ? fp / entries.length : 0,
      recentEvaluations: recent.length,
      recentFalsePositiveRate,
      status: constraint ? constraint.status : 'unknown',
      lastEvaluated: entries.length > 0 ? entries[entries.length - 1].timestamp : null,
      autonomy
    }
  })
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
  broadcastAudit()
}
