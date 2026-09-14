import type { HoloEventBus } from '@/kernel/bus'
import { useDebugStore } from '@/stores/debugStore'
import type { ConsoleCategory, ProbeSnapshot } from '@/models'

// HoloEventBus.emit() 只达 bus.on() 监听器、registerHandler() 仅 request() 可达；
// debug:log-probe 全部走 emit() 发布，故除 registerHandler 外必须桥接 on()（HMR 重挂载先释放旧订阅）
let _disposeProbe: (() => void) | null = null

export function registerDebugHandlers(bus: HoloEventBus) {
  const probeHandler = (payload: { snapshot?: ProbeSnapshot; message?: string; level?: 'log' | 'warn' | 'error' | 'info'; domain?: ConsoleCategory; detail?: string }) => {
    const store = useDebugStore()
    if (payload?.snapshot) {
      store.recordProbe(payload.snapshot)
    } else if (payload?.message) {
      store.emitEvent(payload.level ?? 'info', payload.domain ?? 'dialog', payload.message, payload.detail)
    }
  }
  bus.registerHandler('debug:log-probe', probeHandler)
  _disposeProbe?.()
  _disposeProbe = bus.on('debug:log-probe', probeHandler as (payload: unknown) => unknown)

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
