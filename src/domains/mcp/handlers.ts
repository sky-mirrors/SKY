import type { HoloEventBus } from '@/kernel/bus'
import { useMcpStore } from '@/stores/mcpStore'

export function registerMcpHandlers(bus: HoloEventBus) {
  bus.registerHandler('mcp:list-tools', (payload) => {
    const store = useMcpStore()
    const conn = store.connections.find(c => c.id === payload?.mcpId)
    return conn?.tools ?? store.mcpToolsAsNodes
  })

  bus.registerHandler('mcp:call-tool', async (payload) => {
    // P1-11：发送方契约不一致 —— macroExecutor 发 {mcpId}、dialogStore 发 {connectionId}，
    // 此前只读 mcpId 导致后者恒走 undefined 抛 "MCP not connected"。统一兼容两种字段。
    const store = useMcpStore()
    const mcpId = payload?.mcpId || payload?.connectionId
    return store.callTool(mcpId, payload.toolName, payload.args)
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
