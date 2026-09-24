import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { app, safeStorage } from 'electron'
import { VAULT_SCHEMA } from './vault-schema'

let db: Database.Database | null = null

function getVaultDir(): string {
  const vaultDir = join(app.getPath('userData'), 'vaults')
  if (!existsSync(vaultDir)) mkdirSync(vaultDir, { recursive: true })
  return vaultDir
}

function getDbPath(userId?: string): string {
  const dbName = userId ? `vault-${userId}.db` : 'default.db'
  return join(getVaultDir(), dbName)
}

export function openVault(userId?: string): Database.Database {
  if (db) return db
  db = new Database(getDbPath(userId))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(VAULT_SCHEMA)
  return db
}

export function closeVault(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * E-4：备份 SQLite 主库前把 WAL 落盘（TRUNCATE）。否则 archiver 对 default.db 与其
 * -wal 的读取非原子，并发写入期间备份可能得到事务不一致的快照。
 * 失败不阻断备份（WAL 数据仍在，只是未并入主库）。
 */
export function checkpointVault(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('[vault] Database not opened')
  return db
}

export function vaultRead(namespace: string, key: string): string | null {
  const d = getDb()
  const row = d.prepare('SELECT value, encrypted FROM kv_store WHERE namespace = ? AND key = ?').get(namespace, key) as { value: string; encrypted: number } | undefined
  if (!row) return null
  if (row.encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      const buf = Buffer.from(row.value, 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return row.value
    }
  }
  return row.value
}

export function vaultWrite(namespace: string, key: string, value: string, encrypted: boolean = false): void {
  const d = getDb()
  let storeValue = value
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    storeValue = safeStorage.encryptString(value).toString('base64')
  }
  d.prepare(`
    INSERT INTO kv_store (namespace, key, value, encrypted, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at
  `).run(namespace, key, storeValue,
    // A-18：safeStorage 不可用时值以明文入库，标志必须同步写 0，
    // 否则 secrets 明文落盘且标志与内容永久不一致
    encrypted && safeStorage.isEncryptionAvailable() ? 1 : 0, Date.now())
}

export function vaultDelete(namespace: string, key: string): void {
  getDb().prepare('DELETE FROM kv_store WHERE namespace = ? AND key = ?').run(namespace, key)
}

export function vaultList(namespace?: string): string[] {
  const d = getDb()
  if (namespace) {
    const rows = d.prepare('SELECT key FROM kv_store WHERE namespace = ?').all(namespace) as { key: string }[]
    return rows.map(r => r.key)
  }
  const rows = d.prepare("SELECT namespace || ':' || key AS fullKey FROM kv_store").all() as { fullKey: string }[]
  return rows.map(r => r.fullKey)
}

// B-6：vault vector 读写/统计/迁移辅助函数随死通道一并删除
// （vaultReadVector/vaultWriteVector/vaultDeleteVector/vaultListVectors/
//   vaultGetMeta/vaultSetMeta/vaultGetStats/migrateToVault —— 渲染层零调用）
// vectors/vault_meta 表保留在 schema 中，兼容既有数据库文件。
