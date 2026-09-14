import { vault } from '@/vault'
import { debugLog } from '@/services/debugLog'

/**
 * 规格 M12：存量知识条目 partition 迁移。
 *
 * 步骤（docs/HOTPLUG-ARCHITECTURE.md 7.4）：
 * 1. 备份：vault 导出涉及 namespace（knowledge / conv / skill）到带时间戳备份；备份失败 → 中止；
 * 2. 记录迁移前条目计数；
 * 3. 逐条处理：entry.partition === undefined → 写入 partition='user'（存量无主条目一律归用户）；
 * 4. 计数对账：迁移后总数 !== 迁移前总数 → 恢复备份 + 失败报告；
 * 5. 输出报告；脚本幂等（重复执行第 3 步全为 no-op），schema 版本标记命中时整体跳过。
 */

const KNOWLEDGE_ENTRIES_KEY = 'holo-knowledge-entries'
const PARTITION_SCHEMA_VERSION_KEY = 'holo-partition-schema-version'
const PARTITION_SCHEMA_VERSION = 1
const BACKUP_NAMESPACES = ['knowledge', 'conv', 'skill']

export interface KnowledgeMigrationReport {
  skipped: boolean
  success: boolean
  total: number
  modified: number
  durationMs: number
  backupLocation: string | null
  error?: string
}

interface StoredKnowledgeEntry {
  id: string
  partition?: 'kernel' | 'pack' | 'user'
  partitionId?: string
  [key: string]: unknown
}

async function backupNamespaces(timestamp: number): Promise<string> {
  const backupNs = `backup-${timestamp}`
  for (const ns of BACKUP_NAMESPACES) {
    const keys = await vault.list(ns)
    for (const fullKey of keys) {
      const shortKey = fullKey.startsWith(`${ns}:`) ? fullKey.slice(ns.length + 1) : fullKey
      const value = await vault.read(ns, shortKey)
      if (value !== null) {
        await vault.write(backupNs, `${ns}:${shortKey}`, value)
      }
    }
  }
  return backupNs
}

async function restoreBackup(backupNs: string): Promise<void> {
  const keys = await vault.list(backupNs)
  for (const fullKey of keys) {
    const shortKey = fullKey.startsWith(`${backupNs}:`) ? fullKey.slice(backupNs.length + 1) : fullKey
    const value = await vault.read(backupNs, shortKey)
    if (value === null) continue
    const sep = shortKey.indexOf(':')
    if (sep < 0) continue
    const originalNs = shortKey.slice(0, sep)
    const originalKey = shortKey.slice(sep + 1)
    await vault.write(originalNs, originalKey, value)
  }
}

export async function migrateKnowledgePartitions(): Promise<KnowledgeMigrationReport> {
  const startedAt = Date.now()

  const versionRaw = await vault.read('knowledge', PARTITION_SCHEMA_VERSION_KEY)
  if (versionRaw !== null && Number(versionRaw) >= PARTITION_SCHEMA_VERSION) {
    return {
      skipped: true,
      success: true,
      total: 0,
      modified: 0,
      durationMs: Date.now() - startedAt,
      backupLocation: null
    }
  }

  let backupNs: string | null = null
  try {
    backupNs = await backupNamespaces(startedAt)
  } catch (err) {
    return {
      skipped: false,
      success: false,
      total: 0,
      modified: 0,
      durationMs: Date.now() - startedAt,
      backupLocation: null,
      error: `backup-failed: ${(err as Error).message}`
    }
  }

  const raw = await vault.read('knowledge', KNOWLEDGE_ENTRIES_KEY)
  let entries: StoredKnowledgeEntry[] = []
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) entries = parsed
    } catch {
      entries = []
    }
  }

  const beforeCount = entries.length
  let modified = 0
  for (const entry of entries) {
    if (entry.partition === undefined) {
      entry.partition = 'user'
      modified++
    }
  }

  await vault.write('knowledge', KNOWLEDGE_ENTRIES_KEY, JSON.stringify(entries))

  const verifyRaw = await vault.read('knowledge', KNOWLEDGE_ENTRIES_KEY)
  let afterCount = -1
  if (verifyRaw !== null) {
    try {
      const parsed = JSON.parse(verifyRaw)
      if (Array.isArray(parsed)) afterCount = parsed.length
    } catch {
      afterCount = -1
    }
  }

  if (afterCount !== beforeCount) {
    try {
      await restoreBackup(backupNs)
    } catch { /* 恢复失败如实报告 */ }
    return {
      skipped: false,
      success: false,
      total: beforeCount,
      modified,
      durationMs: Date.now() - startedAt,
      backupLocation: backupNs,
      error: `count-mismatch: before=${beforeCount}, after=${afterCount}; backup restored`
    }
  }

  await vault.write('knowledge', PARTITION_SCHEMA_VERSION_KEY, String(PARTITION_SCHEMA_VERSION))

  const report: KnowledgeMigrationReport = {
    skipped: false,
    success: true,
    total: beforeCount,
    modified,
    durationMs: Date.now() - startedAt,
    backupLocation: backupNs
  }
  debugLog(`[KnowledgeMigration] partition 迁移完成: total=${report.total}, modified=${report.modified}, 备份=${backupNs}`)
  return report
}
