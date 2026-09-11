import type { HoloEventBus } from '@/kernel/bus'
import { useNodeStore } from '@/stores/nodeStore'

export function registerNodeHandlers(bus: HoloEventBus) {
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
