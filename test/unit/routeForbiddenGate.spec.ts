// Q14 误路由修复：L2 清单的 forbiddenKeywords 禁词门（P1-D5）此前只长在 keywordMatchScore 上，
// 而 universalMatch / getTop3CandidatesUniversal / llmFallback 走 keywordMatchScoreGeneric 绕过了它——
// 于是「帮我看一下桌面上有哪些 .docx，列个清单」（Q14，含禁词「清单/有哪些/看一下」）
// 仍被 LLM 仲裁选中「文件创建器」并创建垃圾文件「新建文档.docx」（假完成）。
//
// 本测试钉：llmFallback 的确定性预过滤必须剔除「被自身禁词门拦截」的 L2 候选，不把它交给 LLM 仲裁。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/embedder', () => ({
  generateVector: vi.fn(() => Promise.resolve(new Array(384).fill(0.1))),
  cosineSimilarity: vi.fn(() => 1)
}))
vi.mock('@/services/fileContext', () => ({ getFileBoostForItem: vi.fn(() => 0) }))
vi.mock('@/stores/feedbackStore', () => ({ useFeedbackStore: vi.fn(() => ({ getWeightModifier: vi.fn(() => 0) })) }))
vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => ({ emitEvent: vi.fn() })) }))

import { llmFallback, keywordMatchScore } from '@/services/toolRetrieval'
import type { MatchableItem } from '@/services/toolRetrieval'
import l2Manifests from '@/data/l2Manifests'
import { EXAM_CASES } from '@/exam/examCases'

const fc = l2Manifests.find(m => m.identity.id === 'l2-file-creator-v1')!
const q14 = EXAM_CASES.find(c => c.id === 'Q14')!

function fcItem(): MatchableItem {
  return {
    id: `l2://${fc.identity.id}`,
    name: fc.identity.name,
    description: fc.routing.retrievalSummary || '',
    keywords: fc.routing.keywords,
    userSummary: fc.routing.userSummary || '',
    source: 'l2',
    manifest: fc
  }
}
const decoy: MatchableItem = {
  id: 'mcp___noop', name: 'noop', description: 'noop tool', keywords: [], userSummary: 'noop', source: 'mcp'
}

describe('Q14 误路由：L2 禁词门须覆盖 LLM 仲裁路径', () => {
  it('前置：文件创建器声明了 forbiddenKeywords，keywordMatchScore 已归零', () => {
    expect(fc.routing.forbiddenKeywords && fc.routing.forbiddenKeywords.length).toBeGreaterThan(0)
    expect(keywordMatchScore(q14.prompt, fc)).toBe(0)
  })

  it('llmFallback 预过滤剔除被禁词门拦截的 L2 候选（不再交给 LLM 仲裁）', async () => {
    const mockChat = vi.fn()
    const r = await llmFallback(
      q14.prompt,
      [
        { item: fcItem(), score: 0.5, method: 'keyword' },
        { item: decoy, score: 0.4, method: 'keyword' }
      ],
      mockChat
    )
    // 剔除后仅剩 decoy → 直接返回幸存者，不调 LLM
    expect(r).toBe(decoy)
    expect(mockChat).not.toHaveBeenCalled()
  })
})

const fr = l2Manifests.find(m => m.identity.id === 'l2-file-reader-analysis-v1')!
const q15 = EXAM_CASES.find(c => c.id === 'Q15')!

describe('Q15 误路由：文件解读助手须拒收「改文件」类指令', () => {
  it('前置：文件解读助手声明了 forbiddenKeywords', () => {
    expect(fr.routing.forbiddenKeywords && fr.routing.forbiddenKeywords.length).toBeGreaterThan(0)
  })

  it('Q15（图片按日期重命名）被文件解读助手禁词门拦截', () => {
    // 「文件夹」命中其泛词关键词「文件」，但指令是「重命名」而非「解读」——必须归零
    expect(keywordMatchScore(q15.prompt, fr)).toBe(0)
  })

  it('正常「解读文件」指令不受影响（防误伤）', () => {
    expect(keywordMatchScore('帮我解读一下 C:\\temp\\报告.docx 的内容大意', fr)).toBeGreaterThan(0)
  })
})
