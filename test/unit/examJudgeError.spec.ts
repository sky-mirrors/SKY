import { describe, it, expect, vi } from 'vitest'
import { createExamRunner, type ExamRunnerDeps } from '@/exam/examRunner'
import type { ExamCase } from '@/exam/examCases'

function makeCase(id: string): ExamCase {
  return {
    id,
    title: `题 ${id}`,
    category: 'doc',
    prompt: `请处理 ${id}`,
    judgeHint: 'hint',
    assertions: [],
  } as unknown as ExamCase
}

/** 依赖注入的假 deps：sendMessage 会往 messages 里追加一条 assistant 回复 */
function makeDeps(replyFor: Record<string, string>, judge: (p: string) => Promise<string>): { deps: ExamRunnerDeps; messages: { role: string; content: string; timestamp: number }[] } {
  const messages: { role: string; content: string; timestamp: number }[] = []
  let current = ''
  const deps: ExamRunnerDeps = {
    sendMessage: async () => {
      messages.push({ role: 'assistant', content: replyFor[current] ?? '回复', timestamp: Date.now() })
      return ''
    },
    getState: () => ({ isProcessing: false, paused: false, traceId: `t-${current}`, messages }),
    judge,
    fileExists: async () => null,
    dirMatches: async () => null,
  }
  // 记录当前题目，供 sendMessage 取对应回复
  ;(deps as unknown as { __setCurrent: (id: string) => void }).__setCurrent = (id: string) => { current = id }
  return { deps, messages }
}

describe('X-1: 判卷失败（judge-error）不得并入可交付率分母', () => {
  it('判卷抛错(judge-error) + 另一题判为可交付 → 可交付率按「可判题」算，并单列 judgeErrors', async () => {
    const cases = [makeCase('QA'), makeCase('QB')]
    const { deps } = makeDeps({ QA: '有回复 A', QB: '有回复 B' }, async (p: string) => {
      if (p.includes('请处理 QA')) throw new Error("Provider 'custom-1789305343000' not found")
      return '{"deliverable": true}'
    })
    // 让 sendMessage 知道当前题目：按调用序 QA→QB
    let call = 0
    const origSend = deps.sendMessage
    deps.sendMessage = async (content, queued, opts) => {
      call++
      ;(deps as unknown as { __setCurrent: (id: string) => void }).__setCurrent(call === 1 ? 'QA' : 'QB')
      return origSend(content, queued, opts)
    }

    const runner = createExamRunner(deps)
    const report = await runner.run({ cases, fixtureReady: true, pollMs: 1, graceMs: 1, timeoutMsPerQuestion: 2000 })

    expect(report).not.toBeNull()
    const r = report!
    expect(r.summary.judgeErrors).toBe(1)
    // 旧行为：QA 判卷失败仍计入分母 → 1/2 = 0.5；新行为：分母只含可判题 → 1/1 = 1
    expect(r.summary.deliverableRate).toBe(1)
    expect(r.notes.some(n => n.includes('judge-error') || n.includes('判卷失败'))).toBe(true)
  })

  it('全部题目判卷失败 → 可交付率不应被当成 0（分母为空时单列说明）', async () => {
    const cases = [makeCase('QA')]
    const { deps } = makeDeps({ QA: '有回复 A' }, async () => {
      throw new Error("Provider 'x' not found")
    })
    const runner = createExamRunner(deps)
    const report = await runner.run({ cases, fixtureReady: true, pollMs: 1, graceMs: 1, timeoutMsPerQuestion: 2000 })
    const r = report!
    expect(r.summary.judgeErrors).toBe(1)
    expect(r.summary.judgeable).toBe(0)
    expect(r.notes.some(n => n.includes('判卷失败'))).toBe(true)
  })
})
