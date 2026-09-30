import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * RaaP 分数池持久化（2026-09-30）
 *
 * 背景：`computeDynamicThreshold` 用历史分数池算自适应阈值，但池原是**纯内存** ⇒ 每次重启
 * 清零、`pool.length < 10` 一律回落 fallback，动态阈值在冷启动期从不生效（与 G-13 同型）。
 * 本文件钉住：① 记录累计到 10 次才落一次盘（节流）；② 落盘用的 key/域固定。
 *
 * 独立成文件是因为要 mock `@/vault`——放在 toolRetrieval.spec 里会波及该文件的其他用例。
 */
const writeThrough = vi.fn()
const readCache = vi.fn().mockReturnValue(null)

vi.mock('@/vault', () => ({
  vault: {
    writeThrough: (...args: unknown[]) => writeThrough(...args),
    readCache: (...args: unknown[]) => readCache(...args),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    clearCache: vi.fn()
  }
}))

import { recordScore, __resetScoreHistoryForTest } from '@/services/toolRetrieval'

describe('RaaP 分数池持久化', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetScoreHistoryForTest()
  })

  it('节流：累计 10 次记录才落一次盘（前 9 次不写）', () => {
    for (let i = 0; i < 9; i++) recordScore(0.5, 'keyword')
    expect(writeThrough).not.toHaveBeenCalled()

    recordScore(0.5, 'keyword') // 第 10 次
    expect(writeThrough).toHaveBeenCalledTimes(1)
  })

  it('落盘使用固定 key raap-score-history，且同时存 keyword 与 vector 两池', () => {
    for (let i = 0; i < 10; i++) recordScore(0.4 + i / 100, 'keyword')
    expect(writeThrough).toHaveBeenCalledTimes(1)
    const [domain, key, payload] = writeThrough.mock.calls[0]
    expect(domain).toBe('tool')
    expect(key).toBe('raap-score-history')
    const parsed = JSON.parse(String(payload)) as { keyword: number[]; vector: number[] }
    expect(parsed.keyword).toHaveLength(10)
    expect(parsed.vector).toEqual([])
  })

  it('恢复：模块加载时从 vault 载入池 ⇒ 重启后动态阈值不再回落 fallback', async () => {
    vi.resetModules()
    // 有分散度的历史分数（p95-p5 ≥ 0.1，否则函数自身会回落 fallback）
    readCache.mockReturnValue(JSON.stringify({
      keyword: Array.from({ length: 12 }, (_, i) => 0.30 + i * 0.05),
      vector: []
    }))
    const mod = await import('@/services/toolRetrieval')
    const dyn = mod.computeDynamicThreshold(0.6, 0.6, 'keyword')
    // 若未恢复池（池为空）会等于 fallback 0.6；恢复后应由分布算出别的值
    expect(dyn).not.toBe(0.6)
  })
})
