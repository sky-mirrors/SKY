import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

// ===== 可控 mock：kernelRegistry / packLoader 单例 + dialogStore.refreshFunnelMainFlag =====
const { registryMock, loaderMock, refreshFlagMock } = vi.hoisted(() => ({
  registryMock: {
    getActiveId: vi.fn(),
    getState: vi.fn(),
    inFlightCount: vi.fn(),
    queueLength: vi.fn()
  },
  loaderMock: {
    listPackIds: vi.fn(),
    listMounted: vi.fn()
  },
  refreshFlagMock: vi.fn()
}))

vi.mock('@/host/kernelRuntime', () => ({ kernelRegistry: registryMock }))
vi.mock('@/host/packRuntime', () => ({ packLoader: loaderMock }))
vi.mock('@/stores/dialogStore', () => ({
  useDialogStore: () => ({ refreshFunnelMainFlag: refreshFlagMock })
}))

let vaultFlag: string | null = null

vi.stubGlobal('window', {
  electronAPI: {
    vaultRead: vi.fn().mockImplementation((ns: string, key: string) =>
      Promise.resolve(ns === 'config' && key === 'holo-funnel-main' ? vaultFlag : null)),
    vaultWrite: vi.fn().mockResolvedValue(undefined)
  }
})

import { useHotplugStore } from '@/stores/hotplugStore'

