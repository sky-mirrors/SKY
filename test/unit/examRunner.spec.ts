import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPinia, setActivePinia } from 'pinia'
import { createExamRunner, createDefaultExamDeps, extractNumbers, parseJudgeReply, type ExamRunnerDeps } from '@/exam/examRunner'
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

// ─────────────────────────────────────────────────────────────────────────────
// dirPattern · every / some 两态（2026-09-30 Wave 1）
//
// 背景：dirMatches 生成的脚本用 `f.every(x => re.test(x))`——要求目录内**每个**
// 文件都匹配。V1 Q15（批量重命名）依赖这个语义：只有残留 img0.jpg 未被改名时
// 才判 NO，这是该题的鉴别力来源（RUNBOOK §一 明文「要求目录内每个文件都匹配」）。
//
// 但 V2 的产物类断言按「目录里出现了某产物」的意图写（judgeHint 亦如此声明），
// 而源文件与产物共存是常态 ⇒ every 恒假。故给 dirPattern 加可选 mode（缺省 every），
// V2 产物类断言显式写 some。本组测试钉住两态各自的行为，以及 V1 缺省不被放宽。
//
// 取值路径刻意走真实的 createDefaultExamDeps()（而非手写等价逻辑），
// 由 stub 的 shellExec 把生成的 command 解析后真跑 node——mock 不掩盖接线。
// ─────────────────────────────────────────────────────────────────────────────

describe('dirPattern · mode（every 缺省 / some 显式）', () => {
  let tmpRoots: string[] = []

  function makeDir(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'dirmatch-'))
    tmpRoots.push(dir)
    for (const f of files) writeFileSync(join(dir, f), 'x')
    return dir
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    tmpRoots = []
    vi.stubGlobal('window', {
      electronAPI: {
        // 真实执行 shellExec 收到的 command：从 `node -e "<script>" "<dir>" "<pattern>"`
        // 剥离出 script 与两个参数，再用 execFileSync 直跑（绕开 Windows cmd 引号规则
        // 的干扰——那是环境问题，不是本改动要测的东西）。
        shellExec: async ({ command }: { command: string }) => {
          const m = /^node -e "([\s\S]*)" "([^"]*)" "([^"]*)"$/.exec(command)
          if (!m) return { stdout: '' }
          const out = execFileSync(process.execPath, ['-e', m[1], m[2], m[3]], { encoding: 'utf8' })
          return { stdout: out }
        },
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
  })

  afterEach(() => {
    for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('some：源文件与产物共存时判真（V2-M01 的真实形态）', async () => {
    const dir = makeDir(['sample.jpg', 'sample-200.webp'])
    const deps = createDefaultExamDeps()
    expect(await deps.dirMatches(dir, '\\.webp$', 'some')).toBe(true)
    // 同一目录下 every 判假——这正是原缺陷
    expect(await deps.dirMatches(dir, '\\.webp$', 'every')).toBe(false)
  })

  it('every（缺省）：全匹配才判真——V1 Q15 的鉴别力不得被放宽', async () => {
    const dir = makeDir(['20191207-01.jpg'])
    const deps = createDefaultExamDeps()
    expect(await deps.dirMatches(dir, '^\\d{8}-\\d{2}\\.(jpg|jpeg|png)$')).toBe(true)
    // 残留一个未改名的源文件 ⇒ 必须判假（Q15 的判据）
    writeFileSync(join(dir, 'img0.jpg'), 'x')
    expect(await deps.dirMatches(dir, '^\\d{8}-\\d{2}\\.(jpg|jpeg|png)$')).toBe(false)
  })

  it('assertion 上的 mode 原样透传给 deps.dirMatches（缺省时传 undefined）', async () => {
    const seen: Array<string | undefined> = []
    const deps = makeFakeDeps({ reply: '产物已生成' })
    deps.dirMatches = async (_dir: string, _pattern: string, mode?: string) => {
      seen.push(mode)
      return true
    }
    const runner = createExamRunner(deps)
    await runner.run({
      ...fastTiming, timeoutMsPerQuestion: 5000,
      cases: [
        makeCase({ assertions: [{ kind: 'dirPattern', dir: 'D:\\photos', pattern: '\\.webp$', mode: 'some' }] }),
        makeCase({ id: 'T2', assertions: [{ kind: 'dirPattern', dir: 'D:\\out', pattern: 'a$' }] })
      ]
    })
    expect(seen).toEqual(['some', undefined])
  })
})
