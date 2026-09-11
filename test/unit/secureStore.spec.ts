import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { storeGet, storeSet, storeDelete, migrateFromLocalStorage } from '@/services/secureStore'
import { vault } from '@/vault'

describe('secureStore', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('storeGet', () => {
    it('returns null for nonexistent key', async () => {
      const val = await storeGet('nonexistent')
      expect(val).toBeNull()
    })

    it('returns value from vault cache when API returns null', async () => {
      vault.writeCache('secure', 'holo-test-key', JSON.stringify('local-value'))
      const val = await storeGet('test-key')
      expect(val).toBe('local-value')
    })

    it('returns value from vault API when available', async () => {
      vi.stubGlobal('window', {
        electronAPI: {
          vaultRead: vi.fn().mockResolvedValue(JSON.stringify({ data: 'from-electron' })),
          vaultWrite: vi.fn().mockResolvedValue(undefined),
          vaultDelete: vi.fn().mockResolvedValue(undefined),
          vaultList: vi.fn().mockResolvedValue([]),
        }
      })
      const val = await storeGet('test-key')
      expect(val).toEqual({ data: 'from-electron' })
    })
  })

  describe('storeSet', () => {
    it('writes to vault cache', async () => {
      const result = await storeSet('my-key', 'my-value')
      expect(result).toBe(true)
      expect(vault.readCache('secure', 'holo-my-key')).toBe(JSON.stringify('my-value'))
    })

    it('writes object to vault cache', async () => {
      const obj = { name: 'test', count: 42 }
      await storeSet('obj-key', obj)
      expect(JSON.parse(vault.readCache('secure', 'holo-obj-key')!)).toEqual(obj)
    })

    it('calls electronAPI.vaultWrite when available', async () => {
      await storeSet('e-key', 'e-value')
      const api = (window as any).electronAPI
      expect(api.vaultWrite).toHaveBeenCalledWith('secure', 'holo-e-key', JSON.stringify('e-value'), undefined)
    })
  })

  describe('storeDelete', () => {
    it('removes from vault cache', async () => {
      vault.writeCache('secure', 'holo-del-key', JSON.stringify('value'))
      const result = await storeDelete('del-key')
      expect(result).toBe(true)
      expect(vault.readCache('secure', 'holo-del-key')).toBeNull()
    })

    it('calls electronAPI.vaultDelete when available', async () => {
      await storeDelete('del-key')
      const api = (window as any).electronAPI
      expect(api.vaultDelete).toHaveBeenCalledWith('secure', 'holo-del-key')
    })
  })

  describe('migrateFromLocalStorage', () => {
    it('returns 0 when vault API unavailable', async () => {
      vi.stubGlobal('window', {})
      const count = await migrateFromLocalStorage(['key1', 'key2'])
      expect(count).toBe(0)
    })

    it('migrates keys from vault cache to vault API', async () => {
      vault.writeCache('secure', 'holo-migrate-key', JSON.stringify('migrate-value'))
      vi.spyOn(vault, 'read').mockResolvedValue(null)
      const api = (window as any).electronAPI

      const count = await migrateFromLocalStorage(['migrate-key'])
      expect(count).toBe(1)
      expect(api.vaultWrite).toHaveBeenCalledWith('secure', 'holo-migrate-key', JSON.stringify('migrate-value'), undefined)
    })

    it('skips keys already in vault', async () => {
      vault.writeCache('secure', 'holo-exist-key', JSON.stringify('existing'))
      vi.stubGlobal('window', {
        electronAPI: {
          vaultRead: vi.fn().mockResolvedValue('already-there'),
          vaultWrite: vi.fn().mockResolvedValue(undefined),
          vaultDelete: vi.fn().mockResolvedValue(undefined),
          vaultList: vi.fn().mockResolvedValue([]),
        }
      })

      const count = await migrateFromLocalStorage(['exist-key'])
      expect(count).toBe(0)
    })

    it('skips keys not in vault cache', async () => {
      vi.stubGlobal('window', {
        electronAPI: {
          vaultRead: vi.fn().mockResolvedValue(null),
          vaultWrite: vi.fn().mockResolvedValue(undefined),
          vaultDelete: vi.fn().mockResolvedValue(undefined),
          vaultList: vi.fn().mockResolvedValue([]),
        }
      })

      const count = await migrateFromLocalStorage(['nonexistent-key'])
      expect(count).toBe(0)
    })
  })
})
