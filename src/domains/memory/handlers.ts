import type { HoloEventBus } from '@/kernel/bus'
import { useMemoryStore } from '@/stores/memoryStore'

export function registerMemoryHandlers(bus: HoloEventBus) {
  bus.registerHandler('memory:get-recent', (payload) => {
    const store = useMemoryStore()
    return store.getRecentMessages(payload.projectId, payload.limit)
  })

  bus.registerHandler('memory:add-mcp-log', (payload) => {
    const store = useMemoryStore()
    store.addMcpRequestLog(payload.log)
  })
}
