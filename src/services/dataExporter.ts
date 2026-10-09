import type { ImportPreview, ImportPreviewItem } from '@/models'
import { vault } from '@/vault'
import { validateImportedApiConfig, validateImportedKnowledge, validateImportedVectors } from './importValidation'

export interface ExportData {
  manifest: {
    version: string
    date: string
    appVersion: string
    items: string[]
  }
  [category: string]: unknown
}

const APP_VERSION = '0.1.0'

async function collectApiConfig(): Promise<unknown> {
  try {
    // C-04：apiStore 实际持久化于 ('api','holo-api-config')，旧代码误读 'config' 命名空间
    const raw = await vault.read('api', 'holo-api-config')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.providers && Array.isArray(parsed.providers)) {
      parsed.providers = (parsed.providers as Array<Record<string, unknown>>).map(p => ({
        ...p,
        apiKey: '***'
      }))
    }
    return parsed
  } catch { return null }
}

async function collectKnowledge(): Promise<unknown> {
  try {
    const groupsRaw = await vault.read('knowledge', 'holo-knowledge-groups')
    const entriesRaw = await vault.read('knowledge', 'holo-knowledge-entries')
    return {
      groups: groupsRaw ? JSON.parse(groupsRaw) : [],
      entries: entriesRaw ? JSON.parse(entriesRaw) : []
    }
  } catch { return null }
}

