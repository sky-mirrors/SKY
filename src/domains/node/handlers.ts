import type { HoloEventBus } from '@/kernel/bus'
import { useNodeStore } from '@/stores/nodeStore'

// dialogStore 等经 emit() 发布 node:set-l1-status → 必须 on() 桥接（HMR 重挂载先释放旧订阅）
let _disposeL1Status: (() => void) | null = null

export function registerNodeHandlers(bus: HoloEventBus) {
  const setL1StatusHandler = (payload: { nodeId?: string; status?: 'idle' | 'working' | 'success' | 'error' | 'long_running' }) => {
    if (!payload?.nodeId || !payload.status) return
    const store = useNodeStore()
    store.setL1Status(payload.nodeId, payload.status)
  }
  bus.registerHandler('node:set-l1-status', setL1StatusHandler)
  _disposeL1Status?.()
  _disposeL1Status = bus.on('node:set-l1-status', setL1StatusHandler as (payload: unknown) => unknown)

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
