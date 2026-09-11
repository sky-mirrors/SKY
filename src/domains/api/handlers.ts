import type { HoloEventBus } from '@/kernel/bus'
import { useApiStore } from '@/stores/apiStore'

export function registerApiHandlers(bus: HoloEventBus) {
  bus.registerHandler('api:chat-completion', async (payload) => {
    const store = useApiStore()
    return store.chatCompletion(
      payload.messages,
      payload.retryOnFailure,
      payload.tools,
      payload.maxTokens,
      payload.signal,
      payload.routingOptions
    )
  })

  bus.registerHandler('api:chat-completion-stream', async (payload) => {
    const store = useApiStore()
    return store.chatCompletionStream(
      payload.messages,
      payload.callbacks,
      payload.tools,
      payload.maxTokens,
      payload.signal,
      payload.routingOptions
    )
  })

  bus.registerHandler('api:detect-domain', (payload) => {
    const store = useApiStore()
    return store.detectDomain(payload.messages)
  })

  bus.registerHandler('api:is-ready', () => {
    const store = useApiStore()
    return store.isReady
  })

  bus.registerHandler('api:get-config', () => {
    const store = useApiStore()
    return store.config
  })

  bus.registerHandler('api:check-connection', async () => {
    const store = useApiStore()
    return store.checkConnection()
  })

  bus.registerHandler('api:list-models', () => {
    const store = useApiStore()
    return store.config.models
  })
}
