import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/vault', () => ({
  vault: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    readCache: vi.fn(() => null),
    writeThrough: vi.fn(),
  },
}))

import { vault } from '@/vault'
import {
  validateImportedApiConfig,
  validateImportedKnowledge,
  validateImportedVectors,
} from '@/services/importValidation'
import { applyImport } from '@/services/dataExporter'
import type { ImportPreview } from '@/models'

const write = vault.write as unknown as ReturnType<typeof vi.fn>

describe('D-1: 导入侧 schema 校验', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('validateImportedApiConfig', () => {
    it('合法 providers → 通过', () => {
      expect(validateImportedApiConfig({ providers: [{ id: 'a', baseUrl: 'https://api.example.com' }] }).ok).toBe(true)
    })
    it('providers 非数组 → 拒绝', () => {
      expect(validateImportedApiConfig({ providers: { evil: true } }).ok).toBe(false)
    })
    it('baseUrl 非 http(s) 协议 → 拒绝', () => {
      expect(validateImportedApiConfig({ providers: [{ id: 'a', baseUrl: 'file:///etc/passwd' }] }).ok).toBe(false)
      expect(validateImportedApiConfig({ providers: [{ id: 'a', baseUrl: 'javascript:alert(1)' }] }).ok).toBe(false)
    })
    it('provider 缺 id / id 非字符串 → 拒绝', () => {
      expect(validateImportedApiConfig({ providers: [{ baseUrl: 'https://x' }] }).ok).toBe(false)
      expect(validateImportedApiConfig({ providers: [{ id: 42 }] }).ok).toBe(false)
    })
  })

  describe('validateImportedKnowledge', () => {
    it('合法 entries/groups → 通过', () => {
      expect(validateImportedKnowledge({ entries: [{ id: 'e1', filename: 'a' }], groups: [{ id: 'g1' }] }).ok).toBe(true)
    })
    it('entries 非数组 → 拒绝', () => {
      expect(validateImportedKnowledge({ entries: 'nope' }).ok).toBe(false)
    })
    it('entry 缺字符串 id → 拒绝', () => {
      expect(validateImportedKnowledge({ entries: [{ filename: 'x' }] }).ok).toBe(false)
    })
    it('groups 非数组 → 拒绝', () => {
      expect(validateImportedKnowledge({ entries: [], groups: {} }).ok).toBe(false)
    })
  })

  describe('validateImportedVectors', () => {
    it('键带 holo-kb-chunks- 前缀且值为 ChunkRecord 数组 → 合法', () => {
      const r = validateImportedVectors({
        'holo-kb-chunks-e1': JSON.stringify([{ text: 'hi', entryId: 'e1', chunkIndex: 0, vector: [0.1, 0.2], tokens: 2 }]),
      })
      expect(Object.keys(r.valid)).toEqual(['holo-kb-chunks-e1'])
      expect(r.rejected).toEqual([])
    })
    it('非前缀键 → 落入 rejected', () => {
      const r = validateImportedVectors({ 'api-config': '{"x":1}' })
      expect(Object.keys(r.valid)).toEqual([])
      expect(r.rejected).toEqual(['api-config'])
    })
    it('值不可解析为数组 → rejected', () => {
      const r = validateImportedVectors({ 'holo-kb-chunks-e1': '{"not":"array"}' })
      expect(r.rejected).toEqual(['holo-kb-chunks-e1'])
    })
    it('数组元素缺 text / vector 非数值数组 → rejected', () => {
      const r = validateImportedVectors({
        'holo-kb-chunks-e1': JSON.stringify([{ entryId: 'e1', vector: ['x'] }]),
      })
      expect(r.rejected).toEqual(['holo-kb-chunks-e1'])
    })
  })

  describe('applyImport 端到端（校验失败即拒写）', () => {
    const previewOf = (category: string, strategy: string): ImportPreview => ({
      sourceFile: 'f', exportDate: 'd', appVersion: 'v', warnings: [],
      items: [{ category, label: category, count: 1, strategy: strategy as never }],
    })

    it('畸形 api-config（providers 非数组）→ 抛错且不写 vault', async () => {
      const content = JSON.stringify({ manifest: { items: ['api-config'] }, 'api-config': { providers: { evil: true } } })
      await expect(applyImport(content, previewOf('api-config', 'overwrite'))).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
    })

    it('畸形 knowledge（entries 含缺 id 项）→ 抛错且不写 vault', async () => {
      const content = JSON.stringify({ manifest: { items: ['knowledge'] }, knowledge: { entries: [{ filename: 'x' }] } })
      await expect(applyImport(content, previewOf('knowledge', 'merge'))).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
    })

    it('合法 api-config → 正常写入', async () => {
      const content = JSON.stringify({
        manifest: { items: ['api-config'] },
        'api-config': { providers: [{ id: 'a', baseUrl: 'https://api.example.com', apiKey: '***' }] },
      })
      await applyImport(content, previewOf('api-config', 'overwrite'))
      expect(write).toHaveBeenCalledTimes(1)
    })
  })
})
