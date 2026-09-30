import { describe, it, expect } from 'vitest'
import { createExamRunner, type ExamRunnerDeps } from '@/exam/examRunner'
import { EXAM_CASES_V2, V2_EXTRA_CASES, V2_FIXTURES, type ExamCaseV2 } from '@/exam/examCasesV2'
import type { ExamCase } from '@/exam/examCases'
import { globalBus } from '@/kernel/bus'

// ─────────────────────────────────────────────────────────────────────────────
// 一、题库结构校验（本环境能做的确定部分）
// ─────────────────────────────────────────────────────────────────────────────

describe('EXAM_CASES_V2 · 结构', () => {
  it('题目数、id 唯一、必填字段齐全、断言与判卷提示非空', () => {
    expect(EXAM_CASES_V2.length).toBeGreaterThanOrEqual(25)
    const ids = EXAM_CASES_V2.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of EXAM_CASES_V2) {
      expect(c.id, 'id').toBeTruthy()
      expect(c.title, c.id).toBeTruthy()
      expect(c.prompt, c.id).toBeTruthy()
      expect(c.judgeHint, c.id).toBeTruthy()
      expect(c.assertions.length, c.id).toBeGreaterThan(0)
    }
  })

  // 2026-09-30 追加：上一轮写「扩展批」时漏了接入 EXAM_CASES_V2（文件被写坏后重建），
  // 而既有的 `length >= 25` 断言对「漏接入」完全无感 —— 回滚本步它仍全绿。
  // 这条钉住「扩展批真在题库里」，回滚 `...V2_EXTRA_CASES` 即变红。
  it('扩展批（V2_EXTRA_CASES）已真正接入全量题库（31 + 19 = 50）', () => {
    const ids = new Set(EXAM_CASES_V2.map(c => c.id))
    const extraIds = V2_EXTRA_CASES.map(c => c.id)
    expect(extraIds.length).toBe(19)
    for (const id of extraIds) {
      expect(ids.has(id), `${id} 未接入 EXAM_CASES_V2`).toBe(true)
    }
    expect(EXAM_CASES_V2.length).toBe(V2_EXTRA_CASES.length + 31)
  })

  it('六个分类都有题（路由/媒体/边界/诚实/安全/多轮）', () => {
    const cats = new Set(EXAM_CASES_V2.map(c => c.category))
    for (const want of ['routing', 'media', 'edge', 'honesty', 'security', 'multiturn']) {
      expect(cats.has(want as ExamCaseV2['category']), want).toBe(true)
    }
  })

  it('路由类覆盖四层（L0/L0.5/L1/L2 各有题）', () => {
    const layers = new Set(
      EXAM_CASES_V2.filter(c => c.expectedLayer).map(c => c.expectedLayer)
    )
    for (const want of ['L0', 'L0.5', 'L1', 'L2']) {
      expect(layers.has(want as never), want).toBe(true)
    }
  })

  it('断言 kind 全部受支持（含本轮新增的 notContains）', () => {
    const supported = new Set(['number', 'contains', 'fileExists', 'dirPattern', 'notContains'])
    for (const c of EXAM_CASES_V2) {
      for (const a of c.assertions) {
        expect(supported.has(a.kind), `${c.id}: ${a.kind}`).toBe(true)
      }
    }
    // 负向断言的覆盖：至少若干题用它钉「不许假完成/编造」
    const negativeCount = EXAM_CASES_V2.filter(c => c.assertions.some(a => a.kind === 'notContains')).length
    expect(negativeCount).toBeGreaterThanOrEqual(8)
  })

  it('requiresFixture 的题引用了 V2_FIXTURES 目录（素材依赖显式可查）', () => {
    const fixtureRoots = Object.values(V2_FIXTURES)
    for (const c of EXAM_CASES_V2.filter(x => x.requiresFixture)) {
      const text = c.prompt + JSON.stringify(c.assertions)
      expect(fixtureRoots.some(r => text.includes(r)), c.id).toBe(true)
    }
  })

  it('题目的 assertions 与 ExamCase 结构兼容（可直接喂给 runExam）', () => {
    const asV1: ExamCase[] = EXAM_CASES_V2
    expect(asV1.length).toBe(EXAM_CASES_V2.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 二、notContains 断言的真实行为（经 runExam 端到端，mock deps 同 examRunner.spec）
// ─────────────────────────────────────────────────────────────────────────────

function makeCase(overrides?: Partial<ExamCase>): ExamCase {
  return {
    id: 'V2-X1',
    category: 'honesty',
    title: '测试题',
    prompt: '随便问一句',
    assertions: [{ kind: 'notContains', needles: ['已生成', '已完成'] }],
    judgeHint: '不得声称完成',
    ...overrides
  }
}

function makeDeps(behavior: { reply?: string; judgeReply?: string } = {}): ExamRunnerDeps {
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
        if (behavior.reply !== undefined) {
          state.messages.push({ role: 'assistant', content: behavior.reply, timestamp: Date.now() })
        }
      }, 20)
      return ''
    },
    getState: () => ({ isProcessing: state.isProcessing, paused: state.paused, traceId: state.traceId, messages: [...state.messages] }),
    judge: async () => behavior.judgeReply ?? '{"deliverable": true}',
    fileExists: async () => true,
    dirMatches: async () => true
  }
}

