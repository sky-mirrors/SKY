// EXAM-1 + EXAM-6（修复批）：考试状态迁 Pinia store 回归测试。
// - EXAM-6：progress 为 reactive 代理注入 runner——闭包改写触发 UI 重渲染（watch 可观测）
// - EXAM-1：模式切换孤儿化消除——runner/store 生命周期与组件解耦；完成即落盘 vault，刷新可恢复
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { vault } from '@/vault'
import { EXAM_CASES } from '@/exam/examCases'
import { EXAM_CASES_V2 } from '@/exam/examCasesV2'

// 可控假 runner：createExamRunner 被 mock，run 内改写注入的 progress 对象
const { createExamRunnerMock } = vi.hoisted(() => {
  return { createExamRunnerMock: vi.fn() }
})

vi.mock('@/exam/examRunner', () => ({
  createExamRunner: createExamRunnerMock,
  createDefaultExamDeps: vi.fn(() => ({}) as never)
}))

import { useExamStore } from '@/stores/examStore'
import type { ExamReport, ExamRunner, ExamProgress } from '@/exam/examRunner'

function makeReport(deliverable = 1): ExamReport {
  return {
    spec: 'ACCEPTANCE-SPEC v1.0',
    judgePromptVersion: 'EXAM_JUDGE_PROMPT_V1',
    startedAt: 1000,
    finishedAt: 2000,
    passLines: { deliverableRate: 0.8, zeroInterventionRate: 0.6, avgDurationMs: 120000 },
    summary: {
      total: 2, graded: 2, skippedFixture: 0, deliverable,
      deliverableRate: deliverable / 2, zeroIntervention: 2, zeroInterventionRate: 1,
      avgDurationMs: 5000, totalTokens: 100
    },
    questions: [
      { id: 'Q1', title: 't', category: 'translation' as never, status: 'done', durationMs: 1000, interventions: 0, routeKind: 'l0', hardAssertPassed: true, hardAssertNote: '', judgeVerdict: 'deliverable', judgeNote: '', failureStage: null, traceId: 'tr1', replyExcerpt: 'x', totalTokens: 50 },
      { id: 'Q2', title: 't', category: 'writing' as never, status: 'done', durationMs: 2000, interventions: 0, routeKind: 'l0', hardAssertPassed: true, hardAssertNote: '', judgeVerdict: 'deliverable', judgeNote: '', failureStage: null, traceId: 'tr2', replyExcerpt: 'y', totalTokens: 50 }
    ],
    notes: []
  }
}

interface FakeRunnerOptions {
  progress?: ExamProgress
}

function installFakeRunner(finalPhase: ExamProgress['phase'], report: ExamReport | null): { runner: ExamRunner; runMock: ReturnType<typeof vi.fn>; cancelMock: ReturnType<typeof vi.fn> } {
  const runMock = vi.fn(async () => {
    const p = (createExamRunnerMock.mock.calls[createExamRunnerMock.mock.calls.length - 1] as unknown as [unknown, FakeRunnerOptions])[1]?.progress
    if (p) {
      p.phase = 'running'
      p.current = 1
      p.total = 2
      // 让出一拍：确保 watch 逐相位观测（Vue 同 tick 批量刷新会合并连续改写）
      await new Promise(r => setTimeout(r, 0))
      p.phase = finalPhase
      if (report) p.report = report
    }
    return report
  })
  const cancelMock = vi.fn()
  const runner: ExamRunner = {
    progress: {} as ExamProgress,
    run: runMock,
    cancel: cancelMock,
    exportReport: vi.fn(async () => 'C:\\fake\\exam-report.json')
  }
  createExamRunnerMock.mockImplementation((_deps: unknown, options?: FakeRunnerOptions) => {
    if (options?.progress) runner.progress = options.progress
    return runner
  })
  return { runner, runMock, cancelMock }
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0))
  }
}

