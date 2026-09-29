import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * K-2（快照 §九）：`convMemory` 的 `lastIndexTimestamp` 是**模块级变量**，全文只有写、
 * 无任何 vault 读回/落盘 ⇒ 每次重启归零，`indexConversationRound` 会把已索引过的
 * 历史对白**再次全量摄取**。
 *
 * 本 spec 自带 vault mock（内存 map，hoisted 单例）——`vi.resetModules()` 模拟重启后
 * convMemory 的模块变量归零，但同一个 vault 实例仍在，故能验证「水位线是否真的落在
 * vault 里」（修复前：vault 无该键 ⇒ 重启后重复摄取）。
 * 每个用例都重建模块实例——否则模块级 `lastIndexTimestamp` 会跨用例残留、造成假绿/假红。
 */

const WATERMARK_KEY = 'holo-conv-index-watermark'

const { store, ingestMock } = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    ingestMock: vi.fn(async () => ({ id: 'kb-1' }))
  }
})

vi.mock('@/vault', () => ({
  vault: {
    readCache: (ns: string, k: string) => store.get(`${ns}:${k}`) ?? null,
    writeCache: (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    writeThrough: (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    read: async (ns: string, k: string) => store.get(`${ns}:${k}`) ?? null,
    write: async (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    delete: async (ns: string, k: string) => { store.delete(`${ns}:${k}`) },
    list: async () => [...store.keys()],
    clearCache: () => { store.clear() },
  }
}))
vi.mock('@/services/knowledgeBase', () => ({
  ingestText: ingestMock,
  hybridSearch: vi.fn(async () => []),
}))

type IndexFn = typeof import('@/services/convMemory').indexConversationRound
let index: IndexFn

async function freshModule(): Promise<void> {
  vi.resetModules()
  index = (await import('@/services/convMemory')).indexConversationRound
}

function msgs(base = 1_700_000_000_000) {
  return [
    { role: 'user', content: '这是第一条足够长的用户消息，用于触发会话索引', timestamp: base },
    { role: 'assistant', content: '这是助手的回复内容，同样足够长', timestamp: base + 5 },
  ] as never
}

describe('K-2：会话索引水位线随 vault 持久化', () => {
  beforeEach(async () => {
    store.clear()
    ingestMock.mockClear()
    await freshModule()
  })

  it('摄取后水位线写入 vault（修复前只在模块变量里，vault 无该键）', async () => {
    const m = msgs()
    await index(m)
    expect(ingestMock).toHaveBeenCalledTimes(1)
    expect(store.get(`conv:${WATERMARK_KEY}`)).toBe(String(m[1].timestamp))
  })

  it('同一批消息再次调用不重复摄取', async () => {
    const m = msgs()
    await index(m)
    await index(m)
    expect(ingestMock).toHaveBeenCalledTimes(1)
  })

  it('重启（模块变量归零）后不再摄取已索引过的旧消息', async () => {
    const m = msgs()
    await index(m)
    expect(ingestMock).toHaveBeenCalledTimes(1)

    await freshModule()
    await index(m)
    // 水位线从 vault 读回 ⇒ 重启后不重复摄取（修复前此处会 +1）
    expect(ingestMock).toHaveBeenCalledTimes(1)
  })

  it('水位线之后的新消息仍会被摄取（不因持久化而漏摄取）', async () => {
    const m = msgs()
    await index(m)
    const later = msgs(m[1].timestamp + 1000).slice(0, 1)
    await freshModule()
    await index(later)
    expect(ingestMock).toHaveBeenCalledTimes(2)
  })
})
