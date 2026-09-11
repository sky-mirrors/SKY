import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFullMockElectronAPI, installMockElectronAPI, removeMockElectronAPI } from '../../test/utils/mockElectronAPI'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

describe('vectorStore', () => {
  let mockApi: ReturnType<typeof createFullMockElectronAPI>

  beforeEach(() => {
    mockLocalStorage()
    mockApi = installMockElectronAPI()
  })

  afterEach(() => {
    removeMockElectronAPI()
  })

  describe('saveChunksToFile', () => {
    it('returns false when vectorWriteBin unavailable', async () => {
      delete (window as any).electronAPI
      const { saveChunksToFile } = await import('@/services/vectorStore')
      const result = await saveChunksToFile('test-entry', [])
      expect(result).toBe(false)
    })

    it('saves chunks and returns true on success', async () => {
      mockApi.vectorWriteBin = vi.fn().mockResolvedValue(true)
      mockApi.storeWrite = vi.fn().mockResolvedValue(true)
      const { saveChunksToFile } = await import('@/services/vectorStore')
      const chunks = [
        { text: 'hello', chunkIndex: 0, vector: [1, 2, 3], tokens: 5 },
        { text: 'world', chunkIndex: 1, vector: [4, 5, 6], tokens: 5 }
      ]
      const result = await saveChunksToFile('test-entry', chunks)
      expect(result).toBe(true)
      expect(mockApi.vectorWriteBin).toHaveBeenCalledWith('vec-test-entry', expect.any(String))
      expect(mockApi.storeWrite).toHaveBeenCalledWith('chunks-meta-test-entry', expect.any(Array))
    })

    it('returns false when vectorWriteBin fails', async () => {
      mockApi.vectorWriteBin = vi.fn().mockResolvedValue(false)
      const { saveChunksToFile } = await import('@/services/vectorStore')
      const result = await saveChunksToFile('test-entry', [{ text: 'x', chunkIndex: 0, vector: [1], tokens: 1 }])
      expect(result).toBe(false)
    })
  })

  describe('loadChunksFromFile', () => {
    it('returns null when no electronAPI', async () => {
      delete (window as any).electronAPI
      const { loadChunksFromFile } = await import('@/services/vectorStore')
      const result = await loadChunksFromFile('test-entry')
      expect(result).toBeNull()
    })

    it('returns null when no metadata found', async () => {
      mockApi.storeRead = vi.fn().mockResolvedValue(null)
      const { loadChunksFromFile } = await import('@/services/vectorStore')
      const result = await loadChunksFromFile('test-entry')
      expect(result).toBeNull()
    })

    it('loads and reconstructs chunks from binary', async () => {
      const metas = [
        { entryId: 'test-entry', chunkIndex: 0, text: 'hello', tokens: 5, vectorOffset: 0, vectorDim: 3 },
        { entryId: 'test-entry', chunkIndex: 1, text: 'world', tokens: 5, vectorOffset: 3, vectorDim: 3 }
      ]
      mockApi.storeRead = vi.fn().mockResolvedValue(metas)

      const floatArr = new Float32Array([1.5, 2.5, 3.5, 4.5, 5.5, 6.5])
      const buf = new ArrayBuffer(floatArr.byteLength)
      new Float32Array(buf).set(floatArr)
      const bytes = new Uint8Array(buf)
      mockApi.vectorReadBin = vi.fn().mockResolvedValue(bytes)

      const { loadChunksFromFile } = await import('@/services/vectorStore')
      const result = await loadChunksFromFile('test-entry')
      expect(result).not.toBeNull()
      expect(result!.length).toBe(2)
      expect(result![0].text).toBe('hello')
      expect(result![0].vector).toEqual([1.5, 2.5, 3.5])
      expect(result![1].text).toBe('world')
      expect(result![1].vector).toEqual([4.5, 5.5, 6.5])
    })
  })

  describe('listVectorEntries', () => {
    it('returns empty when no electronAPI', async () => {
      delete (window as any).electronAPI
      const { listVectorEntries } = await import('@/services/vectorStore')
      const result = await listVectorEntries()
      expect(result).toEqual([])
    })

    it('returns keys from vectorListKeys', async () => {
      mockApi.vectorListKeys = vi.fn().mockResolvedValue(['vec-a', 'vec-b'])
      const { listVectorEntries } = await import('@/services/vectorStore')
      const result = await listVectorEntries()
      expect(result).toEqual(['vec-a', 'vec-b'])
    })
  })

  describe('migrateFromLocalStorage', () => {
    it('returns 0 when no electronAPI', async () => {
      delete (window as any).electronAPI
      const { migrateFromLocalStorage } = await import('@/services/vectorStore')
      const result = await migrateFromLocalStorage()
      expect(result).toBe(0)
    })

    it('migrates holo-kb-chunks-* keys and removes them', async () => {
      const chunks = [{ text: 'hello', entryId: 'abc', chunkIndex: 0, vector: [1, 2], tokens: 5 }]
      localStorage.setItem('holo-kb-chunks-abc', JSON.stringify(chunks))
      localStorage.setItem('holo-kb-chunks-def', JSON.stringify(chunks))
      localStorage.setItem('other-key', 'keep')

      mockApi.storeRead = vi.fn().mockResolvedValue(null)
      mockApi.vectorWriteBin = vi.fn().mockResolvedValue(true)
      mockApi.storeWrite = vi.fn().mockResolvedValue(true)

      const { migrateFromLocalStorage } = await import('@/services/vectorStore')
      const count = await migrateFromLocalStorage()
      expect(count).toBe(2)
      expect(localStorage.getItem('holo-kb-chunks-abc')).toBeNull()
      expect(localStorage.getItem('holo-kb-chunks-def')).toBeNull()
      expect(localStorage.getItem('other-key')).toBe('keep')
    })

    it('skips already-migrated entries', async () => {
      localStorage.setItem('holo-kb-chunks-abc', JSON.stringify([{ text: 'x', entryId: 'abc', chunkIndex: 0, vector: [1], tokens: 1 }]))
      mockApi.storeRead = vi.fn().mockResolvedValue('exists')

      const { migrateFromLocalStorage } = await import('@/services/vectorStore')
      const count = await migrateFromLocalStorage()
      expect(count).toBe(0)
    })
  })
})
