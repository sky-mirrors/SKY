import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { vault } from '@/vault'
import { logManifestUsage, initProactiveScheduler } from '@/services/proactiveScheduler'

const BEHAVIOR_KEY = 'proactive-behavior-log'

describe('proactiveScheduler', () => {
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

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('logManifestUsage', () => {
    it('persists manifest usage to vault', async () => {
      await initProactiveScheduler()
      logManifestUsage('test-manifest')
      const stored = vault.readCache('proactive', BEHAVIOR_KEY)
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored!)
      expect(parsed.length).toBeGreaterThanOrEqual(1)
      expect(parsed[parsed.length - 1].manifestId).toBe('test-manifest')
    })

    it('accumulates multiple usages', async () => {
      await initProactiveScheduler()
      logManifestUsage('manifest-a')
      logManifestUsage('manifest-b')
      logManifestUsage('manifest-c')
      const stored = JSON.parse(vault.readCache('proactive', BEHAVIOR_KEY) || '[]')
      expect(stored.length).toBeGreaterThanOrEqual(3)
    })

    it('truncates when exceeding 200 entries', async () => {
      await initProactiveScheduler()
      for (let i = 0; i < 205; i++) {
        logManifestUsage(`tool-${i}`)
      }
      const stored = JSON.parse(vault.readCache('proactive', BEHAVIOR_KEY) || '[]')
      expect(stored.length).toBeLessThanOrEqual(200)
    })
  })
})
