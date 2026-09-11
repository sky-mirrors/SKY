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
  `).run(namespace, key, storeValue, encrypted ? 1 : 0, Date.now())
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
  const rows = d.prepare('SELECT namespace || ":" || key AS fullKey FROM kv_store').all() as { fullKey: string }[]
  return rows.map(r => r.fullKey)
}

export function vaultReadVector(namespace: string, key: string): { metadata: string; embedding: Buffer } | null {
  const d = getDb()
  const row = d.prepare('SELECT metadata, embedding FROM vectors WHERE namespace = ? AND key = ?').get(namespace, key) as { metadata: string; embedding: Buffer } | undefined
  if (!row) return null
  return { metadata: row.metadata, embedding: row.embedding }
}

export function vaultWriteVector(namespace: string, key: string, metadata: string, embedding: Buffer): void {
  const d = getDb()
  d.prepare(`
    INSERT INTO vectors (namespace, key, metadata, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET metadata = excluded.metadata, embedding = excluded.embedding, updated_at = excluded.updated_at
  `).run(namespace, key, metadata, embedding, Date.now())
}

export function vaultDeleteVector(namespace: string, key: string): void {
  getDb().prepare('DELETE FROM vectors WHERE namespace = ? AND key = ?').run(namespace, key)
}

export function vaultListVectors(namespace?: string): string[] {
  const d = getDb()
  if (namespace) {
    const rows = d.prepare('SELECT key FROM vectors WHERE namespace = ?').all(namespace) as { key: string }[]
    return rows.map(r => r.key)
  }
  const rows = d.prepare('SELECT namespace || ":" || key AS fullKey FROM vectors').all() as { fullKey: string }[]
  return rows.map(r => r.fullKey)
}

export function vaultGetMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM vault_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function vaultSetMeta(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)').run(key, value)
}

export function vaultGetStats(): { tables: number; rows: number; sizeBytes: number } {
  const d = getDb()
  const kvCount = (d.prepare('SELECT COUNT(*) AS c FROM kv_store').get() as { c: number }).c
  const vecCount = (d.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
  const metaCount = (d.prepare('SELECT COUNT(*) AS c FROM vault_meta').get() as { c: number }).c
  const dbPath = getDbPath()
  let sizeBytes = 0
  try { sizeBytes = existsSync(dbPath) ? require('fs').statSync(dbPath).size : 0 } catch { /* empty */ }
  return { tables: 3, rows: kvCount + vecCount + metaCount, sizeBytes }
}
