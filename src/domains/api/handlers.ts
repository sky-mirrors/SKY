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
    // A5-11：返回深副本，避免跨模块拿到 store 活引用逃逸篡改配置
    return JSON.parse(JSON.stringify(store.config))
  })

  bus.registerHandler('api:check-connection', async () => {
    const store = useApiStore()
    return store.checkConnection()
  })

  bus.registerHandler('api:list-models', () => {
    const store = useApiStore()
    // A5-11：返回副本而非 config.models 活数组
    return [...store.config.models]
  })

  // P0-10：补齐死频道——executePipeline 入口的同步 request 原在此处必抛（无 handler 即 throw），
  // 整条 L1 流水线 100% 崩溃。返回 apiStore 既有的 gatewayAdapter。
  bus.registerHandler('llm:get-gateway', () => {
    const store = useApiStore()
    return store.gatewayAdapter
  })
}
