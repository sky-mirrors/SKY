// G-13：执行指纹缓存的持久化只存了结构哈希，重载时 results 被清空
// ⇒ auto-compile 晋级（10 次 + 真实执行率 ≥0.8）攒下的复用资产一重启清零重攒，
// 晋级机制的收益大打折扣（LIFECYCLE-GAPS G-13）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  saveExecutionFingerprint,
  findCachedExecution,
  loadPersistedFingerprints
} from '@/services/scheduleOptimizer'

const originalWindow = globalThis.window
let storeWriteFn: ReturnType<typeof vi.fn>
let storeReadFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  storeWriteFn = vi.fn().mockResolvedValue(true)
  storeReadFn = vi.fn().mockResolvedValue(null)
  ;(globalThis as any).window = { electronAPI: { storeWrite: storeWriteFn, storeRead: storeReadFn } }
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as any).window = originalWindow
})

describe('G-13：指纹缓存重启不再失忆', () => {
  it('落盘 payload 携带 results 本身（不再只有 resultHashes）', async () => {
    saveExecutionFingerprint('m1', 'fp1', { 1: 'h1' }, { 1: '步骤一的真实结果' })
    // 落盘走 2s 延迟（scheduleOptimizer: setTimeout(persistToStore, 2000)）
    await vi.advanceTimersByTimeAsync(2100)

    const call = storeWriteFn.mock.calls.find(c => c[0] === 'execution-fingerprints')
    expect(call).toBeTruthy()
    const payload = call![1] as Array<Record<string, unknown>>
    // fingerprintStore 是模块级数组、跨用例累积 ⇒ 按 manifestId 定位自己这条
    const mine = payload.find(p => p.manifestId === 'm1')
    expect(mine).toBeTruthy()
    expect(mine!.results).toEqual({ 1: '步骤一的真实结果' })
    // 结构哈希仍保留（供 findDirtySteps 的脏步判定）
    expect(mine!.resultHashes).toBeTruthy()
  })

  it('重载后 results 可复用（不再被清空）', async () => {
    storeReadFn.mockImplementation((key: string) =>
      key === 'execution-fingerprints'
        ? Promise.resolve([{
            manifestId: 'm9', inputHash: 'fp9', stepHashes: { 1: 'h' },
            results: { 1: '持久化的结果' }, executedAt: 1
          }])
        : Promise.resolve(null)
    )

    await loadPersistedFingerprints()

    const found = findCachedExecution('m9', 'fp9')
    expect(found).toBeTruthy()
    expect(found!.results[1]).toBe('持久化的结果')
  })

  it('超长结果不落盘（宁可不复用，也不给残缺结果）', async () => {
    saveExecutionFingerprint('m2', 'fp2', { 1: 'h' }, { 1: 'x'.repeat(20000) })
    await vi.advanceTimersByTimeAsync(2100)

    const call = storeWriteFn.mock.calls.find(c => c[0] === 'execution-fingerprints')
    const payload = call![1] as Array<Record<string, unknown>>
    const mine = payload.find(p => p.manifestId === 'm2')
    expect(mine).toBeTruthy()
    expect(mine!.results).toBeUndefined()
  })

  it('旧格式数据（无 results 字段）仍能安全重载', async () => {
    storeReadFn.mockImplementation((key: string) =>
      key === 'execution-fingerprints'
        ? Promise.resolve([{ manifestId: 'legacy', inputHash: 'fpL', stepHashes: { 1: 'h' }, executedAt: 1 }])
        : Promise.resolve(null)
    )

    await loadPersistedFingerprints()

    const found = findCachedExecution('legacy', 'fpL')
    expect(found).toBeTruthy()
    expect(found!.results).toEqual({})
  })
})
