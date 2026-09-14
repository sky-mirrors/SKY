import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vault } from '@/vault'
import type { KnowledgeEntry } from '@/models'

;(globalThis as any).window = {
  electronAPI: {
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
}

import { hybridSearch } from '@/services/knowledgeBase'

vi.mock('@/services/embedder', () => ({
  VECTOR_DIM: 384,
  getEmbedder: vi.fn(async () => null),
  isEmbedderReady: vi.fn(() => true),
  generateVector: vi.fn(async (text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return vec.map((v: number) => v / norm)
  }),
  generateVectorWithMeta: vi.fn(async (text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return { vector: vec.map((v: number) => v / norm), isPseudo: false }
  }),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }),
  needsReembedding: vi.fn((vector: number[]) => vector.length !== 384)
}))

const ENTRIES_KEY = 'holo-knowledge-entries'

function makeEntry(id: string, partition?: 'kernel' | 'pack' | 'user', partitionId?: string): KnowledgeEntry {
  return {
    id,
    filename: `${id}.txt`,
    fileType: 'text/plain',
    chunks: 1,
    fingerprint: `fp-${id}`,
    createdAt: 0,
    ownerType: 'global',
    partition,
    partitionId
  }
}

function writeChunk(entryId: string, text: string): void {
  vault.writeThrough('knowledge', `holo-kb-chunks-${entryId}`, JSON.stringify([
    { text, entryId, chunkIndex: 0, vector: new Array(384).fill(0), tokens: 8 }
  ]))
}

function resultEntryIds(results: Array<{ entryId: string }>): Set<string> {
  return new Set(results.map(r => r.entryId))
}

describe('knowledgeBase M11：partition 检索隔离（零污染）', () => {
  beforeEach(() => {
    vault.clearCache()
    const entries: KnowledgeEntry[] = [
      makeEntry('e-user'),                                        // 存量条目：partition undefined → 视为 user
      makeEntry('e-user2', 'user'),
      makeEntry('e-kernel', 'kernel'),
      makeEntry('e-pack-legal', 'pack', 'legal'),
      makeEntry('e-pack-finance', 'pack', 'finance'),
      makeEntry('e-conversation-pack', 'pack', 'legal')          // ownerType 之外的正交维度演示
    ]
    entries[5].ownerType = 'conversation'
    entries[5].ownerId = 'conv-1'
    vault.writeThrough('knowledge', ENTRIES_KEY, JSON.stringify(entries))
    writeChunk('e-user', '用户文档中提到了劳动合同续签条款')
    writeChunk('e-user2', '用户笔记记录了竞业限制的年限问题')
    writeChunk('e-kernel', '内核通用知识库收录了劳动合同法条文')
    writeChunk('e-pack-legal', '法务包知识收录了劳动合同法第十条书面合同要求')
    writeChunk('e-pack-finance', '财务包知识收录了增值税税率档次说明')
    writeChunk('e-conversation-pack', '会话内法务包补充材料关于劳动合同解除')
  })

  it('无 partition scope → user/undefined/kernel 可见，pack 条目完全不可见（零污染兜底）', async () => {
    const results = await hybridSearch('劳动合同', 10)
    const ids = resultEntryIds(results)
    expect(ids.has('e-user')).toBe(true)
    expect(ids.has('e-kernel')).toBe(true)
    expect(ids.has('e-pack-legal')).toBe(false)
    expect(ids.has('e-pack-finance')).toBe(false)
    expect(ids.has('e-conversation-pack')).toBe(false)
  })

  it('partition scope kind=pack + id=legal → 仅该 pack 条目可见', async () => {
    const results = await hybridSearch('劳动合同', 10, { partition: { kind: 'pack', id: 'legal' } })
    const ids = resultEntryIds(results)
    expect(ids.has('e-pack-legal')).toBe(true)
    expect(ids.has('e-conversation-pack')).toBe(true)
    expect(ids.has('e-pack-finance')).toBe(false)
    expect(ids.has('e-user')).toBe(false)
    expect(ids.has('e-kernel')).toBe(false)
  })

  it('partition scope 指向不存在的 packId → 空结果（不是错误，spec 7.2 错误路径）', async () => {
    const results = await hybridSearch('劳动合同', 10, { partition: { kind: 'pack', id: 'hr' } })
    expect(results.length).toBe(0)
  })

  it('partition scope kind=user → 不含 kernel、不含任何 pack', async () => {
    const results = await hybridSearch('劳动合同', 10, { partition: { kind: 'user' } })
    const ids = resultEntryIds(results)
    expect(ids.has('e-user')).toBe(true)
    expect(ids.has('e-kernel')).toBe(false)
    expect(ids.has('e-pack-legal')).toBe(false)
  })

  it('partition scope kind=kernel → 仅 kernel 条目', async () => {
    const results = await hybridSearch('劳动合同', 10, { partition: { kind: 'kernel' } })
    const ids = resultEntryIds(results)
    expect(ids.has('e-kernel')).toBe(true)
    expect(ids.size).toBe(1)
  })

  it('partition 过滤与 ownerType 过滤正交叠加（AND）', async () => {
    const results = await hybridSearch('劳动合同', 10, { ownerType: 'conversation' })
    const ids = resultEntryIds(results)
    // 现状 ownerType 语义 = 目标条目 + 全局条目恒可见；partition 兜底把其中的 pack 条目排除
    expect(ids.has('e-conversation-pack')).toBe(false)
    expect(ids.has('e-user')).toBe(true)
    expect(ids.has('e-kernel')).toBe(true)

    const packScoped = await hybridSearch('劳动合同', 10, { ownerType: 'conversation', partition: { kind: 'pack', id: 'legal' } })
    expect(resultEntryIds(packScoped).has('e-conversation-pack')).toBe(true)
  })
})
