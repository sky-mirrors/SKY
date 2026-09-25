import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFeedback,
  clearFeedbackLog,
  listConstraintStats,
  AUTONOMY_THRESHOLDS
} from '@/services/constraintFeedback'
import { globalBus } from '@/kernel/bus'
import type { ConstraintFeedbackEntry } from '@/models'

/**
 * HANDOFF 卡点 4 / 机制体检（2026-09-25）：constraintFeedback 的自治
 * （误报率 >30% 自动禁用 / >20% 自动降级，样本 ≥10）写侧是活的
 * （factGuard → processConstraintResults → recordFeedback → checkAutoDowngrade），
 * 但 calculateStatsForConstraint / getFeedbackLog 全仓零消费者 ⇒
 * **自治在跑、结果却无处可见、无法审计**。
 *
 * 本文件把「审计快照 listConstraintStats 存在、且口径与自治逐字一致」钉成契约。
 * 关键：审计必须用**自治实际使用的窗口口径**（最近 N 条、样本 ≥10），
 * 否则面板会与自治行为不一致（显示安全、实则已被禁用）。
 */

// getConstraintById 返回 undefined ⇒ 自治的 disable/downgrade 落为空操作，
// 便于精确控制反馈日志、单独验证「审计口径」这一层（自治行为本身另有 spec 覆盖）。
vi.mock('@/services/domainConstraints', () => ({
  getConstraintById: vi.fn(() => undefined),
  updateConstraintStatus: vi.fn(() => true)
}))

function push(constraintId: string, isFalsePositive: boolean, timestamp = Date.now()): void {
  const entry: ConstraintFeedbackEntry = {
    constraintId, timestamp, reviewer: 'test', action: 'triggered',
    fromStatus: null, toStatus: null, comment: '', isFalsePositive
  }
  recordFeedback(entry)
}

describe('listConstraintStats —— 自治审计快照', () => {
  beforeEach(() => {
    clearFeedbackLog()
  })

  it('无反馈时返回空数组', () => {
    expect(listConstraintStats()).toEqual([])
  })

  it('样本不足（<10）时自治不动作（autonomy=none），即便全误报', () => {
    for (let i = 0; i < 5; i++) push('few', true)
    const [s] = listConstraintStats()
    expect(s.constraintId).toBe('few')
    expect(s.totalEvaluations).toBe(5)
    expect(s.falsePositives).toBe(5)
    expect(s.autonomy).toBe('none')
  })

  it('样本 ≥10 且窗口误报率 >30% → autonomy=disable', () => {
    for (let i = 0; i < 10; i++) push('bad', true)
    const [s] = listConstraintStats()
    expect(s.recentEvaluations).toBe(10)
    expect(s.recentFalsePositiveRate).toBeCloseTo(1)
    expect(s.autonomy).toBe('disable')
  })

  it('样本 ≥10 且 20% < 窗口误报率 ≤30% → autonomy=downgrade', () => {
    for (let i = 0; i < 20; i++) push('mid', i < 5) // 5/20 = 0.25
    const [s] = listConstraintStats()
    expect(s.recentEvaluations).toBe(20)
    expect(s.recentFalsePositiveRate).toBeCloseTo(0.25)
    expect(s.autonomy).toBe('downgrade')
  })

  it('窗口口径与自治一致：累计率高但最近窗口干净 ⇒ autonomy=none', () => {
    // 前 30 条误报（早于窗口），后 100 条正常 ⇒ 窗口（最近 100）全干净
    for (let i = 0; i < 30; i++) push('recovers', true)
    for (let i = 0; i < 100; i++) push('recovers', false)
    const [s] = listConstraintStats()
    expect(s.totalEvaluations).toBe(130)
    expect(s.falsePositiveRate).toBeCloseTo(30 / 130) // 累计率仍 >20%
    expect(s.recentEvaluations).toBe(AUTONOMY_THRESHOLDS.window) // 窗口截断到 100
    expect(s.recentFalsePositiveRate).toBe(0) // 窗口口径已恢复
    expect(s.autonomy).toBe('none') // ⇒ 自治不会动作——这正是累计口径会误报之处
  })

  it('多约束按 constraintId 分组，各取各的统计', () => {
    for (let i = 0; i < 3; i++) push('a', true)
    for (let i = 0; i < 2; i++) push('b', false)
    const stats = listConstraintStats()
    expect(stats.map(s => s.constraintId).sort()).toEqual(['a', 'b'])
    expect(stats.find(s => s.constraintId === 'a')!.falsePositives).toBe(3)
    expect(stats.find(s => s.constraintId === 'b')!.falsePositives).toBe(0)
  })
})

describe('自治审计广播 —— 让「看不见」变成「看得到」', () => {
  beforeEach(() => {
    clearFeedbackLog()
  })

  it('recordFeedback 会广播 debug:constraint-feedback 快照', () => {
    const received: unknown[] = []
    const dispose = globalBus.on('debug:constraint-feedback', (p: unknown) => received.push(p))
    try {
      push('broadcast', true)
    } finally {
      dispose()
    }
    expect(received.length).toBeGreaterThan(0)
    const last = received[received.length - 1]
    expect(Array.isArray(last)).toBe(true)
    expect((last as { constraintId: string }[])[0].constraintId).toBe('broadcast')
  })

  it('clearFeedbackLog 也会广播（面板需随之清空）', () => {
    const received: unknown[] = []
    const dispose = globalBus.on('debug:constraint-feedback', (p: unknown) => received.push(p))
    try {
      clearFeedbackLog()
    } finally {
      dispose()
    }
    expect(received.length).toBeGreaterThan(0)
    expect(received[received.length - 1]).toEqual([])
  })
})
