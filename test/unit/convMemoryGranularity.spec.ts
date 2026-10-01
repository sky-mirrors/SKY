import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DialogMessage } from '@/models'

/**
 * 2026-10-01（用户要求：改粒度）：
 * `indexConversationRound` 原先把「一批新消息」压成**一条** `conv-round-*` 索引，
 * 检索颗粒过粗（一次命中带出整段无关对白）。改为**按轮切分**：
 * 以 user 消息为轮首，其后到下一条 user 之前归为同一轮，每轮各入库一条。
 *
 * 测试隔离注意：convMemory 的 `lastIndexTimestamp` 是**模块级缓存**（只在 null 时读 vault），
 * 同一测试文件内会跨用例残留——因此每条用例使用**互不重叠的 ts 区间**，不依赖重置。
 */
const originalWindow = globalThis.window

const ingestText = vi.fn().mockResolvedValue({ id: 'x', filename: 'conv-round', chunks: 1, fingerprint: 'f', createdAt: 0, ownerType: 'conversation' })
let watermark = '0'

vi.mock('@/services/knowledgeBase', () => ({
  ingestText: (...args: unknown[]) => ingestText(...args)
}))

vi.mock('@/vault', () => ({
  vault: {
    readCache: (_ns: string, key: string) => (key.includes('watermark') ? watermark : null),
    writeThrough: (_ns: string, key: string, v: string) => { if (key.includes('watermark')) watermark = v },
    writeCache: vi.fn()
  }
}))

const msg = (role: 'user' | 'assistant', content: string, ts: number): DialogMessage =>
  ({ id: `m-${ts}`, role, type: 'text', content, timestamp: ts } as DialogMessage)

beforeEach(() => {
  ingestText.mockClear()
  watermark = '0'
  ;(globalThis as any).window = { electronAPI: {} }
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('indexConversationRound —— 逐轮切分（改粒度）', () => {
  it('3 轮对话产生 3 条索引，且每条只含该轮内容、以轮首时间戳命名', async () => {
    const { indexConversationRound } = await import('@/services/convMemory')
    await indexConversationRound([
      msg('user', '第一轮的问题', 100),
      msg('assistant', '第一轮的回答内容', 200),
      msg('user', '第二轮的问题', 300),
      msg('assistant', '第二轮的回答内容', 400),
      msg('user', '第三轮的问题', 500),
      msg('assistant', '第三轮的回答内容', 600)
    ])
    // ① 粒度：3 轮 → 3 条（原先整批压成 1 条）
    expect(ingestText).toHaveBeenCalledTimes(3)
    const texts = ingestText.mock.calls.map(c => String(c[0]))
    const names = ingestText.mock.calls.map(c => String(c[2]))
    // ② 不夹带：每条只含本轮内容
    expect(texts[0]).toContain('第一轮的问题')
    expect(texts[0]).not.toContain('第二轮的问题')
    expect(texts[1]).toContain('第二轮的问题')
    expect(texts[1]).not.toContain('第三轮的问题')
    expect(texts[2]).toContain('第三轮的问题')
    // ③ 命名稳定：用轮首消息的 ts（原先用 Date.now()，同毫秒会撞名）
    expect(names).toEqual(['conv-round-100', 'conv-round-300', 'conv-round-500'])
  })

  it('水位线推进后，旧消息不重复索引（只索引新增的那一轮）', async () => {
    const { indexConversationRound } = await import('@/services/convMemory')
    await indexConversationRound([msg('user', '老问题内容', 30100), msg('assistant', '老回答内容', 30200)])
    expect(ingestText).toHaveBeenCalledTimes(1)
    ingestText.mockClear()
    await indexConversationRound([
      msg('user', '老问题内容', 30100),
      msg('assistant', '老回答内容', 30200),
      msg('user', '新问题内容', 30300),
      msg('assistant', '新回答内容', 30400)
    ])
    expect(ingestText).toHaveBeenCalledTimes(1)
    expect(String(ingestText.mock.calls[0][0])).toContain('新问题内容')
  })

  it('连续 assistant 消息并入其所在一轮（不新起一轮）', async () => {
    const { indexConversationRound } = await import('@/services/convMemory')
    await indexConversationRound([
      msg('user', '需要多步的问题', 40100),
      msg('assistant', '第一段回答', 40200),
      msg('assistant', '第二段回答', 40300)
    ])
    expect(ingestText).toHaveBeenCalledTimes(1)
    const text = String(ingestText.mock.calls[0][0])
    expect(text).toContain('第一段回答')
    expect(text).toContain('第二段回答')
  })
})