describe('EXAM-1/EXAM-6：examStore（考试状态迁 Pinia + reactive 进度 + 完成即落盘）', () => {
  let vaultWriteMock: ReturnType<typeof vi.fn>
  let vaultDeleteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vault.clearCache()
    vaultWriteMock = vi.fn().mockResolvedValue(undefined)
    vaultDeleteMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vaultWriteMock,
        vaultDelete: vaultDeleteMock,
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0))
    setActivePinia(createPinia())
    createExamRunnerMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('EXAM-6：progress 为 reactive 代理注入 runner——闭包改写触发 watch（UI 冻结病理消除）', async () => {
    const examStore = useExamStore()
    installFakeRunner('done', makeReport())

    const observedPhases: string[] = []
    const stop = watch(() => examStore.progress.phase, p => observedPhases.push(p))

    examStore.startExam(true)
    await flushAsync()

    // 注入的就是 store 的 reactive progress（同源对象）
    const callOptions = (createExamRunnerMock.mock.calls[0] as unknown as [unknown, FakeRunnerOptions])[1]
    expect(callOptions?.progress).toBe(examStore.progress)
    // watch 观测到 running → done 的完整相位流（此前 EXAM-6：raw 对象改写零触发）
    expect(observedPhases).toContain('running')
    expect(observedPhases[observedPhases.length - 1]).toBe('done')
    stop()
  })

  it('EXAM-1：完成即落盘——run 收口后 report 立即写 vault（done）', async () => {
    const examStore = useExamStore()
    const report = makeReport()
    installFakeRunner('done', report)

    examStore.startExam(true)
    await flushAsync()

    expect(vaultWriteMock).toHaveBeenCalledWith('exam', 'holo-exam-report', JSON.stringify(report), undefined)
    expect(examStore.lastPersistedAt).toBeGreaterThan(0)
  })

  it('EXAM-1：cancelled 中止也持久化成绩单（已完成题目仍计入）', async () => {
    const examStore = useExamStore()
    const report = makeReport(1)
    installFakeRunner('cancelled', report)

    examStore.startExam(true)
    await flushAsync()

    expect(examStore.progress.phase).toBe('cancelled')
    expect(vaultWriteMock).toHaveBeenCalledWith('exam', 'holo-exam-report', JSON.stringify(report), undefined)
  })

  it('EXAM-1：restoreFromVault——重启后从 vault 恢复上次成绩单（phase=done）', () => {
    const report = makeReport()
    vault.writeCache('exam', 'holo-exam-report', JSON.stringify(report))

    const examStore = useExamStore()

    expect(examStore.progress.phase).toBe('done')
    expect(examStore.progress.report?.summary.deliverable).toBe(1)
    expect(examStore.progress.total).toBe(2)
    expect(examStore.progress.current).toBe(2)
  })

  it('restoreFromVault：vault 无数据时保持 idle（首启新装形态）', () => {
    const examStore = useExamStore()
    expect(examStore.progress.phase).toBe('idle')
    expect(examStore.progress.report).toBeNull()
  })

  it('running 期间重复 startExam 被拒（不创建第二个 runner）', () => {
    const examStore = useExamStore()
    const { runner } = installFakeRunner('running', null)

    examStore.startExam(true)
    expect(createExamRunnerMock).toHaveBeenCalledTimes(1)
    expect(examStore.hasRunner).toBe(true)

    examStore.startExam(true)
    expect(createExamRunnerMock).toHaveBeenCalledTimes(1)
    expect(examStore.progress.phase).toBe('running')
    expect(runner.cancel).not.toHaveBeenCalled()
  })

  it('cancel 透传 runner.cancel（中止按钮响应性不受组件生命周期影响）', () => {
    const examStore = useExamStore()
    const { cancelMock } = installFakeRunner('running', null)

    examStore.startExam(true)
    examStore.cancel()
    expect(cancelMock).toHaveBeenCalledTimes(1)
  })

  it('exportReport：runner 缺席时退化为 progress.report 直接落 Desktop 文件', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
        resolvePath: vi.fn().mockResolvedValue('C:\\Users\\test'),
        fileWrite: vi.fn().mockResolvedValue({ success: true })
      }
    })
    const report = makeReport()
    vault.writeCache('exam', 'holo-exam-report', JSON.stringify(report))

    const examStore = useExamStore()
    expect(examStore.progress.phase).toBe('done')

    const path = await examStore.exportReport()
    expect(path).toBe('C:\\Users\\test\\Desktop\\HoloStarmap\\exam-report.json')
    const fileWrite = (window as unknown as { electronAPI: { fileWrite: ReturnType<typeof vi.fn> } }).electronAPI.fileWrite
    expect(JSON.parse(fileWrite.mock.calls[0][0].content).summary.deliverable).toBe(1)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Wave 2（2026-09-30）：题库册别透传
//
// 此前 startExam 从不传 cases，runner 落回默认 EXAM_CASES（V1 18 题）——
// 写好的 V2 题库（50 题）因此没有任何生产入口。这两条钉住册别确实传到位：
// 回滚 `cases: casesBySet[caseSet]` 这一句即变红。
// ─────────────────────────────────────────────────────────────────────────────

describe('题库册别 · startExam 透传 cases', () => {
  // 本 describe 与文件上方那个是平行的顶层 describe，它自带的 beforeEach/afterEach
  // 不会套用到这里——不补下面这组，store 状态会跨 use-case 泄漏（activeCaseSet 残留）。
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
    setActivePinia(createPinia())
    createExamRunnerMock.mockReset()
  })
  it('选 v2 时 run 收到 EXAM_CASES_V2（50 题）', async () => {
    const examStore = useExamStore()
    const { runMock } = installFakeRunner('done', makeReport())

    examStore.startExam(true, 'v2')
    await flushAsync()

    const arg = runMock.mock.calls[0][0] as { cases?: unknown[] }
    expect(arg.cases).toBe(EXAM_CASES_V2)
    expect(arg.cases!.length).toBe(50)
    expect(examStore.activeCaseSet).toBe('v2')
  })

  it('缺省为 v1 —— 历轮 18 题成绩的可比性不受影响', async () => {
    const examStore = useExamStore()
    const { runMock } = installFakeRunner('done', makeReport())

    expect(examStore.activeCaseSet).toBe('v1')
    examStore.startExam(true)
    await flushAsync()

    const arg = runMock.mock.calls[0][0] as { cases?: unknown[] }
    expect(arg.cases).toBe(EXAM_CASES)
    expect(arg.cases!.length).toBe(18)
  })

  it('显式传 v1 与缺省等价', async () => {
    const examStore = useExamStore()
    const { runMock } = installFakeRunner('done', makeReport())

    examStore.startExam(true, 'v1')
    await flushAsync()

    expect((runMock.mock.calls[0][0] as { cases?: unknown[] }).cases).toBe(EXAM_CASES)
  })
})
