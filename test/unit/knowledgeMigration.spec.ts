import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vault } from '@/vault'

// 纯缓存模式：vault.list 遍历内存 cache，便于断言备份内容
;(globalThis as any).window = {}

import { migrateKnowledgePartitions } from '@/services/knowledgeMigration'

const ENTRIES_KEY = 'holo-knowledge-entries'
const VERSION_KEY = 'holo-partition-schema-version'

interface StoredEntry {
  id: string
  filename: string
  fileType: string
  chunks: number
  fingerprint: string
  createdAt: number
  ownerType?: string
  partition?: 'kernel' | 'pack' | 'user'
  partitionId?: string
}

function entry(id: string, partition?: 'kernel' | 'pack' | 'user'): StoredEntry {
  return { id, filename: `${id}.txt`, fileType: 'text/plain', chunks: 1, fingerprint: `fp-${id}`, createdAt: 0, ownerType: 'global', partition }
}

async function readEntries(): Promise<StoredEntry[]> {
  const raw = await vault.read('knowledge', ENTRIES_KEY)
  return raw ? JSON.parse(raw) : []
}

describe('knowledgeMigration M12：存量 partition 迁移（备份/对账/幂等）', () => {
  beforeEach(async () => {
    vault.clearCache()
    await vault.write('knowledge', ENTRIES_KEY, JSON.stringify([
      entry('e-legacy-1'),
      entry('e-legacy-2'),
      entry('e-kernel', 'kernel'),
      entry('e-pack-legal', 'pack')
    ]))
    // e-pack-legal 应带 partitionId
    const entries = await readEntries()
    entries.find(e => e.id === 'e-pack-legal')!.partitionId = 'legal'
    await vault.write('knowledge', ENTRIES_KEY, JSON.stringify(entries))
  })

  it('undefined partition 条目归 user，已有 partition 条目不动，写版本标记，创建备份', async () => {
    const report = await migrateKnowledgePartitions()
    expect(report.skipped).toBe(false)
    expect(report.success).toBe(true)
    expect(report.total).toBe(4)
    expect(report.modified).toBe(2)
    expect(report.backupLocation).toBeTruthy()

    const entries = await readEntries()
    expect(entries.find(e => e.id === 'e-legacy-1')?.partition).toBe('user')
    expect(entries.find(e => e.id === 'e-legacy-2')?.partition).toBe('user')
    expect(entries.find(e => e.id === 'e-kernel')?.partition).toBe('kernel')
    expect(entries.find(e => e.id === 'e-pack-legal')?.partition).toBe('pack')
    expect(entries.find(e => e.id === 'e-pack-legal')?.partitionId).toBe('legal')

    expect(await vault.read('knowledge', VERSION_KEY)).toBe('1')

    const backupKeys = await vault.list(report.backupLocation!)
    expect(backupKeys.some(k => k.includes(ENTRIES_KEY))).toBe(true)
  })

  it('幂等：版本标记命中后整体跳过（不重复迁移）', async () => {
    await migrateKnowledgePartitions()
    const second = await migrateKnowledgePartitions()
    expect(second.skipped).toBe(true)
    expect(second.success).toBe(true)
    expect(second.modified).toBe(0)
  })

  it('空库迁移合法：total=0, modified=0, success', async () => {
    vault.clearCache()
    const report = await migrateKnowledgePartitions()
    expect(report.success).toBe(true)
    expect(report.total).toBe(0)
    expect(report.modified).toBe(0)
  })
})