async function collectConversations(): Promise<unknown> {
  try {
    // C-03：memoryStore 实际持久化于 ('memory','holo-conversations')，旧键 'conv:holo-conv-chunks' 从无写入方
    const raw = await vault.read('memory', 'holo-conversations')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function collectPipelines(): Promise<unknown> {
  try {
    // C-02：pipelineStore 将全部流水线存于单键 'holo-pipelines'，旧代码按 'holo-pipeline-' 前缀扫描恒为空
    const raw = await vault.read('pipeline', 'holo-pipelines')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function collectSkills(): Promise<unknown> {
  try {
    // C-01：skillStore 实际持久化键为 'holo-skills'，旧键 'holo-skill-store' 从无写入方
    const raw = await vault.read('skill', 'holo-skills')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function collectCache(): Promise<unknown> {
  const cache: Record<string, unknown> = {}
  const routingRaw = await vault.read('routing', 'holo-routing-history')
  if (routingRaw) cache['routing'] = JSON.parse(routingRaw)
  return Object.keys(cache).length > 0 ? cache : null
}

async function collectVectors(): Promise<unknown> {
  const vectors: Record<string, unknown> = {}
  const allKeys = await vault.list('knowledge')
  for (const fullKey of allKeys) {
    // C-05：chunk 向量实际存储键为 'holo-kb-chunks-${entryId}'，旧过滤条件排除了全部数据
    if (fullKey.startsWith('holo-kb-chunks-')) {
      const val = await vault.read('knowledge', fullKey)
      if (val) vectors[fullKey] = val
    }
  }
  return Object.keys(vectors).length > 0 ? vectors : null
}

const COLLECTORS: Record<string, { collect: () => Promise<unknown>; label: string }> = {
  'api-config': { collect: collectApiConfig, label: 'API配置' },
  'knowledge': { collect: collectKnowledge, label: '知识库' },
  'conversations': { collect: collectConversations, label: '对话历史' },
  'pipelines': { collect: collectPipelines, label: '流水线配置' },
  'skills': { collect: collectSkills, label: 'L2技能配置' },
  'cache': { collect: collectCache, label: '路由历史与缓存' },
  'vectors': { collect: collectVectors, label: '向量索引' },
}

export async function buildExportData(items: string[]): Promise<ExportData> {
  const data: ExportData = {
    manifest: {
      version: '1.0',
      date: new Date().toISOString(),
      appVersion: APP_VERSION,
      items
    }
  }

  for (const item of items) {
    const collector = COLLECTORS[item]
    if (collector) {
      const result = await collector.collect()
      if (result) data[item] = result
    }
  }

  return data
}

export async function exportToZip(items: string[]): Promise<void> {
  const data = await buildExportData(items)
  const jsonStr = JSON.stringify(data, null, 2)
  const blob = new Blob([jsonStr], { type: 'application/json' })

  if (window.electronAPI?.dataExportZip) {
    try {
      const result = await window.electronAPI.dataExportZip({
        data: jsonStr,
        defaultName: `sky-export-${new Date().toISOString().slice(0, 10)}.json`
      })
      if (result.success) return
    } catch { /* fallback to download */ }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sky-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function parseImportPreview(fileContent: string): ImportPreview | null {
  try {
    const data = JSON.parse(fileContent) as ExportData
    const manifest = data.manifest
    if (!manifest || !manifest.items) return null

    const items: ImportPreviewItem[] = manifest.items.map((category: string) => {
      const strategy: ImportPreviewItem['strategy'] = (() => {
        switch (category) {
          case 'api-config': return 'overwrite'
          case 'knowledge': return 'merge'
          case 'conversations': return 'append'
          case 'pipelines': return 'overwrite'
          case 'skills': return 'merge'
          case 'cache': return 'skip'
          case 'vectors': return 'overwrite'
          default: return 'skip'
        }
      })()

      const collector = COLLECTORS[category]
      const sectionData = data[category]

      let count = 0
      if (sectionData && typeof sectionData === 'object') {
        if (Array.isArray(sectionData)) {
          count = sectionData.length
        } else if (category === 'pipelines' || category === 'vectors') {
          count = Object.keys(sectionData).length
        } else if (category === 'knowledge') {
          const kd = sectionData as Record<string, unknown>
          count = Array.isArray(kd.entries) ? (kd.entries as unknown[]).length : 0
        } else {
          count = 1
        }
      }

      return {
        category,
        label: collector?.label ?? category,
        count,
        strategy
      }
    })

    const warnings: string[] = []
    if (data['api-config']) {
      warnings.push('API Key需重新输入(导出时已脱敏)')
    }

    return {
      sourceFile: 'import-data',
      exportDate: manifest.date,
      appVersion: manifest.appVersion,
      items,
      warnings
    }
  } catch {
    return null
  }
}

export async function applyImport(fileContent: string, preview: ImportPreview): Promise<void> {
  // C-30：预览与确认之间文件可能被替换/损坏，顶层解析必须有保护
  let data: ExportData
  try {
    data = JSON.parse(fileContent) as ExportData
  } catch (err) {
    throw new Error(`导入文件解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // D-1：导入文件是不可信输入——先对全部待导入段做 schema 校验（任一失败即整体拒绝），
  // 再开始写入，避免「写了一半才发现文件畸形」的半成品状态。
  for (const item of preview.items) {
    const section = data[item.category]
    if (!section) continue
    if (item.category === 'api-config') {
      const r = validateImportedApiConfig(section)
      if (!r.ok) throw new Error(`导入校验失败（api-config）：${r.reason}`)
    } else if (item.category === 'knowledge') {
      const r = validateImportedKnowledge(section)
      if (!r.ok) throw new Error(`导入校验失败（knowledge）：${r.reason}`)
    } else if (item.category === 'vectors') {
      const r = validateImportedVectors(section)
      if (r.rejected.length > 0) {
        throw new Error(`导入校验失败（vectors）：${r.rejected.length} 个条目结构非法（首个：${r.rejected[0].key} —— ${r.rejected[0].reason}）`)
      }
    }
  }

  for (const item of preview.items) {
    const sectionData = data[item.category]
    if (!sectionData) continue

    const { namespace, key } = getVaultTargetForCategory(item.category)

    switch (item.strategy) {
      case 'overwrite': {
        // C-06：vectors 为逐 entry 多键存储（'holo-kb-chunks-${entryId}'），需逐键写回
        if (item.category === 'vectors') {
          const vd = sectionData as Record<string, unknown>
          for (const [vecKey, vecVal] of Object.entries(vd)) {
            if (vecKey.startsWith('holo-kb-chunks-')) {
              await vault.write('knowledge', vecKey, typeof vecVal === 'string' ? vecVal : JSON.stringify(vecVal))
            }
          }
          break
        }
        if (item.category === 'api-config') {
          // C-04：导出时 apiKey 被脱敏为 '***'，导入时保留本机已有同 id provider 的真实 key
          const imported = { ...(sectionData as Record<string, unknown>) }
          try {
            const existingRaw = await vault.read('api', 'holo-api-config')
            if (existingRaw) {
              const existing = JSON.parse(existingRaw) as Record<string, unknown>
              if (Array.isArray(imported.providers) && Array.isArray(existing.providers)) {
                imported.providers = (imported.providers as Array<Record<string, unknown>>).map(p => {
                  if (p.apiKey === '***') {
                    const match = (existing.providers as Array<Record<string, unknown>>).find(e => e.id === p.id)
                    if (match && typeof match.apiKey === 'string' && match.apiKey !== '***') {
                      return { ...p, apiKey: match.apiKey }
                    }
                  }
                  return p
                })
              }
            }
          } catch { /* 保留导入原样 */ }
          await vault.write('api', 'holo-api-config', JSON.stringify(imported), true)
          break
        }
        if (key) {
          await vault.write(namespace, key, JSON.stringify(sectionData))
        }
        break
      }
      case 'merge': {
        if (key) {
          try {
            if (item.category === 'knowledge') {
              // C-06：合并时不得丢弃 groups（知识分组）
              const kd = sectionData as Record<string, unknown>
              const incomingEntries = Array.isArray(kd.entries) ? (kd.entries as unknown[]) : []
              const existingEntriesRaw = await vault.read(namespace, key)
              const existingEntries = existingEntriesRaw ? (JSON.parse(existingEntriesRaw) as unknown[]) : []
              const mergedEntries = mergeArrays(existingEntries, incomingEntries, item.category)
              await vault.write(namespace, key, JSON.stringify(mergedEntries))
              const incomingGroups = Array.isArray(kd.groups) ? (kd.groups as unknown[]) : []
              if (incomingGroups.length > 0) {
                const existingGroupsRaw = await vault.read('knowledge', 'holo-knowledge-groups')
                const existingGroups = existingGroupsRaw ? (JSON.parse(existingGroupsRaw) as unknown[]) : []
                const mergedGroups = mergeArrays(existingGroups, incomingGroups, item.category)
                await vault.write('knowledge', 'holo-knowledge-groups', JSON.stringify(mergedGroups))
              }
            } else {
              const existing = await vault.read(namespace, key)
              const existingArr = existing ? JSON.parse(existing) as unknown[] : []
              const incoming = Array.isArray(sectionData) ? sectionData : [sectionData]
              const merged = mergeArrays(existingArr, incoming, item.category)
              await vault.write(namespace, key, JSON.stringify(merged))
            }
          } catch {
            await vault.write(namespace, key, JSON.stringify(sectionData))
          }
        }
        break
      }
      case 'append': {
        if (key) {
          try {
            const existing = await vault.read(namespace, key)
            const existingArr = existing ? JSON.parse(existing) as unknown[] : []
            const incoming = Array.isArray(sectionData) ? sectionData : [sectionData]
            // 按会话 id 去重合并，避免重复导入产生副本
            const existingIds = new Set(existingArr.map(c =>
              typeof c === 'object' && c !== null ? (c as Record<string, unknown>).id : null))
            const deduped = incoming.filter(c =>
              !(typeof c === 'object' && c !== null && existingIds.has((c as Record<string, unknown>).id)))
            existingArr.push(...deduped)
            await vault.write(namespace, key, JSON.stringify(existingArr))
          } catch {
            await vault.write(namespace, key, JSON.stringify(sectionData))
          }
        }
        break
      }
      case 'skip':
        break
    }
  }
}

function getVaultTargetForCategory(category: string): { namespace: string; key: string | null } {
  switch (category) {
    case 'api-config': return { namespace: 'api', key: 'holo-api-config' }
    case 'knowledge': return { namespace: 'knowledge', key: 'holo-knowledge-entries' }
    case 'conversations': return { namespace: 'memory', key: 'holo-conversations' }
    case 'pipelines': return { namespace: 'pipeline', key: 'holo-pipelines' }
    case 'skills': return { namespace: 'skill', key: 'holo-skills' }
    default: return { namespace: 'data', key: null }
  }
}

function mergeArrays(existing: unknown[], incoming: unknown[], category: string): unknown[] {
  const idKey = category === 'knowledge' ? 'id' : 'id'
  const existingIds = new Set(
    existing.map(item => typeof item === 'object' && item !== null ? (item as Record<string, unknown>).id : null)
  )
  const newItems = incoming.filter(item => {
    const id = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).id : null
    return id !== null && !existingIds.has(id)
  })
  return [...existing, ...newItems]
}
