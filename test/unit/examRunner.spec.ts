import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createExamRunner, extractNumbers, parseJudgeReply, type ExamRunnerDeps } from '@/exam/examRunner'
import type { ExamCase } from '@/exam/examCases'
import { globalBus } from '@/kernel/bus'

function makeCase(overrides?: Partial<ExamCase>): ExamCase {
  return {
    id: 'T1',
    category: 'data',
    title: '测试题',
    prompt: '算 1+1 等于几',
    assertions: [{ kind: 'number', expected: 2, tolerance: 0 }],
    judgeHint: '答案为 2',
    ...overrides
  }
}

interface FakeBehavior {
  reply?: string
  busyMs?: number
  busyForever?: boolean
  appendReply?: boolean
  judgeReply?: string
}

function makeFakeDeps(behavior: FakeBehavior = {}): ExamRunnerDeps {
  const state = {
    isProcessing: false,
    paused: false,
    traceId: '',
    messages: [] as { role: string; content: string; timestamp: number }[]
  }
  return {
    sendMessage: async () => {
      state.isProcessing = true
      state.traceId = 'trace-fake'
      setTimeout(() => {
        state.isProcessing = false
        if (behavior.appendReply !== false && behavior.reply !== undefined) {
          state.messages.push({ role: 'assistant', content: behavior.reply, timestamp: Date.now() })
        }
      }, behavior.busyForever ? 100000 : (behavior.busyMs ?? 50))
      return ''
    },
    getState: () => ({ isProcessing: state.isProcessing, paused: state.paused, traceId: state.traceId, messages: [...state.messages] }),
    judge: async () => behavior.judgeReply ?? '{"deliverable": true}',
    fileExists: async () => true,
    dirMatches: async () => true
  }
}

const fastTiming = { pollMs: 10, graceMs: 40 }

describe('examRunner 数值提取 extractNumbers', () => {
  it('千分位逗号与万单位归一化', () => {
    expect(extractNumbers('报销总额是2,278元')).toContain(2278)
    expect(extractNumbers('每天违约金0.09万')).toContain(900)
    expect(extractNumbers('环比增长约12.5%')).toContain(12.5)
    expect(extractNumbers('结果是 7,006,652')).toContain(7006652)
    expect(extractNumbers('没有数字')).toEqual([])
  })
})

describe('examRunner 判卷输出解析 parseJudgeReply', () => {
  it('裸 JSON 与 markdown 围栏 JSON 均可解析', () => {
    expect(parseJudgeReply('{"deliverable": true}')).toEqual({ deliverable: true, note: '' })
    expect(parseJudgeReply('```json\n{"deliverable": false, "note": "答数错误"}\n```')).toEqual({ deliverable: false, note: '答数错误' })
    expect(parseJudgeReply('前置说明 {"deliverable": true} 后缀')).toEqual({ deliverable: true, note: '' })
  })

  it('缺 deliverable 布尔字段或非 JSON 返回 null', () => {
    expect(parseJudgeReply('{"note": "无判断"}')).toBeNull()
    expect(parseJudgeReply('完全不是JSON')).toBeNull()
  })
})

