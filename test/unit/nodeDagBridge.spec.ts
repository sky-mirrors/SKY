import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { HoloEventBus } from '@/kernel/bus'
import { registerNodeHandlers } from '@/domains/node/handlers'
import { useNodeStore } from '@/stores/nodeStore'

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

vi.mock('@/data/topology', () => ({
  generateAllNodes: () => [
    { id: 'l1-gateway', level: 'L1', name: 'Gateway', position: { x: 100, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: ['developer'], description: 'Gateway' },
    { id: 'l1-memory', level: 'L1', name: 'Memory', position: { x: 200, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: [], description: 'Memory' }
  ],
  getJobRoleTemplates: () => []
}))

/**
 * DAG 执行链总线桥接（★ 修复原 ARCHITECTURE §8.6「执行可视化链路三重断裂」（见 docs/10-架构与分层.md））。
 *
 * 断裂①：dialogStore 用 `emit` 发这 6 条频道，而全仓库无 `bus.on` 订阅——事件发进虚空。
 * 本 spec 走**真实注册路径**（`registerNodeHandlers`），不在此手搓 `bus.on`——否则测试
 * 自证：生产里漏接也能恒绿。断言到 `nodeStore.dagChainState`，即工作台 RuntimePanel/
 * StatusBar 与 DialogPanel P1-24 暂停入口所读的同一状态。
 */
describe('DAG 执行链总线桥接（工作台卡片/状态栏/P1-24 暂停入口的数据源）', () => {
  let store: ReturnType<typeof useNodeStore>
  let bus: HoloEventBus

  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
    store = useNodeStore()
    bus = new HoloEventBus()
    registerNodeHandlers(bus)
  })

  const steps = () => [
    { nodeId: 'l1-gateway', stepNum: 1, status: 'pending' as const },
    { nodeId: 'l1-memory', stepNum: 2, status: 'pending' as const }
  ]

  it('node:set-dag-chain → active=true 且步骤/依赖入状态', () => {
    expect(store.dagChainState.active).toBe(false)
    bus.emit('node:set-dag-chain', { steps: steps(), dependsOnMap: { 2: [1] } })
    expect(store.dagChainState.active).toBe(true)
    expect(store.dagChainState.steps.map(s => s.stepNum)).toEqual([1, 2])
    expect(store.dagChainState.dependsOnMap).toEqual({ 2: [1] })
  })

  it('node:update-dag-step → 对应步骤状态推进（P1-24 暂停入口依赖 pending 步骤可见）', () => {
    bus.emit('node:set-dag-chain', { steps: steps() })
    expect(store.dagChainState.steps.find(s => s.status === 'pending')?.stepNum).toBe(1)
    bus.emit('node:update-dag-step', { stepNum: 1, status: 'done' })
    expect(store.dagChainState.steps.find(s => s.stepNum === 1)?.status).toBe('done')
    // 下一个待执行步骤随之前移——正是 P1-24 `nextDagPauseStepNum` 的取值口径
    expect(store.dagChainState.steps.find(s => s.status === 'pending')?.stepNum).toBe(2)
  })

  it('node:dag-chain-push-step → 追加重规划步骤', () => {
    bus.emit('node:set-dag-chain', { steps: steps() })
    bus.emit('node:dag-chain-push-step', { step: { nodeId: 'l1-memory', stepNum: 3, status: 'replanned' } })
    expect(store.dagChainState.steps.map(s => s.stepNum)).toEqual([1, 2, 3])
    expect(store.dagChainState.steps[2].status).toBe('replanned')
  })

  it('node:dag-chain-set-deps → 更新依赖映射', () => {
    bus.emit('node:set-dag-chain', { steps: steps() })
    bus.emit('node:dag-chain-set-deps', { stepNum: 3, dependsOn: [1, 2] })
    expect(store.dagChainState.dependsOnMap[3]).toEqual([1, 2])
  })

  it('node:mark-task-chain-complete → pending 收尾为 done；failed 不被掩盖', () => {
    bus.emit('node:set-dag-chain', { steps: [
      { nodeId: 'l1-gateway', stepNum: 1, status: 'done' },
      { nodeId: 'l1-memory', stepNum: 2, status: 'failed' },
      { nodeId: 'l1-memory', stepNum: 3, status: 'pending' }
    ] })
    bus.emit('node:mark-task-chain-complete', {})
    const byNum = new Map(store.dagChainState.steps.map(s => [s.stepNum, s.status]))
    expect(byNum.get(3)).toBe('done')
    expect(byNum.get(2)).toBe('failed')
    expect(store.dagChainState.active).toBe(true)
  })

  it('node:clear-dag-chain → 清空并置 active=false', () => {
    bus.emit('node:set-dag-chain', { steps: steps() })
    bus.emit('node:clear-dag-chain', {})
    expect(store.dagChainState.active).toBe(false)
    expect(store.dagChainState.steps).toEqual([])
  })

  it('畸形载荷不抛错也不污染状态（防御总线上的空/坏事件）', () => {
    bus.emit('node:update-dag-step', { stepNum: 99, status: 'done' }) // 无该步骤
    bus.emit('node:dag-chain-push-step', {}) // 缺 step
    bus.emit('node:dag-chain-set-deps', { stepNum: 1 }) // 缺 dependsOn
    bus.emit('node:set-dag-chain', {}) // 缺 steps
    expect(store.dagChainState.active).toBe(false)
    expect(store.dagChainState.steps).toEqual([])
  })
})
