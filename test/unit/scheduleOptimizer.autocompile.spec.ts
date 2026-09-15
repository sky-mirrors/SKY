import { describe, it, expect, beforeEach, vi } from 'vitest'

function mockElectronApi() {
  const api = {
    storeRead: vi.fn().mockResolvedValue(null),
    storeWrite: vi.fn().mockResolvedValue(undefined)
  }
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

describe('#3 autoCompile 晋级门槛（真实执行占比）', () => {
  beforeEach(() => {
    mockElectronApi()
  })

  it('10 次真实执行（零缓存命中）晋级 autoCompiled', async () => {
    const { saveExecutionFingerprint, isManifestAutoCompiled } = await import('@/services/scheduleOptimizer')
    const id = `ac-real-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    for (let i = 0; i < 10; i++) {
      saveExecutionFingerprint(id, `fp-${i}`, { 1: 'h1' }, { 1: 'r1' }, false)
    }
    expect(isManifestAutoCompiled(id)).toBe(true)
  })

  it('10 次纯缓存命中不晋级（原写反门槛下的最短路径）', async () => {
    const { saveExecutionFingerprint, isManifestAutoCompiled } = await import('@/services/scheduleOptimizer')
    const id = `ac-cache-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    for (let i = 0; i < 10; i++) {
      saveExecutionFingerprint(id, `fp-${i}`, { 1: 'h1' }, { 1: 'r1' }, true)
    }
    expect(isManifestAutoCompiled(id)).toBe(false)
  })

  it('缓存命中过半（真实执行占比 0.2）不晋级', async () => {
    const { saveExecutionFingerprint, isManifestAutoCompiled } = await import('@/services/scheduleOptimizer')
    const id = `ac-mixed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    for (let i = 0; i < 10; i++) {
      saveExecutionFingerprint(id, `fp-${i}`, { 1: 'h1' }, { 1: 'r1' }, i < 8)
    }
    expect(isManifestAutoCompiled(id)).toBe(false)
  })
})
