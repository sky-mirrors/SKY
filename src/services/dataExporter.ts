import type { ImportPreview, ImportPreviewItem } from '@/models'
import { vault } from '@/vault'

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

async function collectApiConfig(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await vault.read('config', 'holo-api-config')
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

async function collectKnowledge(): Promise<Record<string, unknown> | null> {
  try {
    const groupsRaw = await vault.read('knowledge', 'holo-knowledge-groups')
    const entriesRaw = await vault.read('knowledge', 'holo-knowledge-entries')
    return {
      groups: groupsRaw ? JSON.parse(groupsRaw) : [],
      entries: entriesRaw ? JSON.parse(entriesRaw) : []
    }
  } catch { return null }
}

async function collectConversations(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await vault.read('conv', 'holo-conv-chunks')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function collectPipelines(): Promise<Record<string, unknown> | null> {
  const pipelines: Record<string, unknown> = {}
  const allKeys = await vault.list('pipeline')
  for (const fullKey of allKeys) {
    if (fullKey.startsWith('holo-pipeline-')) {
      const val = await vault.read('pipeline', fullKey)
      if (val) pipelines[fullKey] = JSON.parse(val)
    }
  }
  return Object.keys(pipelines).length > 0 ? pipelines : null
}

async function collectSkills(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await vault.read('skill', 'holo-skill-store')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function collectCache(): Promise<Record<string, unknown> | null> {
  const cache: Record<string, unknown> = {}
  const routingRaw = await vault.read('routing', 'holo-routing-history')
  if (routingRaw) cache['routing'] = JSON.parse(routingRaw)
  return Object.keys(cache).length > 0 ? cache : null
}

async function collectVectors(): Promise<Record<string, unknown> | null> {
  const vectors: Record<string, unknown> = {}
  const allKeys = await vault.list('knowledge')
  for (const fullKey of allKeys) {
    if (fullKey.startsWith('holo-knowledge-') && fullKey !== 'holo-knowledge-groups' && fullKey !== 'holo-knowledge-entries') {
      const val = await vault.read('knowledge', fullKey)
      if (val) vectors[fullKey] = val
    }
  }
  return Object.keys(vectors).length > 0 ? vectors : null
}

const COLLECTORS: Record<string, { collect: () => Promise<Record<string, unknown> | null>; label: string }> = {
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
        defaultName: `holostarmap-export-${new Date().toISOString().slice(0, 10)}.json`
      })
      if (result.success) return
    } catch { /* fallback to download */ }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `holostarmap-export-${new Date().toISOString().slice(0, 10)}.json`
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
  const data = JSON.parse(fileContent) as ExportData

  for (const item of preview.items) {
    const sectionData = data[item.category]
    if (!sectionData) continue

    const { namespace, key } = getVaultTargetForCategory(item.category)

    switch (item.strategy) {
      case 'overwrite': {
        if (key) {
          await vault.write(namespace, key, JSON.stringify(sectionData))
        }
        break
      }
      case 'merge': {
        if (key) {
          try {
            if (item.category === 'knowledge') {
              const existingRaw = await vault.read(namespace, key)
              const existingEntries = existingRaw ? (JSON.parse(existingRaw) as unknown[]) : []
              const kd = sectionData as Record<string, unknown>
              const incomingEntries = Array.isArray(kd.entries) ? (kd.entries as unknown[]) : []
              const merged = mergeArrays(existingEntries, incomingEntries, item.category)
              await vault.write(namespace, key, JSON.stringify(merged))
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
            existingArr.push(...incoming)
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
    case 'api-config': return { namespace: 'config', key: 'holo-api-config' }
    case 'knowledge': return { namespace: 'knowledge', key: 'holo-knowledge-entries' }
    case 'conversations': return { namespace: 'conv', key: 'holo-conv-chunks' }
    case 'skills': return { namespace: 'skill', key: 'holo-skill-store' }
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