describe('examRunner 考试流程（注入依赖）', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正常完成：硬断言+判卷通过 → done、可交付、零干预', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase(), makeCase({ id: 'T2', title: '第二题' })]
    })
    expect(report).not.toBeNull()
    expect(report!.questions).toHaveLength(2)
    expect(report!.questions.every(q => q.status === 'done')).toBe(true)
    expect(report!.summary.graded).toBe(2)
    expect(report!.summary.deliverable).toBe(2)
    expect(report!.summary.deliverableRate).toBe(1)
    expect(report!.summary.zeroInterventionRate).toBe(1)
    expect(report!.summary.avgDurationMs).toBeGreaterThan(0)
    expect(runner.progress.phase).toBe('done')
  })

  it('素材依赖题在 fixtureReady=false 时跳过且不入分母', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000, fixtureReady: false,
      cases: [makeCase({ requiresFixture: true }), makeCase({ id: 'T2' })]
    })
    expect(report!.questions[0].status).toBe('skipped-fixture')
    expect(report!.questions[0].judgeVerdict).toBe('skipped')
    expect(report!.summary.graded).toBe(1)
    expect(report!.summary.skippedFixture).toBe(1)
    expect(report!.summary.deliverableRate).toBe(1)
    expect(report!.notes.some(n => n.includes('素材依赖题跳过'))).toBe(true)
  })

  it('暂停点事件计入干预数；干预计入后零干预率为 0', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    // 在题目执行窗口内注入一次暂停点（模拟用户在确认条上裁决）
    setTimeout(() => {
      globalBus.emit('dialog:pause-acquired', { point: 'confirmation', traceId: 'trace-fake', ts: Date.now() })
    }, 20)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase()]
    })
    expect(report!.questions[0].interventions).toBe(1)
    expect(report!.summary.zeroInterventionRate).toBe(0)
    expect(report!.summary.deliverableRate).toBe(1)
  })

  it('监考归因：record-cost 按 traceId 窗口聚合 token；funnel:routed 记录路径', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    setTimeout(() => {
      globalBus.emit('debug:record-cost', { totalTokens: 120, traceId: 'trace-fake' })
      globalBus.emit('funnel:routed', { kind: 'plan', traceId: 'trace-fake' })
    }, 20)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase()]
    })
    expect(report!.questions[0].totalTokens).toBe(120)
    expect(report!.questions[0].routeKind).toBe('plan')
    expect(report!.summary.totalTokens).toBe(120)
  })

  it('超时：处理晚于超时窗结束且无回复 → status=timeout，不入 graded', async () => {
    const deps = makeFakeDeps({ busyMs: 300, appendReply: false })
    const runner = createExamRunner(deps)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 200,
      cases: [makeCase()]
    })
    expect(report!.questions[0].status).toBe('timeout')
    expect(report!.summary.graded).toBe(0)
    expect(report!.summary.deliverableRate).toBe(0)
  })

  it('超时且系统仍忙（排水失败）→ run 报错中止，phase=error', async () => {
    const deps = makeFakeDeps({ busyForever: true })
    const runner = createExamRunner(deps)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 100,
      cases: [makeCase()]
    })
    expect(runner.progress.phase).toBe('error')
    expect(runner.progress.errorMessage).toContain('T1')
    expect(report).not.toBeNull()
    expect(report!.summary.graded).toBe(0)
  })

  it('硬断言失败 → 不可交付且失败幕=输出；判卷不可解析 → judge-error 不判可交付', async () => {
    const deps = makeFakeDeps({ reply: '答案是三', judgeReply: '我拒绝输出JSON' })
    const runner = createExamRunner(deps)
    setTimeout(() => {
      globalBus.emit('funnel:routed', { kind: 'plan', traceId: 'trace-fake' })
    }, 20)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase()]
    })
    const q = report!.questions[0]
    expect(q.hardAssertPassed).toBe(false)
    expect(q.judgeVerdict).toBe('judge-error')
    expect(report!.summary.deliverable).toBe(0)
    expect(q.failureStage).toBe('output')
  })

  it('判卷 not-deliverable 且无干预 → 失败幕=输出', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。', judgeReply: '{"deliverable": false, "note": "结构不清晰"}' })
    const runner = createExamRunner(deps)
    setTimeout(() => {
      globalBus.emit('funnel:routed', { kind: 'plan', traceId: 'trace-fake' })
    }, 20)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase()]
    })
    const q = report!.questions[0]
    expect(q.judgeVerdict).toBe('not-deliverable')
    expect(q.failureStage).toBe('output')
    expect(report!.summary.deliverable).toBe(0)
  })

  it('cancel：中止后未执行题不计、phase=cancelled', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    const runPromise = runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase(), makeCase({ id: 'T2' })]
    })
    setTimeout(() => runner.cancel(), 5)
    const report = await runPromise
    expect(runner.progress.phase).toBe('cancelled')
    expect(report!.questions.length).toBeLessThan(2)
  })

  it('成绩单含及格线与决策记录 notes', async () => {
    const deps = makeFakeDeps({ reply: '1+1 等于 2。' })
    const runner = createExamRunner(deps)
    const report = await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [makeCase()]
    })
    expect(report!.passLines).toEqual({ deliverableRate: 0.8, zeroInterventionRate: 0.6, avgDurationMs: 120000 })
    expect(report!.judgePromptVersion).toBe('EXAM_JUDGE_PROMPT_V1')
    expect(report!.notes.some(n => n.includes('指纹缓存未隔离'))).toBe(true)
    expect(report!.notes.some(n => n.includes('record-cost 照常记账'))).toBe(true)
  })
})