describe('hotplugStore（工作台右栏数据源，R16）', () => {
  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    vaultFlag = null
    registryMock.getActiveId.mockReturnValue('kernel-default')
    registryMock.getState.mockReturnValue('active')
    registryMock.inFlightCount.mockReturnValue(2)
    registryMock.queueLength.mockReturnValue(1)
    loaderMock.listPackIds.mockReturnValue(['legal', 'finance'])
    loaderMock.listMounted.mockReturnValue([{ id: 'legal', name: '法务', version: '1.0.0', domain: 'legal' }])
    refreshFlagMock.mockReset()
    const pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    useHotplugStore().dispose()
    globalBus.clear()
  })

  it('init → 单例快照 + funnel flag 默认开启', () => {
    const store = useHotplugStore()
    store.init()

    expect(store.activeKernelId).toBe('kernel-default')
    expect(store.kernelState).toBe('active')
    expect(store.kernelInFlight).toBe(2)
    expect(store.kernelQueueLen).toBe(1)
    expect(store.allPackIds).toEqual(['legal', 'finance'])
    expect(store.mountedPackIds).toEqual(['legal'])
    expect(store.funnelMainEnabled).toBe(true)
    expect(store.eventLog).toHaveLength(0)
  })

  it("flag='0' → funnelMainEnabled=false", async () => {
    vaultFlag = '0'
    const store = useHotplugStore()
    store.init()
    await store.refreshFunnelFlag()

    expect(store.funnelMainEnabled).toBe(false)
  })

  it('init 幂等（重复调用不重复订阅）', () => {
    const store = useHotplugStore()
    store.init()
    store.init()
    globalBus.emit('kernel:switched', { from: 'a', to: 'b' })

    expect(store.eventLog).toHaveLength(1)
  })

  it('kernel:switched → 快照刷新 + 事件记录', () => {
    const store = useHotplugStore()
    store.init()
    registryMock.getActiveId.mockReturnValue('kernel-b')
    registryMock.getState.mockReturnValue('switching')

    globalBus.emit('kernel:switched', { from: 'kernel-default', to: 'kernel-b' })

    expect(store.activeKernelId).toBe('kernel-b')
    expect(store.kernelState).toBe('switching')
    expect(store.eventLog[0]).toMatchObject({ kind: 'kernel', level: 'info' })
    expect(store.eventLog[0].text).toContain('kernel-default → kernel-b')
  })

  it('kernel:fatal / kernel:zombie / kernel:mount-failed → 分级事件', () => {
    const store = useHotplugStore()
    store.init()

    globalBus.emit('kernel:mount-failed', { id: 'k-bad', error: 'boom' })
    globalBus.emit('kernel:zombie', { id: 'k-slow', error: 'mount-timeout: k-slow' })
    globalBus.emit('kernel:fatal', { failedId: 'k-bad' })

    expect(store.eventLog[0]).toMatchObject({ kind: 'kernel', level: 'error' })
    expect(store.eventLog[0].text).toContain('内核空缺')
    expect(store.eventLog[1]).toMatchObject({ level: 'error' })
    expect(store.eventLog[1].text).toContain('k-slow')
    expect(store.eventLog[2]).toMatchObject({ level: 'warn' })
    expect(store.eventLog[2].text).toContain('k-bad')
  })

  it('pack:mounted / pack:unmounted / pack:reloaded / pack:mount-failed → 快照 + 事件', () => {
    const store = useHotplugStore()
    store.init()

    loaderMock.listMounted.mockReturnValue([{ id: 'legal', name: '法务', version: '1.0.0', domain: 'legal' }])
    globalBus.emit('pack:mounted', { packId: 'finance' })
    globalBus.emit('pack:unmounted', { packId: 'finance' })
    globalBus.emit('pack:reloaded', { packId: 'legal', durationMs: 42 })
    globalBus.emit('pack:mount-failed', { packId: 'bad', phase: 'knowledge', reason: 'internal' })

    expect(store.eventLog[0]).toMatchObject({ kind: 'pack', level: 'error' })
    expect(store.eventLog[0].text).toContain('bad')
    expect(store.eventLog[1].text).toContain('热重载：legal（42ms）')
    expect(store.eventLog[2].text).toContain('pack 卸载：finance')
    expect(store.eventLog[3].text).toContain('pack 挂载：finance')
  })

  it('funnel:routed → lastRouted 镜像 + 事件（接管/回退两级）', () => {
    const store = useHotplugStore()
    store.init()

    globalBus.emit('funnel:routed', { handled: true, kind: 'plan', source: 'L0', intent: '测试意图', autoExecutable: false, ts: 1 })
    globalBus.emit('funnel:routed', { handled: false, kind: 'error', ts: 2 })

    expect(store.lastRouted).toMatchObject({ handled: false, kind: 'error', ts: 2 })
    expect(store.eventLog[0]).toMatchObject({ kind: 'funnel', level: 'warn' })
    expect(store.eventLog[0].text).toContain('回退旧路径')
    expect(store.eventLog[1]).toMatchObject({ level: 'info' })
    expect(store.eventLog[1].text).toContain('funnel(L0) → plan')
  })

  it('funnel:shadow-diff → 影子对照事件（一致/不一致/待人工核对分级）', () => {
    const store = useHotplugStore()
    store.init()

    globalBus.emit('funnel:shadow-diff', { funnelEndpoint: 'macro', legacyEndpoint: 'macro', match: true, durationMs: 5 })
    globalBus.emit('funnel:shadow-diff', { funnelEndpoint: 'chat', legacyEndpoint: 'macro', match: false, durationMs: 5 })
    globalBus.emit('funnel:shadow-diff', { funnelEndpoint: 'intent-confirm', legacyEndpoint: 'unknown', match: null })

    expect(store.eventLog[0]).toMatchObject({ kind: 'funnel', level: 'warn' })
    expect(store.eventLog[0].text).toContain('待人工核对')
    expect(store.eventLog[1]).toMatchObject({ level: 'warn' })
    expect(store.eventLog[1].text).toContain('不一致')
    expect(store.eventLog[2]).toMatchObject({ level: 'info' })
    expect(store.eventLog[2].text).toBe('影子对照：funnel(macro) vs 旧路径(macro) 一致')
  })

  it('toggleFunnelMain → vault 写入 + dialogStore 缓存清除 + 事件', () => {
    const store = useHotplugStore()
    store.init()

    store.toggleFunnelMain()

    expect(vault.readCache('config', 'holo-funnel-main')).toBe('0')
    expect(store.funnelMainEnabled).toBe(false)
    expect(refreshFlagMock).toHaveBeenCalledTimes(1)
    expect(store.eventLog[0]).toMatchObject({ kind: 'funnel', level: 'warn' })
    expect(store.eventLog[0].text).toContain('已关闭')

    store.toggleFunnelMain()

    expect(vault.readCache('config', 'holo-funnel-main')).toBe('1')
    expect(store.funnelMainEnabled).toBe(true)
    expect(refreshFlagMock).toHaveBeenCalledTimes(2)
  })

  it('eventLog 上限 50 条（新事件在前）', () => {
    const store = useHotplugStore()
    store.init()

    for (let i = 0; i < 55; i++) {
      globalBus.emit('kernel:switched', { from: 'a', to: `k-${i}` })
    }

    expect(store.eventLog).toHaveLength(50)
    expect(store.eventLog[0].text).toContain('→ k-54')
    expect(store.eventLog[49].text).toContain('→ k-5')
  })

  it('dispose → 退订总线，事件不再镜像', () => {
    const store = useHotplugStore()
    store.init()
    store.dispose()

    globalBus.emit('kernel:switched', { from: 'a', to: 'b' })

    expect(store.eventLog).toHaveLength(0)
    expect(store.lastRouted).toBeNull()
  })
})
