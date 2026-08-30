import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ApiConfig, ModelInfo, CircuitBreakerState, ProviderConfig, ModelGatewayAdapter } from '@/models'
import { storeGet, storeSet } from '@/services/secureStore'
import { debugLog } from '@/services/debugLog'

export const useApiStore = defineStore('api', () => {
  const config = ref<ApiConfig>({
    baseUrl: '',
    models: [],
    activeModel: '',
    isReachable: false,
    lastCheckedAt: 0,
    providers: [],
    activeProviderId: ''
  })

  const circuitBreaker = ref<CircuitBreakerState>({
    isOpen: false,
    failureCount: 0,
    lastFailureAt: 0,
    cooldownMs: 30000,
    retryCount: 0,
    maxRetries: 3
  })

  const isConfigured = computed(() => config.value.baseUrl.length > 0 || config.value.providers.length > 0)
  const hasActiveModel = computed(() => config.value.activeModel.length > 0)
  const isReady = computed(() => config.value.isReachable && config.value.activeModel.length > 0)

  const isCircuitOpen = computed(() => {
    if (!circuitBreaker.value.isOpen) return false
    const elapsed = Date.now() - circuitBreaker.value.lastFailureAt
    if (elapsed > circuitBreaker.value.cooldownMs) return false
    return true
  })

  function checkAndResetCircuitBreaker(): void {
    if (circuitBreaker.value.isOpen) {
      const elapsed = Date.now() - circuitBreaker.value.lastFailureAt
      if (elapsed > circuitBreaker.value.cooldownMs) {
        circuitBreaker.value.isOpen = false
        circuitBreaker.value.failureCount = 0
      }
    }
  }

  function canMakeRequest(isCacheEligible: boolean = false): boolean {
    if (isCacheEligible) return true
    return !isCircuitOpen.value
  }

  function maybeResetCircuitBreaker(): void {
    if (circuitBreaker.value.isOpen) {
      const elapsed = Date.now() - circuitBreaker.value.lastFailureAt
      if (elapsed > circuitBreaker.value.cooldownMs) {
        circuitBreaker.value.isOpen = false
        circuitBreaker.value.failureCount = 0
      }
    }
  }

  const activeProvider = computed(() => {
    return config.value.providers.find(p => p.id === config.value.activeProviderId) ?? null
  })

  function addProvider(provider: Omit<ProviderConfig, 'models' | 'isReachable' | 'lastCheckedAt'>): string {
    const id = provider.id || `provider-${Date.now()}`
    const full: ProviderConfig = {
      ...provider,
      id,
      models: [],
      isReachable: false,
      lastCheckedAt: 0
    }
    config.value.providers.push(full)
    if (!config.value.activeProviderId) {
      config.value.activeProviderId = id
      config.value.baseUrl = provider.baseUrl
    }
    saveToStorage()
    return id
  }

  function removeProvider(providerId: string) {
    config.value.providers = config.value.providers.filter(p => p.id !== providerId)
    if (config.value.activeProviderId === providerId) {
      const first = config.value.providers[0]
      if (first) {
        switchProvider(first.id)
      } else {
        config.value.activeProviderId = ''
        config.value.baseUrl = ''
      }
    }
    saveToStorage()
  }

  function switchProvider(providerId: string) {
    const provider = config.value.providers.find(p => p.id === providerId)
    if (!provider) return
    config.value.activeProviderId = providerId
    config.value.baseUrl = provider.baseUrl
    config.value.models = provider.models
    config.value.isReachable = provider.isReachable
    if (provider.models.length > 0 && !provider.models.find(m => m.id === config.value.activeModel)) {
      setActiveModel(provider.models[0].id)
    }
    saveToStorage()
  }

  async function pingProvider(provider: ProviderConfig): Promise<boolean> {
    if (window.electronAPI?.llmListModels) {
      try {
        const result = await window.electronAPI.llmListModels({ providerId: provider.id })
        if (result.success && result.models) {
          const models: ModelInfo[] = result.models.map(m => ({
            id: m.id,
            name: m.name || m.id,
            providerId: provider.id
          }))
          provider.models = models
          provider.isReachable = true
          provider.lastCheckedAt = Date.now()
          if (provider.id === config.value.activeProviderId) {
            config.value.models = models
            config.value.isReachable = true
            config.value.lastCheckedAt = Date.now()
            if (!config.value.activeModel && models.length > 0) {
              setActiveModel(models[0].id)
            }
          }
          recordSuccess()
          return true
        }
      } catch { /* fall through to direct fetch */ }
    }

    const baseUrl = provider.baseUrl.replace(/\/+$/, '')
    const endpoint = provider.modelsEndpoint || '/v1/models'
    const headers: Record<string, string> = {}
    if (provider.authType === 'bearer' && provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    } else if (provider.authType === 'api-key' && provider.apiKey) {
      headers['x-api-key'] = provider.apiKey
    }

    try {
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      })
      if (resp.ok) {
        const data = await resp.json()
        const models: ModelInfo[] = (data.data ?? []).map((m: Record<string, string>) => ({
          id: m.id,
          name: m.id,
          providerId: provider.id
        }))
        provider.models = models
        provider.isReachable = true
        provider.lastCheckedAt = Date.now()
        if (provider.id === config.value.activeProviderId) {
          config.value.models = models
          config.value.isReachable = true
          config.value.lastCheckedAt = Date.now()
          if (!config.value.activeModel && models.length > 0) {
            setActiveModel(models[0].id)
          }
        }
        recordSuccess()
        return true
      }
    } catch { /* ignore */ }
    provider.isReachable = false
    provider.lastCheckedAt = Date.now()
    if (provider.id === config.value.activeProviderId) {
      config.value.isReachable = false
      recordFailure()
    }
    return false
  }

  async function pingAllProviders(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    const promises = config.value.providers.map(async (provider) => {
      results[provider.id] = await pingProvider(provider)
    })
    await Promise.all(promises)
    saveToStorage()
    return results
  }

  function setBaseUrl(url: string) {
    config.value.baseUrl = url.replace(/\/+$/, '')
  }

  function setModels(models: ModelInfo[]) {
    config.value.models = models
  }

  function setActiveModel(modelId: string) {
    config.value.activeModel = modelId
    saveToStorage()
  }

  function setReachable(reachable: boolean) {
    config.value.isReachable = reachable
    config.value.lastCheckedAt = Date.now()
  }

  function recordFailure() {
    circuitBreaker.value.failureCount++
    circuitBreaker.value.lastFailureAt = Date.now()
    circuitBreaker.value.retryCount++
    if (circuitBreaker.value.failureCount >= 3) {
      circuitBreaker.value.isOpen = true
    }
  }

  function recordSuccess() {
    circuitBreaker.value.failureCount = 0
    circuitBreaker.value.isOpen = false
    circuitBreaker.value.retryCount = 0
  }

  function resetCircuitBreaker() {
    circuitBreaker.value.isOpen = false
    circuitBreaker.value.failureCount = 0
    circuitBreaker.value.retryCount = 0
  }

  async function checkConnection(): Promise<boolean> {
    if (config.value.activeProviderId) {
      const provider = config.value.providers.find(p => p.id === config.value.activeProviderId)
      if (provider) return pingProvider(provider)
    }
    if (!config.value.baseUrl) {
      setReachable(false)
      return false
    }
    try {
      const resp = await fetch(`${config.value.baseUrl}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      if (resp.ok) {
        const data = await resp.json()
        const models: ModelInfo[] = (data.data ?? []).map((m: Record<string, string>) => ({
          id: m.id,
          name: m.id
        }))
        setModels(models)
        if (!config.value.activeModel && models.length > 0) {
          setActiveModel(models[0].id)
        }
        setReachable(true)
        recordSuccess()
        return true
      }
    } catch {
      setReachable(false)
      recordFailure()
    }
    return false
  }

  interface ToolFunction {
    name: string
    description: string
    parameters: Record<string, unknown>
  }

  interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    tool_call_id?: string
  }

  async function chatCompletion(
    messages: ChatMessage[],
    retryOnFailure: boolean = true,
    tools?: ToolFunction[],
    maxTokens?: number,
    externalSignal?: AbortSignal
  ): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
    if (!config.value.isReachable || !config.value.activeModel) {
      throw new Error('API not ready')
    }
    if (isCircuitOpen.value) {
      checkAndResetCircuitBreaker()
      if (isCircuitOpen.value) {
        throw new Error('Circuit breaker is open - API temporarily unavailable')
      }
    }

    if (window.electronAPI?.llmChatCompletion && config.value.activeProviderId) {
      try {
        const result = await window.electronAPI.llmChatCompletion({
          providerId: config.value.activeProviderId,
          model: config.value.activeModel,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
          })),
          tools,
          maxTokens
        })
        if (!result.success) {
          throw new Error(result.error || 'IPC chatCompletion failed')
        }
        recordSuccess()
        debugLog(`[chatCompletion:ipc] usage: prompt=${result.usage?.promptTokens ?? 0}, completion=${result.usage?.completionTokens ?? 0}, total=${result.usage?.totalTokens ?? 0}`)
        return {
          content: result.content ?? '',
          toolCalls: result.toolCalls ?? [],
          usage: result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('IPC') || errMsg.includes('not found') || errMsg.includes('decrypt')) {
          recordFailure()
          throw err
        }
        if (retryOnFailure && circuitBreaker.value.retryCount < circuitBreaker.value.maxRetries) {
          circuitBreaker.value.retryCount++
          await new Promise(r => setTimeout(r, 1000 * circuitBreaker.value.retryCount))
          return chatCompletion(messages, false, tools, maxTokens, externalSignal)
        }
        recordFailure()
        throw err
      }
    }

    const provider = activeProvider.value
    const baseUrl = (provider?.baseUrl || config.value.baseUrl).replace(/\/+$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider?.authType === 'bearer' && provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    } else if (provider?.authType === 'api-key' && provider.apiKey) {
      headers['x-api-key'] = provider.apiKey
    }

    const chatFormat = provider?.chatFormat || 'openai'
    let body: Record<string, unknown>
    let endpoint = '/v1/chat/completions'

    if (chatFormat === 'anthropic') {
      endpoint = '/v1/messages'
      body = {
        model: config.value.activeModel,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        max_tokens: 4096
      }
    } else {
      body = {
        model: config.value.activeModel,
        messages,
        stream: false,
        max_tokens: maxTokens || 16384
      }
      if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      }
    }

    try {
      const hasTools = !!(body as Record<string, unknown>).tools
      const toolCount = hasTools ? ((body as Record<string, unknown>).tools as unknown[]).length : 0
      debugLog(`[chatCompletion:direct] model=${config.value.activeModel}, msgs=${messages.length}, tools=${toolCount}, format=${chatFormat}`)
      const maxTok = maxTokens || ((body as Record<string, unknown>).max_tokens as number) || 16384
      const llmTierTimeout = maxTok <= 512 ? 15000 : maxTok <= 4096 ? 45000 : maxTok <= 8192 ? 75000 : 120000
      const llmAbsoluteCap = 180000
      const effectiveTimeout = Math.min(llmTierTimeout, llmAbsoluteCap)
      const tierSignal = AbortSignal.timeout(effectiveTimeout)
      const capSignal = AbortSignal.timeout(llmAbsoluteCap)
      let fetchSignal: AbortSignal
      if (externalSignal) {
        fetchSignal = AbortSignal.any([externalSignal, tierSignal, capSignal])
      } else {
        fetchSignal = AbortSignal.any([tierSignal, capSignal])
      }
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: fetchSignal
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        console.error(`[chatCompletion:direct] API error ${resp.status}:`, errBody.slice(0, 500))
        throw new Error(`API error ${resp.status}: ${errBody.slice(0, 200)}`)
      }
      const data = await resp.json()
      recordSuccess()

      if (chatFormat === 'anthropic') {
        const text = (data as Record<string, unknown>)?.content?.[0]?.text
        const pt = ((data as Record<string, unknown>)?.usage as Record<string, number>)?.input_tokens || 0
        const ct = ((data as Record<string, unknown>)?.usage as Record<string, number>)?.output_tokens || 0
        debugLog(`[chatCompletion:direct] usage: prompt=${pt}, completion=${ct}, total=${pt + ct}`)
        return { content: text ? String(text) : '', toolCalls: [] }
      }

      const choice = data.choices?.[0]
      const content = choice?.message?.content || ''
      const toolCalls: { id: string; name: string; arguments: string }[] = []
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '{}'
          })
        }
      }
      const finishReason = choice?.finish_reason || ''
      debugLog(`[chatCompletion:direct] response: contentLen=${content.length}, toolCalls=${toolCalls.length}, finish_reason=${finishReason}`)
      if (toolCalls.length > 0) {
        debugLog(`[chatCompletion:direct] toolCalls:`, toolCalls.map(tc => tc.name).join(', '))
      }
      const usage = data.usage ? { promptTokens: data.usage.prompt_tokens || 0, completionTokens: data.usage.completion_tokens || 0, totalTokens: data.usage.total_tokens || 0, cacheHitTokens: data.usage.prompt_cache_hit_tokens || 0, cacheMissTokens: data.usage.prompt_cache_miss_tokens || 0 } : { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
      debugLog(`[chatCompletion:direct] usage: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}, cacheHit=${usage.cacheHitTokens}, cacheMiss=${usage.cacheMissTokens}`)
      return { content, toolCalls, usage }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError') || errMsg.includes('timeout') || errMsg.includes('Timeout')
      if (isTimeout) {
        console.warn(`[chatCompletion:direct] 超时熔断触发`)
      }
      recordFailure()
      if (retryOnFailure && !isTimeout && circuitBreaker.value.retryCount < circuitBreaker.value.maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * circuitBreaker.value.retryCount))
        return chatCompletion(messages, false, tools)
      }
      throw err
    }
  }

  const gatewayAdapter: ModelGatewayAdapter = {
    async chatCompletion(messages) { const r = await chatCompletion(messages as ChatMessage[]); return r.content },
    listModels() { return config.value.models },
    switchProvider(providerId) { switchProvider(providerId) },
    switchModel(modelId) { setActiveModel(modelId) },
    getActiveProvider() { return activeProvider.value }
  }

  async function loadFromStorage() {
    try {
      const stored = await storeGet('api-config') as Partial<ApiConfig> | null
      const saved = stored || JSON.parse(localStorage.getItem('holo-api-config') || 'null') as Partial<ApiConfig> | null
      if (saved) {
        if (saved.baseUrl) config.value.baseUrl = saved.baseUrl
        if (saved.activeModel) config.value.activeModel = saved.activeModel
        if (saved.providers) {
          config.value.providers = saved.providers as ProviderConfig[]
          await decryptProviderKeys(config.value.providers)
        }
        if (saved.activeProviderId) config.value.activeProviderId = saved.activeProviderId
        if (config.value.activeProviderId) {
          const provider = config.value.providers.find(p => p.id === config.value.activeProviderId)
          if (provider) {
            config.value.models = provider.models
            config.value.isReachable = provider.isReachable
          }
        }
      }
    } catch { /* ignore */ }
  }

  async function encryptApiKey(key: string): Promise<string> {
    if (!key) return ''
    try {
      const available = await window.electronAPI?.safeStorageIsAvailable?.()
      if (!available) return key
      const encrypted = await window.electronAPI.safeStorageEncrypt(key)
      return encrypted ? `enc:${encrypted}` : key
    } catch {
      return key
    }
  }

  async function decryptApiKey(stored: string): Promise<string> {
    if (!stored || !stored.startsWith('enc:')) return stored
    try {
      const encrypted = stored.substring(4)
      const decrypted = await window.electronAPI.safeStorageDecrypt(encrypted)
      return decrypted || stored
    } catch {
      return stored
    }
  }

  async function decryptProviderKeys(providers: ProviderConfig[]) {
    for (const p of providers) {
      if (p.apiKey && p.apiKey.startsWith('enc:')) {
        p.apiKey = await decryptApiKey(p.apiKey)
      }
    }
  }

  async function saveToStorage() {
    const providersCopy: ProviderConfig[] = []
    for (const p of config.value.providers) {
      const encKey = p.apiKey ? await encryptApiKey(p.apiKey) : ''
      providersCopy.push({ ...p, apiKey: encKey })
    }
    const data = {
      baseUrl: config.value.baseUrl,
      activeModel: config.value.activeModel,
      providers: providersCopy,
      activeProviderId: config.value.activeProviderId
    }
    await storeSet('api-config', data)
    localStorage.setItem('holo-api-config', JSON.stringify(data))
  }

  return {
    config,
    circuitBreaker,
    isConfigured,
    hasActiveModel,
    isReady,
    isCircuitOpen,
    canMakeRequest,
    checkAndResetCircuitBreaker,
    activeProvider,
    gatewayAdapter,
    setBaseUrl,
    setModels,
    setActiveModel,
    setReachable,
    recordFailure,
    recordSuccess,
    resetCircuitBreaker,
    maybeResetCircuitBreaker,
    checkConnection,
    chatCompletion,
    addProvider,
    removeProvider,
    switchProvider,
    pingProvider,
    pingAllProviders,
    loadFromStorage,
    saveToStorage
  }
})
