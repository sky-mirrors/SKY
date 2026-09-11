import type { HoloEventBus } from '@/kernel/bus'
import { useConfigStore } from '@/stores/configStore'
import { getAllTerms } from '@/services/terminologyMap'

export function registerConfigHandlers(bus: HoloEventBus) {
  bus.registerHandler('config:get', (payload) => {
    const store = useConfigStore()
    return store.config[payload.key as keyof typeof store.config]
  })

  bus.registerHandler('config:set', (payload) => {
    const store = useConfigStore()
    const setter = `set${payload.key[0].toUpperCase()}${payload.key.slice(1)}` as keyof typeof store
    const fn = store[setter]
    if (typeof fn === 'function') {
      (fn as (v: unknown) => void)(payload.value)
    }
  })

  bus.registerHandler('config:get-terminology', () => {
    return getAllTerms()
  })
}
