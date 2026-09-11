import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vault } from '@/vault'
import { buildExportData, parseImportPreview } from '@/services/dataExporter'

describe('dataExporter', () => {
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

  it('buildExportData creates manifest with correct items', async () => {
    const data = await buildExportData(['api-config', 'skills'])
    expect(data.manifest.version).toBe('1.0')
    expect(data.manifest.items).toEqual(['api-config', 'skills'])
    expect(data.manifest.appVersion).toBe('0.1.0')
  })

  it('buildExportData collects API config with sanitized keys', async () => {
    vault.writeCache('config', 'holo-api-config', JSON.stringify({
      providers: [{ id: 'p1', name: 'Test', apiKey: 'secret-key-123', baseUrl: 'http://test.com' }],
      baseUrl: 'http://test.com'
    }))
    const data = await buildExportData(['api-config'])
    const apiSection = data['api-config'] as Record<string, unknown>
    const providers = apiSection.providers as Array<Record<string, unknown>>
    expect(providers[0].apiKey).toBe('***')
  })

  it('buildExportData skips items with no data', async () => {
    const data = await buildExportData(['conversations'])
    expect(data['conversations']).toBeUndefined()
  })

  it('parseImportPreview returns null for invalid JSON', () => {
    expect(parseImportPreview('not json')).toBeNull()
  })

  it('parseImportPreview returns null for missing manifest', () => {
    expect(parseImportPreview('{"no_manifest": true}')).toBeNull()
  })

  it('parseImportPreview returns preview with correct strategies', () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['api-config', 'knowledge', 'conversations', 'skills', 'cache'] },
      'api-config': { providers: [] },
      'knowledge': { entries: [{ id: 'e1' }], groups: [] },
      'conversations': [],
      'skills': { installedSkills: [] },
      'cache': { routing: [] }
    }
    const preview = parseImportPreview(JSON.stringify(exportData))
    expect(preview).not.toBeNull()
    expect(preview!.items.length).toBe(5)
    const apiItem = preview!.items.find(i => i.category === 'api-config')
    expect(apiItem!.strategy).toBe('overwrite')
    const knowledgeItem = preview!.items.find(i => i.category === 'knowledge')
    expect(knowledgeItem!.strategy).toBe('merge')
    const convItem = preview!.items.find(i => i.category === 'conversations')
    expect(convItem!.strategy).toBe('append')
    const cacheItem = preview!.items.find(i => i.category === 'cache')
    expect(cacheItem!.strategy).toBe('skip')
  })

  it('parseImportPreview includes API key warning', () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['api-config'] },
      'api-config': { providers: [{ apiKey: '***' }] }
    }
    const preview = parseImportPreview(JSON.stringify(exportData))
    expect(preview!.warnings).toContain('API Key需重新输入(导出时已脱敏)')
  })

  it('parseImportPreview counts items correctly', () => {
    const exportData = {
      manifest: { version: '1.0', date: '2026-09-02', appVersion: '0.1.0', items: ['knowledge'] },
      'knowledge': { entries: [{ id: 'e1' }, { id: 'e2' }], groups: [] }
    }
    const preview = parseImportPreview(JSON.stringify(exportData))
    const knowledgeItem = preview!.items.find(i => i.category === 'knowledge')
    expect(knowledgeItem!.count).toBe(2)
  })
})
