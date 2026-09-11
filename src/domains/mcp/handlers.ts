import type { HoloEventBus } from '@/kernel/bus'
import { useMcpStore } from '@/stores/mcpStore'

export function registerMcpHandlers(bus: HoloEventBus) {
  bus.registerHandler('mcp:list-tools', (payload) => {
    const store = useMcpStore()
    const conn = store.connections.find(c => c.id === payload?.mcpId)
    return conn?.tools ?? store.mcpToolsAsNodes
  })

  bus.registerHandler('mcp:call-tool', async (payload) => {
    const store = useMcpStore()
    return store.callTool(payload.mcpId, payload.toolName, payload.args)
  })

  bus.registerHandler('mcp:get-connections', () => {
    const store = useMcpStore()
    return store.connections
  })

  bus.registerHandler('mcp:get-tools-as-nodes', () => {
    const store = useMcpStore()
    return store.mcpToolsAsNodes
  })
}
