import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * K-2 / K-4（快照 §九）：
 *   - K-2：`ingestTextCore` 只把 fingerprint 写进新条目，**无既存检查**（对照 `ingestFile`
 *     有）⇒ 同一文本重复摄取不断累加条目。
 *   - K-4：`knowledgeMigration` 走裸 read-modify-write，全程不持 `knowledgeBase` 的
 *     `withEntriesLock` ⇒ 迁移窗口与并发写入互相覆盖。
 *
 * 本 spec 自带 vault mock（内存 map），并让「读 entries」先取快照、后延迟——精确复现
 * read-modify-write 窗口：迁移拿着旧快照写回时，会把窗口内并发写入的新条目抹掉。
 */

const { store, ctl } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ctl: { delayKey: '', delayMs: 0, reads: 0 }
}))

vi.mock('@/vault', () => ({
  vault: {
    readCache: (ns: string, k: string) => store.get(`${ns}:${k}`) ?? null,
    writeCache: (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    writeThrough: (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    // 先取快照再延迟：模拟真实的读-改-写窗口。
    // 只延迟「锁内」那次读（第 2 次读同一 key）——第 1 次是迁移前的备份读，不在窗口内。
    read: async (ns: string, k: string) => {
      if (k === ctl.delayKey) ctl.reads++
      const v = store.get(`${ns}:${k}`) ?? null
      if (k === ctl.delayKey && ctl.delayMs > 0 && ctl.reads > 1) {
        const d = ctl.delayMs
        ctl.delayMs = 0
        await new Promise(r => setTimeout(r, d))
      }
      return v
    },
    write: async (ns: string, k: string, v: string) => { store.set(`${ns}:${k}`, v) },
    delete: async (ns: string, k: string) => { store.delete(`${ns}:${k}`) },
    list: async () => [...store.keys()],
    clearCache: () => { store.clear() },
  }
}))

vi.mock('@/services/embedder', () => ({
  VECTOR_DIM: 384,
  getEmbedder: vi.fn(async () => null),
  isEmbedderReady: vi.fn(() => true),
  // 向量生成加一点延迟：让并发用例里「迁移先拿到旧快照、摄取随后写入」成为确定性时序
  generateVectorWithMeta: vi.fn(async () => {
    await new Promise(r => setTimeout(r, 10))
    return { vector: new Array(384).fill(0.01), isPseudo: false }
  }),
  // 2026-10-01：摄取改为批量生成向量（性能），mock 需同步提供该导出
  generateVectorsWithMeta: vi.fn(async (ts: string[]) => ts.map(() => ({ vector: new Array(384).fill(0.01), isPseudo: false }))),
  generateVector: vi.fn(async () => new Array(384).fill(0.01)),
  generatePseudoVector: vi.fn(() => new Array(384).fill(0.01)),
  needsReembedding: vi.fn(() => false),
  cosineSimilarity: vi.fn(() => 0),
}))

vi.mock('@/services/vectorStore', () => ({
  saveChunksToFile: vi.fn(async () => true),
  loadChunksFromFile: vi.fn(async () => null),
  migrateFromLocalStorage: vi.fn(async () => 0),
  listVectorEntries: vi.fn(async () => []),
  deleteChunksFile: vi.fn(async () => true),
}))

import { ingestText, getKnowledgeEntries } from '@/services/knowledgeBase'
import { migrateKnowledgePartitions } from '@/services/knowledgeMigration'

const ENTRIES_KEY = 'holo-knowledge-entries'

function readEntries(): Array<Record<string, unknown>> {
  const raw = store.get(`knowledge:${ENTRIES_KEY}`)
  return raw ? JSON.parse(raw) : []
}

describe('K-2：ingestText 去重下沉进 ingestTextCore', () => {
  beforeEach(() => {
    store.clear()
    ctl.delayKey = ''
    ctl.delayMs = 0
    ctl.reads = 0
  })

  it('同一文本连续 ingestText 两次 → 条目数只增 1（第二次返回既有条目）', async () => {
    const text = '这是一段用于验证去重行为的知识文本，长度足够触发一次分块。'
    const first = await ingestText(text, { type: 'global' })
    const second = await ingestText(text, { type: 'global' })
    expect(second.id).toBe(first.id)
    expect(getKnowledgeEntries()).toHaveLength(1)
  })

  it('不同文本各建条目（去重不误伤）', async () => {
    await ingestText('第一段完全不同的文本内容甲', { type: 'global' })
    await ingestText('第二段完全不同的文本内容乙', { type: 'global' })
    expect(getKnowledgeEntries()).toHaveLength(2)
  })
})

describe('K-4：知识迁移持 knowledgeBase 的同一把锁', () => {
  beforeEach(() => {
    store.clear()
    ctl.delayKey = ''
    ctl.delayMs = 0
    ctl.reads = 0
    store.set(`knowledge:${ENTRIES_KEY}`, JSON.stringify([
      { id: 'e1', filename: 'a.txt', fileType: 'text/plain', chunks: 1, fingerprint: 'fp1', createdAt: 0 },
      { id: 'e2', filename: 'b.txt', fileType: 'text/plain', chunks: 1, fingerprint: 'fp2', createdAt: 0 },
    ]))
  })

  it('迁移窗口内并发摄取的新条目不被覆盖（修复前会丢）', async () => {
    // 让「读 entries」取完快照后停在窗口内 50ms
    ctl.delayKey = ENTRIES_KEY
    ctl.delayMs = 50
    const migration = migrateKnowledgePartitions()
    await new Promise(r => setTimeout(r, 5))   // 等迁移进入窗口
    // 修复前：迁移无锁，此处摄取会在窗口内落盘（3 条），随后迁移用旧快照写回 → 丢 1
    // 修复后：迁移持锁，摄取须排队到迁移之后 → 最终 3 条
    await ingestText('迁移窗口内并发写入的一段新知识文本', { type: 'global' })
    await migration
    const entries = readEntries()
    expect(entries).toHaveLength(3)
    expect(entries.filter(e => e.partition === 'user')).toHaveLength(2)
  })

  it('契约：knowledgeBase 导出 withEntriesLock，迁移复用之', () => {
    const kb = readFileSync(join(process.cwd(), 'src/services/knowledgeBase.ts'), 'utf-8')
    const mig = readFileSync(join(process.cwd(), 'src/services/knowledgeMigration.ts'), 'utf-8')
    expect(kb).toMatch(/export function withEntriesLock/)
    expect(mig).toContain('withEntriesLock')
  })
})
