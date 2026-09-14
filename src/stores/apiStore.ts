import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ApiConfig, ModelInfo, CircuitBreakerState, ProviderConfig, ModelGatewayAdapter, ModelTier, StreamChunk, StreamCallbacks } from '@/models'
import type { DetectedDomain } from '@/models'
import { storeGet, storeSet } from '@/services/secureStore'
import { debugLog } from '@/services/debugLog'
import { checkBudget } from '@/services/tokenBudget'
import { estimateTokens } from '@/services/tokenEstimate'
import { lookup as cacheLookup, store as cacheStore, getConfig as getCacheConfig } from '@/services/semanticCache'
import { route as smartRoute, recordRoutingOutcome, detectOverkill, textHash, getHistoricalTokenAvg } from '@/services/smartRouter'
import type { RouteInput, RoutingDecision } from '@/services/smartRouter'
import { readSSEStream } from '@/services/sseParser'
import { vault } from '@/vault'
import { getCurrentTraceId } from '@/services/trace'
import { globalBus } from '@/kernel/bus'
import { getPackIdForDomain } from '@/host/packRuntime'

interface AnthropicResponse {
  content?: { text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface OpenAIResponse {
  choices?: { message?: { content?: string; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[]
}

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

  const tokenBudgetMonthly = ref<number | null>(null)

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

  const DOMAIN_KEYWORDS: Record<string, string[]> = {
    legal: ['法律', '合同', '合规', '法规', '审查', '风险', '条款', 'law', 'contract', 'compliance', 'legal'],
    finance: ['财务', '报表', '预算', '税务', '审计', '金融', 'finance', 'budget', 'tax', 'audit'],
    hr: ['人力资源', '招聘', '薪酬', '绩效', '员工', 'hr', 'recruit', 'salary', 'employee'],
    general: []
  }

  function detectDomain(messages: ChatMessage[]): string {
    const systemMsg = messages.find(m => m.role === 'system')
    if (systemMsg?.content) {
      const text = systemMsg.content.toLowerCase()
      for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        if (domain === 'general') continue
        if (keywords.some(kw => text.includes(kw))) return domain
      }
    }
    const lastUserMsg = messages.filter(m => m.role === 'user').pop()
    if (lastUserMsg?.content) {
      const text = lastUserMsg.content.toLowerCase()
      for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        if (domain === 'general') continue
        if (keywords.some(kw => text.includes(kw))) return domain
      }
    }
    return 'general'
  }

  function toDetectedDomain(d: string): DetectedDomain {
    return d === 'legal' || d === 'finance' || d === 'hr' ? d : 'general'
  }

  function recordOutcome(
    userContent: string,
    decision: RoutingDecision,
    effectiveTier: ModelTier,
    actualCompletionTokens: number,
    actualCost: number,
    taskType?: string
  ): void {
    try {
      const overkill = detectOverkill(effectiveTier, actualCompletionTokens)
      recordRoutingOutcome({
        inputHash: textHash(userContent),
        taskType: taskType || 'chat',
        complexity: decision.complexity,
        selectedTier: effectiveTier,
        actualTokens: actualCompletionTokens,
        actualCost,
        qualityScore: overkill ? 5 : 3,
        overkill
      })
      debugLog(`[chatCompletion:outcome] tier=${effectiveTier}, tokens=${actualCompletionTokens}, overkill=${overkill}`)
    } catch { /* non-critical */ }
  }

  async function chatCompletion(
    messages: ChatMessage[],
    retryOnFailure: boolean = true,
    tools?: ToolFunction[],
    maxTokens?: number,
    externalSignal?: AbortSignal,
    routingOptions?: { taskType?: string; domain?: string; callerId?: string }
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

    const cacheEligible = (!tools || tools.length === 0) && messages.length <= 5
    let cacheHitTier: ModelTier | undefined
    // P1-40：成功调用统一发射 record-cost（经 bus 桥落 debugStore 记账 + 调试窗时间线）
    const emitRecordCost = (usage: { promptTokens: number; completionTokens: number; totalTokens: number }, tier?: string, category?: string) => {
      try {
        const traceId = getCurrentTraceId()
        globalBus.emit('debug:record-cost', {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          tier,
          category,
          ...(traceId ? { traceId } : {})
        })
      } catch { /* non-critical */ }
    }
    if (cacheEligible && getCacheConfig().enabled) {
      try {
        const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
          if (userMsg) {
            const domain = routingOptions?.domain || detectDomain(messages)
            // P1-13：packId 归因——domain→挂载 pack 映射，未挂载时 undefined（全局条目）
            const packId = getPackIdForDomain(domain)
            const cacheResult = await cacheLookup(userMsg, domain, packId)
          if (cacheResult.hit && cacheResult.entry) {
            cacheHitTier = cacheResult.entry.tier
            debugLog(`[chatCompletion:cache] HIT, saved ${cacheResult.savedTokens} tokens, ¥${cacheResult.savedCost.toFixed(4)}`)
            emitRecordCost({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cacheHitTier, 'cache')
            return {
              content: cacheResult.entry.responseText,
              toolCalls: [],
              usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                cacheHitTokens: cacheResult.entry.tokenUsage.completionTokens,
                cacheMissTokens: 0
              }
            }
          }
        }
      } catch { /* cache miss, continue to API */ }
    }

    const userContent = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
    const domain = routingOptions?.domain || detectDomain(messages)
    // P1-13：packId 归因，随 store 写入条目实现 pack 级隔离/卸载失效
    const packId = getPackIdForDomain(domain)
    const routingInput: RouteInput = {
      text: userContent,
      taskType: routingOptions?.taskType,
      domain: toDetectedDomain(routingOptions?.domain || detectDomain(messages)),
      callerId: routingOptions?.callerId,
      cacheHint: cacheHitTier ? { hit: true, tier: cacheHitTier } : undefined,
      historicalTokenAvg: getHistoricalTokenAvg(routingOptions?.taskType)
    }
    const decision = smartRoute(routingInput)
    const effectiveTier = decision.tier
    debugLog(`[chatCompletion:route] tier=${effectiveTier}, complexity=${decision.complexity}, reason=${decision.reason}`)

    const estimatedInput = estimateTokens(messages.map(m => m.content || '').join(''))
    const budgetResult = checkBudget(estimatedInput, effectiveTier)
    if (!budgetResult.allowed) {
      debugLog(`[chatCompletion:budget] BLOCKED - ${budgetResult.reason}`)
      throw new Error(`Budget exceeded: ${budgetResult.reason}`)
    }
    if (budgetResult.recommendedTier !== effectiveTier) {
      debugLog(`[chatCompletion:budget] ${budgetResult.reason}`)
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
        const ipcResult = {
          content: result.content ?? '',
          toolCalls: result.toolCalls ?? [],
          usage: result.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
        }
        if (cacheEligible && ipcResult.content.length > 50) {
          const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
          if (userMsg) {
            cacheStore({
              queryText: userMsg,
              responseText: ipcResult.content,
              tier: effectiveTier,
              promptTokens: ipcResult.usage.promptTokens,
              completionTokens: ipcResult.usage.completionTokens,
              domain,
              packId
            }).catch(() => {})
          }
        }
        recordOutcome(userContent, decision, effectiveTier, ipcResult.usage?.completionTokens ?? 0, budgetResult.estimatedCost, routingOptions?.taskType)
        emitRecordCost(ipcResult.usage, effectiveTier, 'llm')
        return ipcResult
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('IPC') || errMsg.includes('not found') || errMsg.includes('decrypt')) {
          recordFailure()
          throw err
        }
        if (retryOnFailure && circuitBreaker.value.retryCount < circuitBreaker.value.maxRetries) {
          circuitBreaker.value.retryCount++
          await new Promise(r => setTimeout(r, 1000 * circuitBreaker.value.retryCount))
          return chatCompletion(messages, false, tools, maxTokens, externalSignal, routingOptions)
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
      const hasTools = !!body.tools
      const toolCount = hasTools ? (body.tools as unknown[]).length : 0
      debugLog(`[chatCompletion:direct] model=${config.value.activeModel}, msgs=${messages.length}, tools=${toolCount}, format=${chatFormat}`)
      const maxTok = maxTokens || (body.max_tokens as number) || 16384
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
        const aResp = data as AnthropicResponse
        const text = aResp?.content?.[0]?.text
        const pt = aResp?.usage?.input_tokens || 0
        const ct = aResp?.usage?.output_tokens || 0
        debugLog(`[chatCompletion:direct] usage: prompt=${pt}, completion=${ct}, total=${pt + ct}`)
        const anthropicResult = { content: text ? String(text) : '', toolCalls: [] }
        if (cacheEligible && anthropicResult.content.length > 50) {
          const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
          if (userMsg) {
            cacheStore({
              queryText: userMsg,
              responseText: anthropicResult.content,
              tier: effectiveTier,
              promptTokens: pt,
              completionTokens: ct,
              domain,
              packId
            }).catch(() => {})
          }
        }
        recordOutcome(userContent, decision, effectiveTier, ct, budgetResult.estimatedCost, routingOptions?.taskType)
        emitRecordCost({ promptTokens: pt, completionTokens: ct, totalTokens: pt + ct }, effectiveTier, 'llm')
        return anthropicResult
      }

      const oResp = data as OpenAIResponse
      const choice = oResp.choices?.[0]
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
      const directResult = { content, toolCalls, usage }
      if (cacheEligible && content.length > 50 && toolCalls.length === 0) {
        const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
        if (userMsg) {
          cacheStore({
            queryText: userMsg,
            responseText: content,
            tier: effectiveTier,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            domain,
            packId
          }).catch(() => {})
        }
      }
      recordOutcome(userContent, decision, effectiveTier, usage.completionTokens, budgetResult.estimatedCost, routingOptions?.taskType)
      emitRecordCost(usage, effectiveTier, 'llm')
      return directResult
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError') || errMsg.includes('timeout') || errMsg.includes('Timeout')
      if (isTimeout) {
        debugLog('[chatCompletion:direct] 超时熔断触发')
      }
      recordFailure()
      if (retryOnFailure && !isTimeout && circuitBreaker.value.retryCount < circuitBreaker.value.maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * circuitBreaker.value.retryCount))
        return chatCompletion(messages, false, tools, maxTokens, externalSignal, routingOptions)
      }
      throw err
    }
  }

  async function chatCompletionStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    tools?: ToolFunction[],
    maxTokens?: number,
    externalSignal?: AbortSignal,
    routingOptions?: { taskType?: string; domain?: string; callerId?: string }
  ): Promise<{ cancel: () => void }> {
    if (!config.value.isReachable || !config.value.activeModel) {
      callbacks.onError(new Error('API not ready'))
      return { cancel: () => {} }
    }
    if (isCircuitOpen.value) {
      checkAndResetCircuitBreaker()
      if (isCircuitOpen.value) {
        callbacks.onError(new Error('Circuit breaker is open'))
        return { cancel: () => {} }
      }
    }

    const userContent = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
    const domain = routingOptions?.domain || detectDomain(messages)
    // P1-13：packId 归因（同 chatCompletion 非流式路径）
    const packId = getPackIdForDomain(domain)
    const routingInput: RouteInput = {
      text: userContent,
      taskType: routingOptions?.taskType,
      domain: toDetectedDomain(routingOptions?.domain || detectDomain(messages)),
      callerId: routingOptions?.callerId,
      historicalTokenAvg: getHistoricalTokenAvg(routingOptions?.taskType)
    }
    const decision = smartRoute(routingInput)
    const effectiveTier = decision.tier
    debugLog(`[chatCompletionStream:route] tier=${effectiveTier}, complexity=${decision.complexity}`)

    const estimatedInput = estimateTokens(messages.map(m => m.content || '').join(''))
    const budgetResult = checkBudget(estimatedInput, effectiveTier)
    if (!budgetResult.allowed) {
      callbacks.onError(new Error(`Budget exceeded: ${budgetResult.reason}`))
      return { cancel: () => {} }
    }

    const controller = new AbortController()
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal

    const cancel = () => controller.abort()

    if (window.electronAPI?.llmChatCompletionStream && config.value.activeProviderId) {
      try {
        const cleanup = window.electronAPI.llmChatCompletionStream(
          {
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
          },
          {
            onChunk: (chunk: StreamChunk) => {
              if (!combinedSignal.aborted) callbacks.onChunk(chunk)
            },
            onDone: (final) => {
              if (!combinedSignal.aborted) {
                recordSuccess()
                recordOutcome(userContent, decision, effectiveTier, final.usage?.completionTokens ?? 0, budgetResult.estimatedCost, routingOptions?.taskType)
                callbacks.onDone(final)
              }
            },
            onError: (err: string) => {
              if (!combinedSignal.aborted) {
                recordFailure()
                callbacks.onError(new Error(err))
              }
            }
          }
        )
        const origCancel = cancel
        return { cancel: () => { origCancel(); cleanup() } }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('IPC') || errMsg.includes('not found') || errMsg.includes('decrypt')) {
          callbacks.onError(err instanceof Error ? err : new Error(errMsg))
          return { cancel }
        }
        debugLog('[chatCompletionStream:ipc] falling back to direct fetch')
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
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model: config.value.activeModel,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        max_tokens: maxTokens || 4096,
        stream: true
      }
    } else {
      body = {
        model: config.value.activeModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens || 16384
      }
      if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      }
    }

    const maxTok = maxTokens || (body.max_tokens as number) || 16384
    const llmTierTimeout = maxTok <= 512 ? 15000 : maxTok <= 4096 ? 45000 : maxTok <= 8192 ? 75000 : 120000
    const llmAbsoluteCap = 180000
    const tierSignal = AbortSignal.timeout(Math.min(llmTierTimeout, llmAbsoluteCap))
    const capSignal = AbortSignal.timeout(llmAbsoluteCap)
    const fetchSignal = AbortSignal.any([combinedSignal, tierSignal, capSignal])

    ;(async () => {
      try {
        const resp = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: fetchSignal
        })
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '')
          throw new Error(`API error ${resp.status}: ${errBody.slice(0, 200)}`)
        }
        if (!resp.body) {
          throw new Error('Response body is null — streaming not supported')
        }

        let accumulatedContent = ''
        const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
        let usageInfo: StreamChunk['usage'] | undefined

        await readSSEStream(resp.body, chatFormat as 'openai' | 'anthropic', (delta) => {
          if (combinedSignal.aborted) return

          if (delta.content) {
            accumulatedContent += delta.content
            callbacks.onChunk({
              content: accumulatedContent,
              delta: delta.content,
              toolCalls: undefined,
              usage: undefined,
              done: false
            })
          }

          if (delta.toolCalls) {
            for (const tc of delta.toolCalls) {
              const existing = toolCallMap.get(tc.index)
              if (existing) {
                if (tc.id) existing.id = tc.id
                if (tc.name) existing.name = tc.name
                if (tc.arguments) existing.arguments = (existing.arguments || '') + tc.arguments
              } else {
                toolCallMap.set(tc.index, { id: tc.id || '', name: tc.name || '', arguments: tc.arguments || '' })
              }
            }
          }

          if (delta.usage) {
            usageInfo = {
              promptTokens: delta.usage.promptTokens ?? usageInfo?.promptTokens ?? 0,
              completionTokens: delta.usage.completionTokens ?? usageInfo?.completionTokens ?? 0,
              totalTokens: (delta.usage.promptTokens ?? usageInfo?.promptTokens ?? 0) + (delta.usage.completionTokens ?? usageInfo?.completionTokens ?? 0),
              cacheHitTokens: delta.usage.cacheHitTokens ?? usageInfo?.cacheHitTokens ?? 0,
              cacheMissTokens: delta.usage.cacheMissTokens ?? usageInfo?.cacheMissTokens ?? 0,
            }
          }

          if (delta.done) {
            const toolCalls = Array.from(toolCallMap.values())
            recordSuccess()
            const cacheEligible = (!tools || tools.length === 0) && messages.length <= 5
            if (cacheEligible && accumulatedContent.length > 50 && toolCalls.length === 0) {
              const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
              if (userMsg) {
                cacheStore({
                  queryText: userMsg,
                  responseText: accumulatedContent,
                  tier: effectiveTier,
                  promptTokens: usageInfo?.promptTokens ?? 0,
                  completionTokens: usageInfo?.completionTokens ?? 0,
                  domain,
                  packId
                }).catch(() => {})
              }
            }
            recordOutcome(userContent, decision, effectiveTier, usageInfo?.completionTokens ?? 0, budgetResult.estimatedCost, routingOptions?.taskType)
            callbacks.onDone({ content: accumulatedContent, toolCalls, usage: usageInfo })
          }
        }, fetchSignal)
      } catch (err) {
        if (!combinedSignal.aborted) {
          recordFailure()
          callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()

    return { cancel }
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
      const vaultData = vault.readCache('api', 'holo-api-config')
      const saved = stored || (vaultData ? JSON.parse(vaultData) as Partial<ApiConfig> : null)
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
    vault.writeThrough('api', 'holo-api-config', JSON.stringify(data), true)
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
    chatCompletionStream,
    addProvider,
    removeProvider,
    switchProvider,
    pingProvider,
    pingAllProviders,
    tokenBudgetMonthly,
    loadFromStorage,
    saveToStorage,
    detectDomain
  }
})
