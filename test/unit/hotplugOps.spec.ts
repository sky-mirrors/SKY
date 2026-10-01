import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 2026-10-01（用户裁定：热插拔要「能替换」）：
 * 此前全仓对内核/领域包只有只读展示、零操作入口。本组测试锁定新加的操作层——
 * ① kernelRegistry.listKernelIds 报告池中可激活内核；② hotplugStore 的四个操作
 * 确实委托给运行时单例并刷新镜像状态（挂载/卸载/重载/激活）。
 */
const mountPack = vi.fn(async () => ({ ok: true, packId: 'finance', constraints: { total: 1, disabled: 0 }, warnings: [] }))
const unmountPack = vi.fn(async () => ({ ok: true, removedConstraints: 1, removedKnowledge: 2, warnings: [] }))
const reloadPack = vi.fn(async () => ({ ok: true, durationMs: 7, warnings: [] }))
const listPackIds = vi.fn(() => ['finance', 'hr', 'legal'])
let mountedIds: string[] = ['finance']

const activate = vi.fn(async () => ({ ok: true }))
const listKernelIds = vi.fn(() => ['kernel-default'])

vi.mock('@/host/packRuntime', () => ({
  packLoader: {
    listPackIds: () => listPackIds(),
    listMounted: () => mountedIds.map(id => ({ id })),
    mountPack: (id: string) => mountPack(id),
    unmountPack: (id: string) => unmountPack(id),
    reloadPack: (id: string) => reloadPack(id)
  }
}))

vi.mock('@/host/kernelRuntime', () => ({
  kernelRegistry: {
    getActiveId: () => 'kernel-default',
    getState: () => 'active',
    inFlightCount: () => 0,
    queueLength: () => 0,
    listKernelIds: () => listKernelIds(),
    activate: (id: string) => activate(id)
  }
}))

import { useHotplugStore } from '@/stores/hotplugStore'
import { KernelRegistry } from '@/host/kernelRegistry'

const originalWindow = globalThis.window

beforeEach(() => {
  vi.clearAllMocks()
  mountedIds = ['finance']
  ;(globalThis as any).window = {
    electronAPI: {
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([])
    }
  }
  setActivePinia(createPinia())
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('KernelRegistry.listKernelIds', () => {
  it('报告池中已注册的内核 id', () => {
    const reg = new KernelRegistry()
    expect(reg.listKernelIds()).toEqual([])
    reg.register({ id: 'kernel-a' } as never)
    reg.register({ id: 'kernel-b' } as never)
    expect(reg.listKernelIds().sort()).toEqual(['kernel-a', 'kernel-b'])
  })

  it('拒绝非法 id 的注册（不入池，故不出现在列表）', () => {
    const reg = new KernelRegistry()
    reg.register({ id: 'BAD ID!' } as never)
    expect(reg.listKernelIds()).toEqual([])
  })
})

describe('hotplugStore 操作入口（此前为零）', () => {
  it('refresh（经 init）填充 kernelIds / allPackIds / mountedPackIds', () => {
    const s = useHotplugStore()
    s.init()
    expect(s.allPackIds).toEqual(['finance', 'hr', 'legal'])
    expect(s.mountedPackIds).toEqual(['finance'])
    expect(s.kernelIds).toEqual(['kernel-default'])
  })

  it('mountPack 委托 loader 并刷新镜像', async () => {
    const s = useHotplugStore()
    s.init()
    mountedIds = ['finance', 'hr']
    const r = await s.mountPack('hr')
    expect(mountPack).toHaveBeenCalledWith('hr')
    expect(r.ok).toBe(true)
    expect(s.mountedPackIds).toEqual(['finance', 'hr'])
    expect(s.operating).toBe(false)
  })

  it('unmountPack 委托 loader 并刷新镜像', async () => {
    const s = useHotplugStore()
    s.init()
    mountedIds = []
    const r = await s.unmountPack('finance')
    expect(unmountPack).toHaveBeenCalledWith('finance')
    expect(r.ok).toBe(true)
    expect(s.mountedPackIds).toEqual([])
  })

  it('reloadPack 委托 loader', async () => {
    const s = useHotplugStore()
    s.init()
    await s.reloadPack('finance')
    expect(reloadPack).toHaveBeenCalledWith('finance')
  })

  it('activateKernel 委托 registry 并刷新', async () => {
    const s = useHotplugStore()
    s.init()
    await s.activateKernel('kernel-default')
    expect(activate).toHaveBeenCalledWith('kernel-default')
    expect(s.activeKernelId).toBe('kernel-default')
  })

  it('挂载失败时写入 error 级事件日志', async () => {
    const s = useHotplugStore()
    s.init()
    mountPack.mockResolvedValueOnce({ ok: false, error: { phase: 'manifest', reason: 'json-parse', detail: 'x', packId: 'hr' }, warnings: [] } as never)
    await s.mountPack('hr')
    expect(s.eventLog[0].level).toBe('error')
    expect(s.eventLog[0].text).toContain('挂载失败')
  })
})
