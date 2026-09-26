import type { HoloEventBus } from '@/kernel/bus'
import { useNodeStore, type DagStep, type DagStepStatus } from '@/stores/nodeStore'

// dialogStore 等经 emit() 发布 node:set-l1-status → 必须 on() 桥接（HMR 重挂载先释放旧订阅）
let _disposeL1Status: (() => void) | null = null

// DAG 执行链 6 条（同 L1 口径：dialogStore 经 emit() 发，而 emit 只达 on() 监听器——
// registerHandler 只服务 request/requestAsync，挂错路即生产失联）。HMR 重挂载先释放旧订阅。
let _disposeDagChannels: Array<() => void> = []

export function registerNodeHandlers(bus: HoloEventBus) {
  const setL1StatusHandler = (payload: { nodeId?: string; status?: 'idle' | 'working' | 'success' | 'error' | 'long_running' }) => {
    if (!payload?.nodeId || !payload.status) return
    const store = useNodeStore()
    store.setL1Status(payload.nodeId, payload.status)
  }
  bus.registerHandler('node:set-l1-status', setL1StatusHandler)
  _disposeL1Status?.()
  _disposeL1Status = bus.on('node:set-l1-status', setL1StatusHandler as (payload: unknown) => unknown)

  // DAG 执行链桥接（★ docs\ARCHITECTURE.md §8.6 断裂①修复）：驱动 nodeStore.dagChainState，
  // 供工作台 RuntimePanel（执行链卡片）/StatusBar（执行中计数）与 DialogPanel P1-24 暂停入口消费。
  _disposeDagChannels.forEach(d => d())
  _disposeDagChannels = [
    bus.on('node:set-dag-chain', (payload) => {
      const p = payload as { steps?: DagStep[]; dependsOnMap?: Record<number, number[]> }
      if (!Array.isArray(p?.steps)) return
      useNodeStore().setDAGChain(p.steps, p.dependsOnMap)
    }),
    bus.on('node:update-dag-step', (payload) => {
      const p = payload as { stepNum?: number; status?: DagStepStatus }
      if (p?.stepNum == null || !p.status) return
      useNodeStore().updateDAGStep(p.stepNum, p.status)
    }),
    bus.on('node:dag-chain-push-step', (payload) => {
      const p = payload as { step?: DagStep }
      if (!p?.step) return
      useNodeStore().pushDAGStep(p.step)
    }),
    bus.on('node:dag-chain-set-deps', (payload) => {
      const p = payload as { stepNum?: number; dependsOn?: number[] }
      if (p?.stepNum == null || !Array.isArray(p.dependsOn)) return
      useNodeStore().setDAGDeps(p.stepNum, p.dependsOn)
    }),
    bus.on('node:mark-task-chain-complete', () => {
      useNodeStore().markDAGChainComplete()
    }),
    bus.on('node:clear-dag-chain', () => {
      useNodeStore().clearDAGChain()
    })
  ]

  bus.registerHandler('node:get-nodes', () => {
    const store = useNodeStore()
    return store.nodes
  })

  bus.registerHandler('node:select-node', (payload) => {
    const store = useNodeStore()
    store.interaction.selectedNodeId = payload.nodeId
  })

  bus.registerHandler('node:get-context', (payload) => {
    const store = useNodeStore()
    const node = store.nodes.find(n => n.id === payload.nodeId)
    return node?.contextCache ?? null
  })

  bus.registerHandler('node:get-roles', () => {
    const store = useNodeStore()
    return store.interaction.selectedRole
  })

  bus.registerHandler('node:get-selected-node', () => {
    const store = useNodeStore()
    return store.selectedNode
  })

  bus.registerHandler('node:get-selected-role', () => {
    const store = useNodeStore()
    return store.interaction.selectedRole
  })

  bus.registerHandler('node:get-l2-manifest', (payload) => {
    const store = useNodeStore()
    return store.getL2Manifest(payload.id)
  })

  bus.registerHandler('node:get-all-l2-manifests', () => {
    const store = useNodeStore()
    return store.getAllL2Manifests()
  })

  bus.registerHandler('node:get-visible-l2-ids', () => {
    const store = useNodeStore()
    return store.getVisibleL2Ids()
  })
}
