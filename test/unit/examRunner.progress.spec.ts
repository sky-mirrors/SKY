// EXAM-6 接口契约：createExamRunner 接受外部注入的 progress 对象，
// 闭包内全部相位改写落在注入对象上（供 reactive 代理接管 UI 刷新）。
import { describe, it, expect } from 'vitest'
import { createExamRunner, type ExamRunnerDeps, type ExamProgress } from '@/exam/examRunner'

const idleDeps: ExamRunnerDeps = {
  sendMessage: async () => '',
  getState: () => ({ isProcessing: false, paused: false, traceId: '', messages: [] }),
  judge: async () => '{"deliverable": true}',
  fileExists: async () => null,
  dirMatches: async () => null
}

describe('createExamRunner 注入 progress（EXAM-6）', () => {
  it('不注入时使用内部 progress（向后兼容）', async () => {
    const runner = createExamRunner(idleDeps)
    expect(runner.progress.phase).toBe('idle')
    const report = await runner.run({ cases: [], pollMs: 1, graceMs: 1 })
    expect(runner.progress.phase).toBe('done')
    expect(runner.progress.report).toBe(report)
  })

  it('注入的 progress 对象被闭包直接改写（同一引用）', async () => {
    const progress: ExamProgress = {
      phase: 'idle', current: 0, total: 0, currentLabel: '', currentStatus: '', report: null, errorMessage: ''
    }
    const runner = createExamRunner(idleDeps, { progress })

    expect(runner.progress).toBe(progress)

    const report = await runner.run({ cases: [], pollMs: 1, graceMs: 1 })

    expect(progress.phase).toBe('done')
    expect(progress.report).toBe(report)
    expect(runner.progress.phase).toBe('done')
  })
})
