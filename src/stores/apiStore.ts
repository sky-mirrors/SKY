import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ApiConfig, ModelInfo, CircuitBreakerState, ProviderConfig, ModelGatewayAdapter, ModelTier, StreamChunk, StreamCallbacks } from '@/models'
import type { DetectedDomain } from '@/models'
import { storeGet, storeSet } from '@/services/secureStore'
import { debugLog } from '@/services/debugLog'
import { checkBudget } from '@/services/tokenBudget'
import { calculateCost } from '@/services/tokenPricing'
import { estimateTokens } from '@/services/tokenEstimate'
import { lookup as cacheLookup, store as cacheStore, getConfig as getCacheConfig } from '@/services/semanticCache'
import { route as smartRoute, recordRoutingOutcome, detectOverkill, textHash, getHistoricalTokenAvg } from '@/services/smartRouter'
import type { RouteInput, RoutingDecision } from '@/services/smartRouter'
import { readSSEStream } from '@/services/sseParser'
import { probeOllama, ollamaChat, ollamaChatStream } from '@/services/ollamaProvider'
// M20：降级链纯服务（规格 10.2/M20）——探测缓存/可降级分类/事件广播
import {
  buildProviderChain,
  isRetryableProviderError,
  probeChainTarget,
  markChainResult,
  pickOllamaModel,
  emitDegraded,
  DegradeTarget
} from '@/services/providerChain'
import { vault } from '@/vault'
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

  // A5-11：safeStorage 不可用/加密失败时 API key 以明文保存的显式警告标志（供 UI 提示）
  const plaintextKeyWarning = ref(false)

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
        // B-12：冷却恢复必须同时返还重试预算——否则 retryCount 打满后即使熔断
        // 恢复也永不再重试，直到一次成功（而失败路径已无重试，成功更难）
        circuitBreaker.value.retryCount = 0
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
        // B-12：与 checkAndResetCircuitBreaker 一致，冷却恢复返还重试预算
        circuitBreaker.value.retryCount = 0
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
    // M17：Ollama 常驻 127.0.0.1——主进程 isHostAllowed 拒绝 loopback（SSRF 防护，P0-1），
    // 跳过 IPC llmListModels，渲染进程直连 GET /api/tags 探测
    if (provider.chatFormat === 'ollama') {
      const probe = await probeOllama(provider.baseUrl)
      if (probe.ok) {
        const models: ModelInfo[] = probe.models.map(m => ({ ...m, providerId: provider.id }))
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
      provider.isReachable = false
      provider.lastCheckedAt = Date.now()
      if (provider.id === config.value.activeProviderId) {
        config.value.isReachable = false
        recordFailure()
      }
      return false
    }
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

  // G-5：actualCost 按实际 usage 计价——原实现 7 处全传 budgetResult.estimatedCost，
  // 账本记的是"预测"而非"实付"；本地 Ollama 调用与记账口径一致记 0
  function actualCostOf(usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number }, local: boolean): number {
    if (local) return 0
    return calculateCost(usage.promptTokens, usage.completionTokens, usage.cacheHitTokens ?? 0).totalCost
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
        // G-4：显式占位 0=未评测（无真实质量信号可用）；原 overkill?5:3 系编造且倒挂
        qualityScore: 0,
        overkill
      })
      debugLog(`[chatCompletion:outcome] tier=${effectiveTier}, tokens=${actualCompletionTokens}, cost=${actualCost.toFixed(4)}, overkill=${overkill}`)
    } catch { /* non-critical */ }
  }

  // M20：per-request 降级态（尾参传递，绝无模块级请求全局——#2 教训）
  interface DegradeState {
    target: DegradeTarget
    model: string
  }

  /** M20：按链序找第一个可用的本地 Ollama 目标（探测带 TTL 缓存） */
  async function findDegradedTarget(): Promise<DegradeState | null> {
    const chain = buildProviderChain(config.value.activeProviderId, config.value.providers)
    for (const target of chain) {
      if (!target.implicit && target.providerId === config.value.activeProviderId) continue
      if (target.chatFormat !== 'ollama') continue
      const probe = await probeChainTarget(target)
      if (!probe.ok) continue
      const model = pickOllamaModel(target, probe)
      if (!model) continue
      return { target, model }
    }
    return null
  }

  function degradeFromInfo(): { providerId: string; name: string } {
    const id = config.value.activeProviderId || ''
    return { providerId: id, name: activeProvider.value?.name || id || '未配置' }
  }

  const ALL_CHANNELS_DOWN = '所有 LLM 通道均不可用：远程不可达且无本地模型（离线）'

  /**
   * M20：透明降级——远程失败（网络/5xx/超时/429）时按链回退本地 Ollama，
   * 不改 activeProvider；链上逐目标尝试，全部失败返回 null 由调用方决定后续。
   */
  async function tryDegradeChain(
    originalErr: unknown,
    messages: ChatMessage[],
    retryOnFailure: boolean,
    tools: ToolFunction[] | undefined,
    maxTokens: number | undefined,
    externalSignal: AbortSignal | undefined,
    routingOptions: { taskType?: string; domain?: string; callerId?: string; traceId?: string; temperature?: number } | undefined
  ): Promise<Awaited<ReturnType<typeof chatCompletion>> | null> {
    const reason = (originalErr instanceof Error ? originalErr.message : String(originalErr)).slice(0, 120)
    const chain = buildProviderChain(config.value.activeProviderId, config.value.providers)
    for (const target of chain) {
      if (!target.implicit && target.providerId === config.value.activeProviderId) continue
      if (target.chatFormat !== 'ollama') continue
      const probe = await probeChainTarget(target)
      if (!probe.ok) continue
      const model = pickOllamaModel(target, probe)
      if (!model) continue
      emitDegraded(globalBus, degradeFromInfo(), target, reason)
      try {
        const r = await chatCompletion(messages, retryOnFailure, tools, maxTokens, externalSignal, routingOptions, { target, model })
        markChainResult(target, true)
        return r
      } catch (err2) {
        if (externalSignal?.aborted) return null
        markChainResult(target, false)
        debugLog(`[chatCompletion:degrade] ${target.name} 也失败，继续链上下一级`)
      }
    }
    return null
  }

  async function chatCompletion(
    messages: ChatMessage[],
    retryOnFailure: boolean = true,
    tools?: ToolFunction[],
    maxTokens?: number,
    externalSignal?: AbortSignal,
    routingOptions?: { taskType?: string; domain?: string; callerId?: string; traceId?: string; temperature?: number },
    degradeState?: DegradeState
  ): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number } }> {
    // M20：降级态绕过远程就绪/熔断检查——能走到降级态说明远程已失败
    if (!degradeState && (!config.value.isReachable || !config.value.activeModel)) {
      const degraded = await tryDegradeChain(new Error('API not ready'), messages, retryOnFailure, tools, maxTokens, externalSignal, routingOptions)
      if (degraded) return degraded
      throw new Error('API not ready')
    }
    if (!degradeState && isCircuitOpen.value) {
      checkAndResetCircuitBreaker()
      if (isCircuitOpen.value) {
        // M20：熔断 open → 先试降级链上下一级，链不可用再抛
        const degraded = await tryDegradeChain(new Error('circuit breaker open'), messages, retryOnFailure, tools, maxTokens, externalSignal, routingOptions)
        if (degraded) return degraded
        throw new Error('Circuit breaker is open - API temporarily unavailable')
      }
    }

    const cacheEligible = (!tools || tools.length === 0) && messages.length <= 5
    let cacheHitTier: ModelTier | undefined
    // #5：benchmark 压测流量与生产记账/学习完全隔离——经 taskType='benchmark' 识别，
    // 跳过生产响应缓存读写、预算 block、ZOL 路由学习与 record-cost 记账
    // （P1-33 只隔离了指纹库；此处补齐 tokenBudget/sessionSpent、routingHistory
    // 与 debugStore 记账三类污染面，并避免 budget=0 恒超限时 benchmark 被 block）
    const isBenchmarkTraffic = routingOptions?.taskType === 'benchmark'
    // P1-40：成功调用统一发射 record-cost（经 bus 桥落 debugStore 记账 + 调试窗时间线）
    // M17/M20：local=true 标记本地 Ollama 调用，费用记 0
    const emitRecordCost = (usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens?: number }, tier?: string, category?: string, local?: boolean) => {
      if (isBenchmarkTraffic) return
      try {
        // #2 收尾：traceId 改经 routingOptions 参数传入（原模块级全局并发下串号）
        const traceId = routingOptions?.traceId
        globalBus.emit('debug:record-cost', {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          // G-5：cacheHitTokens 透传真实值（原记账链路硬编码 0，缓存节省从未入账）
          ...(usage.cacheHitTokens ? { cacheHitTokens: usage.cacheHitTokens } : {}),
          tier,
          category,
          ...(traceId ? { traceId } : {}),
          ...(local ? { local: true } : {})
        })
      } catch { /* non-critical */ }
    }
    if (!degradeState && cacheEligible && !isBenchmarkTraffic && getCacheConfig().enabled) {
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
    // M20：降级态（本地零费用）不受预算 block；远程预算已在发起方检查过
    if (!isBenchmarkTraffic && !degradeState) {
      if (!budgetResult.allowed) {
        debugLog(`[chatCompletion:budget] BLOCKED - ${budgetResult.reason}`)
        throw new Error(`Budget exceeded: ${budgetResult.reason}`)
      }
      if (budgetResult.recommendedTier !== effectiveTier) {
        debugLog(`[chatCompletion:budget] ${budgetResult.reason}`)
      }
    }

    // M17：Ollama 走渲染进程直连（主进程 isHostAllowed 拒绝 loopback），禁走 IPC
    // M20：降级态同样直连（目标是本地 Ollama）
    if (!degradeState && window.electronAPI?.llmChatCompletion && config.value.activeProviderId
      && activeProvider.value?.chatFormat !== 'ollama') {
      try {
        const ipcArgs = {
          providerId: config.value.activeProviderId,
          model: config.value.activeModel,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
          })),
          tools,
          maxTokens,
          // G-2：temperature 随 IPC 透传（主进程侧入请求体；不传时行为不变）
          ...(routingOptions?.temperature !== undefined ? { temperature: routingOptions.temperature } : {})
        }
        // B-07：IPC 无法携带 AbortSignal，原实现直接忽略 externalSignal——
        // 用 race 让调用方侧中止即时生效（主进程侧请求由其自身超时兜底）
        const ipcCall = window.electronAPI.llmChatCompletion(ipcArgs)
        const result = await (externalSignal
          ? Promise.race([
              ipcCall,
              new Promise<never>((_, reject) => {
                if (externalSignal.aborted) {
                  reject(new DOMException('Aborted', 'AbortError'))
                } else {
                  externalSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
                }
              })
            ])
          : ipcCall)
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
        if (cacheEligible && !isBenchmarkTraffic && ipcResult.content.length > 50) {
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
        // #5：benchmark 流量不进 ZOL 路由学习（recordOutcome→routingHistory）
        if (!isBenchmarkTraffic) {
          recordOutcome(userContent, decision, effectiveTier, ipcResult.usage?.completionTokens ?? 0, actualCostOf({ promptTokens: ipcResult.usage?.promptTokens ?? 0, completionTokens: ipcResult.usage?.completionTokens ?? 0, cacheHitTokens: ipcResult.usage?.cacheHitTokens ?? 0 }, false), routingOptions?.taskType)
        }
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
        // M20：重试预算耗尽且可降级（网络/5xx/超时/429）→ 透明回退本地 Ollama 链
        if (!degradeState && isRetryableProviderError(err)) {
          const degraded = await tryDegradeChain(err, messages, retryOnFailure, tools, maxTokens, externalSignal, routingOptions)
          if (degraded) return degraded
          recordFailure()
          throw new Error(`${ALL_CHANNELS_DOWN}｜${errMsg.slice(0, 120)}`)
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

    // M20：降级态强制走 Ollama 分支（目标是本地 Ollama，非 active provider）
    const chatFormat = degradeState ? 'ollama' : (provider?.chatFormat || 'openai')
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
    // G-2：temperature 经 routingOptions 可选透传——未传时请求体与现状等价
    if (routingOptions?.temperature !== undefined) {
      body.temperature = routingOptions.temperature
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
      // M17：Ollama 原生 /api/chat（stream:false）——单 JSON 响应，无 toolCalls
      if (chatFormat === 'ollama') {
        // M20：降级态使用降级目标的端点与模型
        const ollamaBase = degradeState ? degradeState.target.baseUrl : baseUrl
        const ollamaModel = degradeState
          ? degradeState.model
          : (config.value.activeModel || provider?.models?.[0]?.id || '')
        if (!ollamaModel) {
          throw new Error('Ollama: 无可用模型（请先 pingProvider 拉取模型清单）')
        }
        const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content || '' }))
        const r = await ollamaChat(ollamaBase, ollamaModel, ollamaMessages, maxTokens, fetchSignal, routingOptions?.temperature)
        recordSuccess()
        debugLog(`[chatCompletion:ollama] model=${ollamaModel}, usage: prompt=${r.usage.promptTokens}, completion=${r.usage.completionTokens}, total=${r.usage.totalTokens}`)
        const ollamaResult = { content: r.content, toolCalls: [], usage: r.usage }
        if (cacheEligible && !isBenchmarkTraffic && r.content.length > 50) {
          const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
          if (userMsg) {
            cacheStore({
              queryText: userMsg,
              responseText: r.content,
              tier: effectiveTier,
              promptTokens: r.usage.promptTokens,
              completionTokens: r.usage.completionTokens,
              domain,
              packId
            }).catch(() => {})
          }
        }
        // #5：benchmark 流量不进 ZOL 路由学习
        if (!isBenchmarkTraffic) {
          recordOutcome(userContent, decision, effectiveTier, r.usage.completionTokens, actualCostOf(r.usage, true), routingOptions?.taskType)
        }
        // M17/M20：本地 Ollama 零费用记账
        emitRecordCost(r.usage, effectiveTier, 'llm', true)
        return ollamaResult
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
        if (cacheEligible && !isBenchmarkTraffic && anthropicResult.content.length > 50) {
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
        // #5：benchmark 流量不进 ZOL 路由学习
        if (!isBenchmarkTraffic) {
          recordOutcome(userContent, decision, effectiveTier, ct, actualCostOf({ promptTokens: pt, completionTokens: ct }, false), routingOptions?.taskType)
        }
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
      if (cacheEligible && !isBenchmarkTraffic && content.length > 50 && toolCalls.length === 0) {
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
      // #5：benchmark 流量不进 ZOL 路由学习
      if (!isBenchmarkTraffic) {
        recordOutcome(userContent, decision, effectiveTier, usage.completionTokens, actualCostOf(usage, false), routingOptions?.taskType)
      }
      emitRecordCost(usage, effectiveTier, 'llm')
      return directResult
      } catch (err) {
        // B-07：调用方主动中止不是故障，不进重试/熔断统计
        if (externalSignal?.aborted) throw err
        const errMsg = err instanceof Error ? err.message : String(err)
      const isTimeout = errMsg.includes('abort') || errMsg.includes('AbortError') || errMsg.includes('timeout') || errMsg.includes('Timeout')
      if (isTimeout) {
        debugLog('[chatCompletion:direct] 超时熔断触发')
      }
      // B-12：与 IPC 路径语义对齐——可重试失败只消耗重试预算（retryCount++），
      // 不再先 recordFailure() 计入熔断失败数；预算耗尽才计为熔断失败
      if (retryOnFailure && !isTimeout && circuitBreaker.value.retryCount < circuitBreaker.value.maxRetries) {
        circuitBreaker.value.retryCount++
        await new Promise(r => setTimeout(r, 1000 * circuitBreaker.value.retryCount))
        return chatCompletion(messages, false, tools, maxTokens, externalSignal, routingOptions)
      }
      // M20：重试预算耗尽且可降级（网络/5xx/超时/429）→ 透明回退本地 Ollama 链
      if (!degradeState && isRetryableProviderError(err)) {
        const degraded = await tryDegradeChain(err, messages, retryOnFailure, tools, maxTokens, externalSignal, routingOptions)
        if (degraded) return degraded
        recordFailure()
        throw new Error(`${ALL_CHANNELS_DOWN}｜${errMsg.slice(0, 120)}`)
      }
      recordFailure()
      throw err
    }
  }

  async function chatCompletionStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    tools?: ToolFunction[],
    maxTokens?: number,
    externalSignal?: AbortSignal,
    routingOptions?: { taskType?: string; domain?: string; callerId?: string; traceId?: string; temperature?: number },
    degradeState?: DegradeState
  ): Promise<{ cancel: () => void }> {
    // M20：远程未就绪 → 先试降级链（本地 Ollama 可能仍可用），链不可用再报错
    if (!degradeState && (!config.value.isReachable || !config.value.activeModel)) {
      const fallback = await findDegradedTarget()
      if (!fallback) {
        callbacks.onError(new Error('API not ready'))
        return { cancel: () => {} }
      }
      emitDegraded(globalBus, degradeFromInfo(), fallback.target, 'API not ready')
      degradeState = fallback
    }
    if (!degradeState && isCircuitOpen.value) {
      checkAndResetCircuitBreaker()
      if (isCircuitOpen.value) {
        // M20：熔断 open → 先试降级链上下一级，链不可用再抛
        const fallback = await findDegradedTarget()
        if (fallback) {
          emitDegraded(globalBus, degradeFromInfo(), fallback.target, 'circuit breaker open')
          degradeState = fallback
        } else {
          callbacks.onError(new Error('Circuit breaker is open'))
          return { cancel: () => {} }
        }
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
    // #5：benchmark 压测流量不受预算 block（budget=0 恒超限时 benchmark 会被误拦）
    const isBenchmarkTraffic = routingOptions?.taskType === 'benchmark'
    if (!budgetResult.allowed && !isBenchmarkTraffic) {
      callbacks.onError(new Error(`Budget exceeded: ${budgetResult.reason}`))
      return { cancel: () => {} }
    }

    const controller = new AbortController()
    const combinedSignal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal

    const cancel = () => controller.abort()

    // #4 收尾：流式成功路径原不发射 record-cost——C-10 修复、流式启用后整体绕过
    // debugStore 记账/sessionSpent 消耗；此处与非流式路径同口径补齐
    // #5：benchmark 压测流量同样隔离，不进生产记账
    // M17/M20：local=true 标记本地 Ollama 调用，费用记 0
    const emitRecordCost = (usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens?: number }, tier?: string, category?: string, local?: boolean) => {
      if (isBenchmarkTraffic) return
      try {
        globalBus.emit('debug:record-cost', {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          // G-5：cacheHitTokens 透传真实值（原记账链路硬编码 0）
          ...(usage.cacheHitTokens ? { cacheHitTokens: usage.cacheHitTokens } : {}),
          tier,
          category,
          ...(routingOptions?.traceId ? { traceId: routingOptions.traceId } : {}),
          ...(local ? { local: true } : {})
        })
      } catch { /* non-critical */ }
    }

    // M17：Ollama 走渲染进程直连 NDJSON，禁走 IPC；M20：降级态同样直连
    if (!degradeState && window.electronAPI?.llmChatCompletionStream && config.value.activeProviderId
      && activeProvider.value?.chatFormat !== 'ollama') {
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
            maxTokens,
            // G-2：temperature 随 IPC 透传（主进程侧入请求体；不传时行为不变）
            ...(routingOptions?.temperature !== undefined ? { temperature: routingOptions.temperature } : {})
          },
          {
            onChunk: (chunk: StreamChunk) => {
              if (!combinedSignal.aborted) callbacks.onChunk(chunk)
            },
            onDone: (final) => {
              if (!combinedSignal.aborted) {
                recordSuccess()
                recordOutcome(userContent, decision, effectiveTier, final.usage?.completionTokens ?? 0, actualCostOf({ promptTokens: final.usage?.promptTokens ?? 0, completionTokens: final.usage?.completionTokens ?? 0, cacheHitTokens: final.usage?.cacheHitTokens ?? 0 }, false), routingOptions?.taskType)
                emitRecordCost({
                  promptTokens: final.usage?.promptTokens ?? 0,
                  completionTokens: final.usage?.completionTokens ?? 0,
                  totalTokens: final.usage?.totalTokens ?? (final.usage?.promptTokens ?? 0) + (final.usage?.completionTokens ?? 0),
                  cacheHitTokens: final.usage?.cacheHitTokens ?? 0
                }, effectiveTier, 'llm')
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

    // M20：降级态强制走 Ollama NDJSON 分支（目标是本地 Ollama）
    const chatFormat = degradeState ? 'ollama' : (provider?.chatFormat || 'openai')
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
    // G-2：temperature 经 routingOptions 可选透传——未传时请求体与现状等价
    if (routingOptions?.temperature !== undefined) {
      body.temperature = routingOptions.temperature
    }

    const maxTok = maxTokens || (body.max_tokens as number) || 16384
    const llmTierTimeout = maxTok <= 512 ? 15000 : maxTok <= 4096 ? 45000 : maxTok <= 8192 ? 75000 : 120000
    const llmAbsoluteCap = 180000
    const tierSignal = AbortSignal.timeout(Math.min(llmTierTimeout, llmAbsoluteCap))
    const capSignal = AbortSignal.timeout(llmAbsoluteCap)
    const fetchSignal = AbortSignal.any([combinedSignal, tierSignal, capSignal])

    // M20：是否已向调用方发射过 chunk——流式仅允许首 chunk 前降级切换
    let deliveredAnyChunk = false

    // M17/M20：Ollama NDJSON 流式主体——直连，供 active-ollama 与降级路径复用
    const streamFromOllama = async (ollamaBase: string, ollamaModel: string): Promise<void> => {
      const ollamaMessages = messages.map(m => ({ role: m.role, content: m.content || '' }))
      let accumulated = ''
      let usageInfo: StreamChunk['usage'] | undefined
      await ollamaChatStream(ollamaBase, ollamaModel, ollamaMessages, (delta) => {
        if (combinedSignal.aborted) return
        if (delta.content) {
          accumulated += delta.content
          deliveredAnyChunk = true
          callbacks.onChunk({ content: accumulated, delta: delta.content, toolCalls: undefined, usage: undefined, done: false })
        }
        if (delta.usage) {
          usageInfo = {
            promptTokens: delta.usage.promptTokens ?? 0,
            completionTokens: delta.usage.completionTokens ?? 0,
            totalTokens: (delta.usage.promptTokens ?? 0) + (delta.usage.completionTokens ?? 0),
            cacheHitTokens: 0,
            cacheMissTokens: delta.usage.promptTokens ?? 0
          }
        }
        if (delta.done) {
          recordSuccess()
          if (!isBenchmarkTraffic && accumulated.length > 50) {
            const userMsg = messages.filter(m => m.role === 'user').map(m => m.content || '').join('\n')
            if (userMsg) {
              cacheStore({
                queryText: userMsg,
                responseText: accumulated,
                tier: effectiveTier,
                promptTokens: usageInfo?.promptTokens ?? 0,
                completionTokens: usageInfo?.completionTokens ?? 0,
                domain,
                packId
              }).catch(() => {})
            }
          }
          // #5：benchmark 流量不进 ZOL 路由学习
          if (!isBenchmarkTraffic) {
            recordOutcome(userContent, decision, effectiveTier, usageInfo?.completionTokens ?? 0, actualCostOf({ promptTokens: usageInfo?.promptTokens ?? 0, completionTokens: usageInfo?.completionTokens ?? 0 }, true), routingOptions?.taskType)
          }
          emitRecordCost({
            promptTokens: usageInfo?.promptTokens ?? 0,
            completionTokens: usageInfo?.completionTokens ?? 0,
            totalTokens: usageInfo?.totalTokens ?? 0
          }, effectiveTier, 'llm', true)
          callbacks.onDone({ content: accumulated, toolCalls: [], usage: usageInfo })
        }
      }, maxTokens, fetchSignal, routingOptions?.temperature)
    }

    ;(async () => {
      try {
      // M17：Ollama 原生 /api/chat NDJSON 流式；M20：降级态使用降级目标端点/模型
      if (chatFormat === 'ollama') {
        const ollamaBase = degradeState ? degradeState.target.baseUrl : baseUrl
        const ollamaModel = degradeState
          ? degradeState.model
          : (config.value.activeModel || provider?.models?.[0]?.id || '')
        if (!ollamaModel) {
          throw new Error('Ollama: 无可用模型（请先 pingProvider 拉取模型清单）')
        }
        await streamFromOllama(ollamaBase, ollamaModel)
        return
      }
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
            deliveredAnyChunk = true
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
            if (cacheEligible && !isBenchmarkTraffic && accumulatedContent.length > 50 && toolCalls.length === 0) {
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
            recordOutcome(userContent, decision, effectiveTier, usageInfo?.completionTokens ?? 0, actualCostOf({ promptTokens: usageInfo?.promptTokens ?? 0, completionTokens: usageInfo?.completionTokens ?? 0, cacheHitTokens: usageInfo?.cacheHitTokens ?? 0 }, false), routingOptions?.taskType)
            emitRecordCost({
              promptTokens: usageInfo?.promptTokens ?? 0,
              completionTokens: usageInfo?.completionTokens ?? 0,
              totalTokens: usageInfo?.totalTokens ?? (usageInfo?.promptTokens ?? 0) + (usageInfo?.completionTokens ?? 0),
              cacheHitTokens: usageInfo?.cacheHitTokens ?? 0
            }, effectiveTier, 'llm')
            callbacks.onDone({ content: accumulatedContent, toolCalls, usage: usageInfo })
          }
        }, fetchSignal)
      } catch (err) {
        if (!combinedSignal.aborted) {
          // M20：首 chunk 前失败且可降级（网络/5xx/超时/429）→ 透明回退本地 Ollama 链；
          // 已发射过 chunk 则不切换（避免调用方收到重复内容）
          if (!degradeState && !deliveredAnyChunk && isRetryableProviderError(err)) {
            const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120)
            const chain = buildProviderChain(config.value.activeProviderId, config.value.providers)
            let degraded = false
            for (const target of chain) {
              if (!target.implicit && target.providerId === config.value.activeProviderId) continue
              if (target.chatFormat !== 'ollama') continue
              const probe = await probeChainTarget(target)
              if (!probe.ok) continue
              const model = pickOllamaModel(target, probe)
              if (!model) continue
              emitDegraded(globalBus, degradeFromInfo(), target, reason)
              try {
                await streamFromOllama(target.baseUrl, model)
                markChainResult(target, true)
                degraded = true
                break
              } catch (err2) {
                if (combinedSignal.aborted) return
                markChainResult(target, false)
                debugLog(`[chatCompletionStream:degrade] ${target.name} 也失败，继续链上下一级`)
                if (deliveredAnyChunk) break
              }
            }
            if (degraded) return
            recordFailure()
            callbacks.onError(new Error(`${ALL_CHANNELS_DOWN}｜${reason}`))
            return
          }
          recordFailure()
          callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()

    return { cancel }
  }

  const gatewayAdapter: ModelGatewayAdapter = {
    // B-10：透传 signal 到 chatCompletion，供网关调用方超时/终止取消底层请求
    // #2 收尾：透传 traceId 到 routingOptions，网关路径记账归因不再依赖模块全局
    async chatCompletion(messages, options) { const r = await chatCompletion(messages as ChatMessage[], true, undefined, undefined, options?.signal, options?.traceId ? { traceId: options.traceId } : undefined); return r.content },
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
      if (!available) {
        // A5-11：明文落盘必须显式警告，不再静默回退
        plaintextKeyWarning.value = true
        debugLog('[apiStore] ⚠️ safeStorage 不可用，API key 将以明文保存到本地存储')
        return key
      }
      const encrypted = await window.electronAPI.safeStorageEncrypt(key)
      if (!encrypted) {
        plaintextKeyWarning.value = true
        debugLog('[apiStore] ⚠️ safeStorage 加密返回空，API key 将以明文保存到本地存储')
        return key
      }
      plaintextKeyWarning.value = false
      return `enc:${encrypted}`
    } catch {
      plaintextKeyWarning.value = true
      debugLog('[apiStore] ⚠️ safeStorage 加密异常，API key 将以明文保存到本地存储')
      return key
    }
  }

  async function decryptApiKey(stored: string): Promise<string> {
    if (!stored || !stored.startsWith('enc:')) return stored
    try {
      const encrypted = stored.substring(4)
      const decrypted = await window.electronAPI.safeStorageDecrypt(encrypted)
      if (decrypted) return decrypted
      // A5-11：解密失败不再把密文当 key 回传（否则 enc:... 会被当作 Bearer 发出），按未配置处理
      debugLog('[apiStore] ⚠️ API key 解密返回空，按未配置处理，请重新录入 API key')
      return ''
    } catch {
      debugLog('[apiStore] ⚠️ API key 解密失败，按未配置处理，请重新录入 API key')
      return ''
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
    plaintextKeyWarning,
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