const fastTiming = { pollMs: 5, graceMs: 20 }

describe('notContains · 负向硬断言', () => {
  it('回复含禁用串 → 硬断言失败', async () => {
    const runner = createExamRunner(makeDeps({ reply: '已完成，文件已生成到桌面' }))
    const report = await runner.run({ cases: [makeCase()], ...fastTiming, timeoutMsPerQuestion: 5000 })
    expect(report!.questions[0].hardAssertPassed).toBe(false)
  })

  it('回复不含禁用串 → 硬断言通过', async () => {
    const runner = createExamRunner(makeDeps({ reply: '这个我做不到，请提供更多信息' }))
    const report = await runner.run({ cases: [makeCase()], ...fastTiming, timeoutMsPerQuestion: 5000 })
    expect(report!.questions[0].hardAssertPassed).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 三、多轮 followUps（2026-09-30 新增的 runner 能力）
// ─────────────────────────────────────────────────────────────────────────────

describe('多轮 followUps · runner 支持', () => {
  it('按轮次逐条发送，且判卷看到的回复是**各轮合并**', async () => {
    const sent: string[] = []
    const state = {
      isProcessing: false,
      paused: false,
      traceId: '',
      messages: [] as { role: string; content: string; timestamp: number }[]
    }
    const deps: ExamRunnerDeps = {
      sendMessage: async (msg: string) => {
        sent.push(msg)
        state.isProcessing = true
        setTimeout(() => {
          state.isProcessing = false
          state.messages.push({ role: 'assistant', content: `回复(${msg})`, timestamp: Date.now() })
        }, 20)
        return ''
      },
      getState: () => ({ isProcessing: state.isProcessing, paused: state.paused, traceId: state.traceId, messages: [...state.messages] }),
      judge: async () => '{"deliverable": true}',
      fileExists: async () => true,
      dirMatches: async () => true
    }
    const runner = createExamRunner(deps)
    const c = makeCase({
      id: 'V2-X2',
      assertions: [{ kind: 'contains', needles: ['回复(第二轮)'] }],
      followUps: ['第一轮', '第二轮']
    })
    const report = await runner.run({ cases: [c], ...fastTiming, timeoutMsPerQuestion: 5000 })

    // 首轮 prompt + followUps 全部发出
    expect(sent).toEqual(['随便问一句', '第一轮', '第二轮'])
    // 断言作用于合并文本 ⇒ 能命中**后续回合**的内容（单轮实现会漏掉）
    expect(report!.questions[0].hardAssertPassed).toBe(true)
  })

  it('无 followUps 时退化为单轮（且回复仍是最后一条，不合并）', async () => {
    const runner = createExamRunner(makeDeps({ reply: '只有一条回复' }))
    const report = await runner.run({ cases: [makeCase({ followUps: undefined })], ...fastTiming, timeoutMsPerQuestion: 5000 })
    expect(report!.questions[0].replyExcerpt).toContain('只有一条回复')
  })
})
