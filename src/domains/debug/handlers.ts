import type { HoloEventBus } from '@/kernel/bus'
import { useDebugStore } from '@/stores/debugStore'

export function registerDebugHandlers(bus: HoloEventBus) {
  bus.registerHandler('debug:log-probe', (payload) => {
    const store = useDebugStore()
    if (payload?.snapshot) {
      store.recordProbe(payload.snapshot)
    } else if (payload?.message) {
      store.emitEvent(payload.level ?? 'info', payload.domain ?? 'dialog', payload.message, payload.detail)
    }
  })

  bus.registerHandler('debug:is-enabled', () => {
    const store = useDebugStore()
    return store.enabled
  })

  bus.registerHandler('debug:record-cost', (payload) => {
    const store = useDebugStore()
    store.recordTokenUsage(
      payload.promptTokens,
      payload.completionTokens,
      payload.totalTokens,
      payload.category
    )
  })
}
