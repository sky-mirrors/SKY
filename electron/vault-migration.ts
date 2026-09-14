import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { app } from 'electron'
import { openVault, getDb, vaultWrite, vaultWriteVector, vaultSetMeta, vaultGetMeta } from './vault'

interface MigrationResult {
  migrated: number
  errors: number
}

export async function migrateToVault(localStorageData: Record<string, string>, storeDir: string, vectorDir: string): Promise<MigrationResult> {
  let migrated = 0
  let errors = 0
  // P1-4：记录失败条目，partial 时写入 vault_meta 供诊断与重试
  const failedKeys: string[] = []

  const db = openVault()

  const insertKv = db.prepare(`
    INSERT INTO kv_store (namespace, key, value, encrypted, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  const nsMap: Record<string, string> = {
    'holo-user-config': 'config',
    'holo-api-config': 'api',
    'holo-dialog-messages': 'dialog',
    'holo-dialog-mode': 'dialog',
    'holo-history-summary': 'dialog',
    'holo-feedback-entries': 'feedback',
    'holo-skill-weights': 'feedback',
    'holo-side-effects': 'feedback',
    'holo-knowledge-groups': 'knowledge',
    'holo-knowledge-entries': 'knowledge',
    'holo-mcp-connections': 'mcp',
    'holo-conversations': 'memory',
    'holo-conversation-summaries': 'memory',
    'holo-session-archive': 'memory',
    'holo-session': 'memory',
    'holo-projects': 'memory',
    'holo-global-memory': 'memory',
    'holo-mcp-logs': 'memory',
    'holo-audit-logs': 'memory',
    'holo-history': 'node',
    'holo-notifications': 'notification',
    'holo-notification-settings': 'notification',
    'holo-sessions': 'session',
    'holo-active-session': 'session',
    'holo-skills': 'skill',
    'holo-pipelines': 'pipeline',
    'holo-workflow-logs': 'workflow',
    'holo-semantic-cache': 'cache',
    'holo-routing-history': 'routing',
    'holo-token-budget': 'budget',
    'holo-cost-records': 'budget',
    'holo-user-pricing': 'pricing',
    'holo-tool-index': 'tool',
    'holo-task-cases': 'task',
    'holo-custom-manifests': 'manifest',
    'holo-conv-summaries': 'conv',
    'holo-conv-chunks': 'conv',
    'proactive-behavior-log': 'proactive',
    'holo-pipeline-checkpoints': 'pipeline',
    'dag-checkpoints': 'dag',
    'holo-skill-store': 'skill',
  }

  const tx = db.transaction(() => {
    for (const [fullKey, value] of Object.entries(localStorageData)) {
      try {
        let ns = 'general'
        let key = fullKey
        if (nsMap[fullKey]) {
          ns = nsMap[fullKey]
          key = fullKey
        } else if (fullKey.startsWith('holo-kb-chunks-')) {
          ns = 'knowledge'
          key = fullKey
        } else if (fullKey.startsWith('holo-context-')) {
          ns = 'node'
          key = fullKey
        } else if (fullKey.startsWith('holo-knowledge-')) {
          ns = 'knowledge'
          key = fullKey
        } else if (fullKey.startsWith('holo-pipeline-')) {
          ns = 'pipeline'
          key = fullKey
        }
        insertKv.run(ns, key, value, Date.now())
        migrated++
      } catch (e) {
        errors++
        failedKeys.push(fullKey)
      }
    }
  })
  tx()

  if (existsSync(storeDir)) {
    try {
      const files = readdirSync(storeDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        try {
          const content = readFileSync(join(storeDir, file), 'utf-8')
          const key = file.replace('.json', '')
          insertKv.run('store', key, content, Date.now())
          migrated++
        } catch { errors++; failedKeys.push(`store:${file}`) }
      }
    } catch { /* store dir read error */ }
  }

  if (existsSync(vectorDir)) {
    try {
      const bins = readdirSync(vectorDir).filter(f => f.endsWith('.bin'))
      const metaFiles = readdirSync(vectorDir).filter(f => f.endsWith('.meta.json'))
      for (const bin of bins) {
        try {
          const key = bin.replace('.bin', '')
          const binData = readFileSync(join(vectorDir, bin))
          let metadata = '{}'
          const metaFile = key + '.meta.json'
          if (metaFiles.includes(metaFile)) {
            metadata = readFileSync(join(vectorDir, metaFile), 'utf-8')
          }
          vaultWriteVector('vector', key, metadata, binData)
          migrated++
        } catch { errors++; failedKeys.push(`vector:${bin}`) }
      }
    } catch { /* vector dir read error */ }
  }

  // P1-4：errors>0 时禁止写 migration_complete——完成标志会让失败条目永不重试，
  // 且渲染层据 success 清理源数据后失败条目即永久丢失。upsert 幂等，重试安全。
  if (errors === 0) {
    vaultSetMeta('migration_complete', new Date().toISOString())
  } else {
    vaultSetMeta('migration_partial', new Date().toISOString())
    vaultSetMeta('migration_failed_keys', JSON.stringify(failedKeys.slice(0, 200)))
  }
  vaultSetMeta('migration_count', String(migrated))
  vaultSetMeta('migration_errors', String(errors))

  return { migrated, errors }
}

export function isMigrationComplete(): boolean {
  return vaultGetMeta('migration_complete') !== null
}
