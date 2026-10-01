import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/vault', () => ({
  vault: {
    readCache: vi.fn(),
    writeThrough: vi.fn(),
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  },
}))

vi.mock('@/services/embedder', () => ({
  VECTOR_DIM: 8,
  getEmbedder: vi.fn(async () => null),
  isEmbedderReady: vi.fn(() => false),
  generatePseudoVector: vi.fn(() => new Array(8).fill(0)),
  generateVector: vi.fn(async () => new Array(8).fill(0)),
  generateVectorWithMeta: vi.fn(async () => ({ vector: new Array(8).fill(0), isPseudo: true })),
  // 2026-10-01：摄取改为批量生成向量（性能），mock 需同步提供该导出
  generateVectorsWithMeta: vi.fn(async (ts: string[]) => ts.map(() => ({ vector: new Array(8).fill(0), isPseudo: true }))),
  cosineSimilarity: vi.fn(() => 0),
  needsReembedding: vi.fn(() => false),
}))

vi.mock('@/services/vectorStore', () => ({
  saveChunksToFile: vi.fn(async () => undefined),
  loadChunksFromFile: vi.fn(async () => null),
  migrateFromLocalStorage: vi.fn(async () => 0),
  listVectorEntries: vi.fn(async () => []),
  deleteChunksFile: vi.fn(async () => undefined),
}))

vi.mock('@/kernel/bus', () => ({
  globalBus: { emit: vi.fn(), on: vi.fn() },
}))

import { vault } from '@/vault'
import { getKnowledgeEntries, ingestText } from '@/services/knowledgeBase'

const readCache = vault.readCache as unknown as ReturnType<typeof vi.fn>
const writeThrough = vault.writeThrough as unknown as ReturnType<typeof vi.fn>

const INDEX_KEY = 'holo-knowledge-entries'
// 只统计对「条目索引」的写入——saveChunkStore 也会写 vault（holo-kb-chunks-*），不计入
const indexWrites = () => writeThrough.mock.calls.filter(c => c[1] === INDEX_KEY)

const CORRUPT = '\uFEFF{"broken": ' // BOM + 截断 JSON —— 2026-09-23 事故同型

describe('K-3: 知识索引解析失败必须 fail-closed（不得被单条覆盖清空）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('索引损坏时 getKnowledgeEntries 返回空数组且不抛（降级可见）', () => {
    readCache.mockReturnValue(CORRUPT)
    expect(getKnowledgeEntries()).toEqual([])
  })

  it('索引损坏时 ingestText 拒绝写入，绝不用单条覆盖全库索引', async () => {
    readCache.mockReturnValue(CORRUPT)
    await expect(ingestText('一些新知识')).rejects.toThrow(/损坏|索引/)
    expect(indexWrites()).toHaveLength(0)
  })

  it('索引正常时 ingestText 正常追加（不误伤）', async () => {
    readCache.mockReturnValue(JSON.stringify([{ id: 'kb-old' }]))
    await ingestText('一些新知识')
    expect(indexWrites()).toHaveLength(1)
    const written = JSON.parse(indexWrites()[0][2] as string) as unknown[]
    expect(written.length).toBe(2)
  })

  it('索引为空（首次使用）时 ingestText 正常追加', async () => {
    readCache.mockReturnValue(null)
    await ingestText('第一条知识')
    expect(indexWrites()).toHaveLength(1)
    const written = JSON.parse(indexWrites()[0][2] as string) as unknown[]
    expect(written.length).toBe(1)
  })
})
