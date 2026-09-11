import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { calculateUsage, getTotalUsedMB, shouldAlert, getUsageLevel, cleanExpiredCache } from '@/services/storageMonitor'
import { vault } from '@/vault'

function mockElectronAPI() {
  vi.stubGlobal('window', {
    electronAPI: {
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([]),
    }
  })
}

describe('storageMonitor', () => {
  beforeEach(() => {
    vault.clearCache()
    mockElectronAPI()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calculateUsage returns empty when vault is empty', async () => {
    const usage = await calculateUsage()
    expect(usage).toEqual([])
  })

  it('calculateUsage returns entries for populated keys', async () => {
    const bigData = 'x'.repeat(1024 * 100)
    vault.writeCache('config', 'holo-api-config', JSON.stringify({ baseUrl: 'http://test.com' }))
    vault.writeCache('conv', 'holo-conv-chunks', bigData)
    const usage = await calculateUsage()
    expect(usage.length).toBeGreaterThan(0)
  })

  it('getTotalUsedMB returns 0 for empty vault', async () => {
    expect(await getTotalUsedMB()).toBe(0)
  })

  it('shouldAlert returns false below 4MB', async () => {
    expect(await shouldAlert()).toBe(false)
  })

  it('shouldAlert returns true at or above 4MB', async () => {
    const bigData = 'x'.repeat(2 * 1024 * 1024 + 1)
    vault.writeCache('conv', 'holo-conv-chunks', bigData)
    vault.writeCache('conv', 'holo-conv-summaries', bigData)
    expect(await shouldAlert()).toBe(true)
  })

  it('getUsageLevel returns green when under 3MB', async () => {
    expect(await getUsageLevel()).toBe('green')
  })

  it('cleanExpiredCache removes old routing history entries', async () => {
    const sevenDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    const recent = Date.now()
    vault.writeCache('routing', 'holo-routing-history', JSON.stringify([
      { timestamp: sevenDaysAgo, result: 'old' },
      { timestamp: recent, result: 'new' }
    ]))
    const cleaned = await cleanExpiredCache()
    expect(cleaned).toBe(1)
  })

  it('cleanExpiredCache removes old pipeline checkpoints', async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    vault.writeCache('pipeline', 'holo-pipeline-check-1', JSON.stringify({ updatedAt: twoDaysAgo }))
    vault.writeCache('pipeline', 'holo-pipeline-check-2', JSON.stringify({ updatedAt: oneHourAgo }))
    ;(window as any).electronAPI.vaultList = vi.fn().mockResolvedValue(['holo-pipeline-check-1', 'holo-pipeline-check-2'])
    const cleaned = await cleanExpiredCache()
    expect(cleaned).toBe(1)
  })
})
