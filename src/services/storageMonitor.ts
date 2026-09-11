import type { StorageBreakdown } from '@/models'
import { vault } from '@/vault'

const STORE_KEY_MAP: Array<{ category: string; storeKey: string; vaultNamespace: string; label: string; canClean: boolean }> = [
  { category: 'knowledge_vectors', storeKey: 'holo-knowledge-', vaultNamespace: 'knowledge', label: '知识库向量', canClean: true },
  { category: 'conversation_history', storeKey: 'holo-conv-chunks', vaultNamespace: 'conv', label: '对话历史', canClean: true },
  { category: 'conversation_summaries', storeKey: 'holo-conv-summaries', vaultNamespace: 'conv', label: '对话摘要', canClean: true },
  { category: 'routing_history', storeKey: 'holo-routing-history', vaultNamespace: 'routing', label: '路由历史', canClean: true },
  { category: 'pipeline_checkpoints', storeKey: 'holo-pipeline-', vaultNamespace: 'pipeline', label: '流水线检查点', canClean: true },
  { category: 'skill_config', storeKey: 'holo-skill-store', vaultNamespace: 'skill', label: '技能配置', canClean: false },
  { category: 'mcp_config', storeKey: 'holo-mcp-connections', vaultNamespace: 'config', label: 'MCP配置', canClean: false },
  { category: 'api_config', storeKey: 'holo-api-config', vaultNamespace: 'config', label: 'API配置', canClean: false },
  { category: 'user_config', storeKey: 'holo-user-config', vaultNamespace: 'config', label: '用户配置', canClean: false },
  { category: 'notifications', storeKey: 'holo-notifications', vaultNamespace: 'notification', label: '通知记录', canClean: true },
  { category: 'notification_settings', storeKey: 'holo-notification-settings', vaultNamespace: 'notification', label: '通知设置', canClean: false },
  { category: 'debug_sessions', storeKey: 'holo-debug-', vaultNamespace: 'debug', label: '调试会话', canClean: true },
  { category: 'feedback', storeKey: 'holo-feedback-', vaultNamespace: 'feedback', label: '反馈记录', canClean: false },
  { category: 'memory', storeKey: 'holo-memory-', vaultNamespace: 'memory', label: '记忆数据', canClean: false },
  { category: 'rules', storeKey: 'holo-rule-', vaultNamespace: 'rule', label: '规则数据', canClean: false },
  { category: 'workflow_logs', storeKey: 'holo-workflow-', vaultNamespace: 'workflow', label: '工作流日志', canClean: true },
  { category: 'knowledge_groups', storeKey: 'holo-knowledge-groups', vaultNamespace: 'knowledge', label: '知识群组', canClean: false },
  { category: 'session_store', storeKey: 'holo-session-', vaultNamespace: 'session', label: '会话数据', canClean: true },
]

export async function calculateUsage(): Promise<StorageBreakdown[]> {
  const results: StorageBreakdown[] = []

  for (const item of STORE_KEY_MAP) {
    let totalBytes = 0
    if (item.storeKey.endsWith('-')) {
      const allKeys = await vault.list(item.vaultNamespace)
      for (const key of allKeys) {
        if (key.startsWith(item.storeKey)) {
          const val = await vault.read(item.vaultNamespace, key)
          if (val) totalBytes += val.length * 2
        }
      }
    } else {
      const val = await vault.read(item.vaultNamespace, item.storeKey)
      if (val) totalBytes = val.length * 2
    }
    if (totalBytes > 0) {
      results.push({
        category: item.category,
        sizeMB: totalBytes / 1024 / 1024,
        storeKey: item.storeKey,
        label: item.label,
        canClean: item.canClean
      })
    }
  }

  return results.sort((a, b) => b.sizeMB - a.sizeMB)
}

export async function getTotalUsedMB(): Promise<number> {
  const usage = await calculateUsage()
  return usage.reduce((sum, item) => sum + item.sizeMB, 0)
}

export async function shouldAlert(): Promise<boolean> {
  const totalMB = await getTotalUsedMB()
  return totalMB >= 4.0
}

export async function getUsageLevel(): Promise<'green' | 'orange' | 'red'> {
  const totalMB = await getTotalUsedMB()
  if (totalMB < 3.0) return 'green'
  if (totalMB < 4.0) return 'orange'
  return 'red'
}

export async function migrateVectorsToFiles(onProgress?: (done: number, total: number) => void): Promise<number> {
  const allKeys = await vault.list('knowledge')
  const keys = allKeys.filter(k => k.startsWith('holo-knowledge-'))

  if (keys.length === 0) return 0

  let migrated = 0
  for (const key of keys) {
    const value = await vault.read('knowledge', key)
    if (!value) continue

    try {
      const entryId = key.replace('holo-knowledge-', '')
      await window.electronAPI?.vectorWriteBin?.(entryId, value)
      await vault.delete('knowledge', key)
      migrated++
      onProgress?.(migrated, keys.length)
    } catch {
      break
    }
  }

  return migrated
}

export async function cleanExpiredCache(): Promise<number> {
  let cleaned = 0

  const routingRaw = await vault.read('routing', 'holo-routing-history')
  if (routingRaw) {
    try {
      const entries = JSON.parse(routingRaw) as Array<{ timestamp?: number }>
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
      const filtered = entries.filter(e => !e.timestamp || e.timestamp > sevenDaysAgo)
      if (filtered.length < entries.length) {
        await vault.write('routing', 'holo-routing-history', JSON.stringify(filtered))
        cleaned += entries.length - filtered.length
      }
    } catch { /* ignore */ }
  }

  const allKeys = await vault.list('pipeline')
  const checkpointKeys = allKeys.filter(k => k.startsWith('holo-pipeline-'))

  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000
  for (const key of checkpointKeys) {
    try {
      const raw = await vault.read('pipeline', key)
      if (raw) {
        const parsed = JSON.parse(raw) as { updatedAt?: number }
        if (parsed.updatedAt && parsed.updatedAt < twentyFourHoursAgo) {
          await vault.delete('pipeline', key)
          cleaned++
        }
      }
    } catch { /* ignore */ }
  }

  return cleaned
}
