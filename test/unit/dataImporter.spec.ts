import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vault } from '@/vault'
import { parseImportPreview, applyImport } from '@/services/dataExporter'
import type { ImportPreview } from '@/models'

describe('dataImporter', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
  })

  it('parseImportPreview parses valid export data', () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['api-config'] },
      'api-config': { providers: [] }
    }
    const preview = parseImportPreview(JSON.stringify(exportData))
    expect(preview).not.toBeNull()
    expect(preview!.items.length).toBe(1)
    expect(preview!.items[0].category).toBe('api-config')
  })

  it('parseImportPreview returns null for invalid JSON', () => {
    const preview = parseImportPreview('not valid json')
    expect(preview).toBeNull()
  })

  it('applyImport applies data with overwrite strategy', async () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['api-config'] },
      'api-config': { providers: [{ id: 'p1', name: 'Test', baseUrl: 'http://test.com' }] }
    }
    const content = JSON.stringify(exportData)
    const preview: ImportPreview = {
      sourceFile: 'test-export.json',
      exportDate: '2026-09-02',
      appVersion: '0.1.0',
      items: [{ category: 'api-config', label: 'API配置', count: 1, strategy: 'overwrite' }],
      warnings: []
    }
    await applyImport(content, preview)
    // C-04：api-config 实际存储于 ('api','holo-api-config') 命名空间
    const stored = vault.readCache('api', 'holo-api-config')
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored!)
    expect(parsed.providers.length).toBe(1)
    expect(parsed.providers[0].name).toBe('Test')
  })

  it('applyImport applies data with merge strategy', async () => {
    vault.writeCache('knowledge', 'holo-knowledge-entries', JSON.stringify([{ id: 'e1', name: 'Existing' }]))
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['knowledge'] },
      'knowledge': { entries: [{ id: 'e2', name: 'New' }], groups: [] }
    }
    const content = JSON.stringify(exportData)
    const preview: ImportPreview = {
      sourceFile: 'test-export.json',
      exportDate: '2026-09-02',
      appVersion: '0.1.0',
      items: [{ category: 'knowledge', label: '知识库', count: 1, strategy: 'merge' }],
      warnings: []
    }
    await applyImport(content, preview)
    const stored = JSON.parse(vault.readCache('knowledge', 'holo-knowledge-entries')!)
    expect(stored.length).toBe(2)
    expect(stored[1].id).toBe('e2')
  })

  it('applyImport skips items with skip strategy', async () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['cache'] },
      'cache': { routing: [{ entry: 'test' }] }
    }
    const content = JSON.stringify(exportData)
    const preview: ImportPreview = {
      sourceFile: 'test-export.json',
      exportDate: '2026-09-02',
      appVersion: '0.1.0',
      items: [{ category: 'cache', label: '缓存', count: 1, strategy: 'skip' }],
      warnings: []
    }
    await applyImport(content, preview)
    expect(vault.readCache('routing', 'holo-routing-history')).toBeNull()
  })

  it('applyImport appends data with append strategy', async () => {
    // C-03：对话历史实际存储于 ('memory','holo-conversations')
    vault.writeCache('memory', 'holo-conversations', JSON.stringify([{ id: 'c1', text: 'Old' }]))
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['conversations'] },
      'conversations': [{ id: 'c2', text: 'New' }]
    }
    const content = JSON.stringify(exportData)
    const preview: ImportPreview = {
      sourceFile: 'test-export.json',
      exportDate: '2026-09-02',
      appVersion: '0.1.0',
      items: [{ category: 'conversations', label: '对话历史', count: 1, strategy: 'append' }],
      warnings: []
    }
    await applyImport(content, preview)
    const stored = JSON.parse(vault.readCache('memory', 'holo-conversations')!)
    expect(stored.length).toBe(2)
    expect(stored[1].id).toBe('c2')
  })
})
