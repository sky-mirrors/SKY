import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useApiStore } from '@/stores/apiStore'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

function mockWindow() {
  const api = {
    storeRead: vi.fn().mockResolvedValue(null),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    safeStorageEncrypt: vi.fn().mockResolvedValue(null),
    safeStorageDecrypt: vi.fn().mockResolvedValue(null),
    safeStorageIsAvailable: vi.fn().mockResolvedValue(false),
    llmChatCompletion: vi.fn().mockResolvedValue({
      content: 'mock response', toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
    }),
    llmChatCompletionStream: vi.fn().mockImplementation(
      (_payload: unknown, cbs: { onChunk: (c: unknown) => void; onDone: (f: unknown) => void; onError: (e: string) => void }) => {
        Promise.resolve().then(() => {
          cbs.onDone({
            content: 'streamed response', toolCalls: [],
            usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12, cacheHitTokens: 0, cacheMissTokens: 5 }
          })
        })
        return () => {}
      }
    ),
    llmListModels: vi.fn().mockResolvedValue([])
  }
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

describe('apiStore', () => {
  let electronApi: ReturnType<typeof mockWindow>

  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
    electronApi = mockWindow()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('circuit breaker', () => {
    it('starts with circuit breaker closed', () => {
      const store = useApiStore()
      expect(store.isCircuitOpen).toBe(false)
      expect(store.circuitBreaker.isOpen).toBe(false)
      expect(store.circuitBreaker.failureCount).toBe(0)
    })

    it('recordFailure increments failure count', () => {
      const store = useApiStore()
      store.recordFailure()
      expect(store.circuitBreaker.failureCount).toBe(1)
    })

    it('recordSuccess resets failure count', () => {
      const store = useApiStore()
      store.recordFailure()
      store.recordFailure()
      store.recordSuccess()
      expect(store.circuitBreaker.failureCount).toBe(0)
      expect(store.circuitBreaker.isOpen).toBe(false)
    })

    it('circuit opens after 3 consecutive failures', () => {
      const store = useApiStore()
      store.recordFailure()
      store.recordFailure()
      store.recordFailure()
      expect(store.circuitBreaker.isOpen).toBe(true)
      expect(store.isCircuitOpen).toBe(true)
    })

    it('canMakeRequest returns false when circuit is open', () => {
      const store = useApiStore()
      store.recordFailure()
      store.recordFailure()
      store.recordFailure()
      expect(store.canMakeRequest()).toBe(false)
    })

    it('canMakeRequest returns true when circuit is closed', () => {
      const store = useApiStore()
      expect(store.canMakeRequest()).toBe(true)
    })

    it('resetCircuitBreaker reopens the circuit', () => {
      const store = useApiStore()
      store.recordFailure()
      store.recordFailure()
      store.recordFailure()
      expect(store.isCircuitOpen).toBe(true)
      store.resetCircuitBreaker()
      expect(store.isCircuitOpen).toBe(false)
      expect(store.circuitBreaker.failureCount).toBe(0)
    })
  })

  describe('config management', () => {
    it('isConfigured returns false with no base URL', () => {
      const store = useApiStore()
      expect(store.isConfigured).toBe(false)
    })

    it('hasActiveModel returns false with no active model', () => {
      const store = useApiStore()
      expect(store.hasActiveModel).toBe(false)
    })

    it('isReady returns false when not configured', () => {
      const store = useApiStore()
      expect(store.isReady).toBe(false)
    })

    it('setBaseUrl updates the URL', () => {
      const store = useApiStore()
      store.setBaseUrl('http://localhost:8080')
      expect(store.config.baseUrl).toBe('http://localhost:8080')
    })

    it('setActiveModel updates the model', () => {
      const store = useApiStore()
      store.setActiveModel('gpt-4')
      expect(store.config.activeModel).toBe('gpt-4')
    })

    it('setReachable updates reachability', () => {
      const store = useApiStore()
      store.setReachable(true)
      expect(store.config.isReachable).toBe(true)
    })

    it('addProvider adds a new provider', () => {
      const store = useApiStore()
      const id = store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      expect(store.config.providers.length).toBe(1)
    })

    it('removeProvider removes a provider', () => {
      const store = useApiStore()
      const id = store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.removeProvider(id)
      expect(store.config.providers.length).toBe(0)
    })

    it('switchProvider sets active provider', () => {
      const store = useApiStore()
      const id = store.addProvider({ id: 'prov-1', name: 'P1', baseUrl: 'http://p1', authType: 'none' })
      store.switchProvider(id)
      expect(store.config.activeProviderId).toBe(id)
    })
  })

  describe('detectDomain', () => {
    it('detects finance domain', () => {
      const store = useApiStore()
      const domain = store.detectDomain([{ role: 'user', content: '帮我分析这份财务报表' }])
      expect(domain).toBe('finance')
    })

    it('detects legal domain', () => {
      const store = useApiStore()
      const domain = store.detectDomain([{ role: 'user', content: '请审查这份合同条款' }])
      expect(domain).toBe('legal')
    })

    it('defaults to general domain', () => {
      const store = useApiStore()
      const domain = store.detectDomain([{ role: 'user', content: '帮我写一封邮件' }])
      expect(domain).toBe('general')
    })
  })

  describe('#5 benchmark 流量隔离', () => {
    it('benchmark 调用不发射 record-cost、不写 routingHistory；普通调用两者均记录', async () => {
      const { globalBus } = await import('@/kernel/bus')
      const { getRoutingHistory, clearRoutingHistory } = await import('@/services/smartRouter')
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })

      const costs: unknown[] = []
      const handler = (e: unknown) => costs.push(e)
      globalBus.on('debug:record-cost', handler)
      clearRoutingHistory()

      // 6 条消息绕过语义缓存资格路径（generateVector 在测试环境不可用会挂起）
      const benchMsgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `benchmark probe ${i}` }))
      await store.chatCompletion(
        benchMsgs,
        false, undefined, undefined, undefined,
        { taskType: 'benchmark', callerId: 'benchmark_standard' }
      )
      expect(costs).toHaveLength(0)
      expect(getRoutingHistory()).toHaveLength(0)

      const normalMsgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `normal probe ${i}` }))
      await store.chatCompletion(
        normalMsgs,
        false, undefined, undefined, undefined,
        { taskType: 'chat' }
      )
      expect(costs.length).toBeGreaterThan(0)
      expect(getRoutingHistory().length).toBeGreaterThan(0)

      globalBus.off('debug:record-cost', handler)
      clearRoutingHistory()
    })
  })

  describe('#2/#4/#5 流式路径记账与隔离', () => {
    it('流式成功发射 record-cost 并携带 routingOptions.traceId；benchmark 流量不发射', async () => {
      const { globalBus } = await import('@/kernel/bus')
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')

      const costs: Record<string, unknown>[] = []
      const handler = (e: Record<string, unknown>) => costs.push(e)
      globalBus.on('debug:record-cost', handler)

      // 6 条消息绕过语义缓存资格路径（generateVector 在测试环境不可用会挂起）
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `stream probe ${i}` }))
      const done = new Promise<void>((resolve, reject) => {
        store.chatCompletionStream(
          msgs,
          { onChunk: () => {}, onDone: () => resolve(), onError: (e) => reject(e) },
          undefined, undefined, undefined,
          { taskType: 'chat', traceId: 'trace-abc-123' }
        ).catch(reject)
      })
      await done
      expect(costs.length).toBe(1)
      expect(costs[0].traceId).toBe('trace-abc-123')
      expect(costs[0].category).toBe('llm')

      await store.chatCompletionStream(
        msgs,
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        undefined, undefined, undefined,
        { taskType: 'benchmark' }
      )
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(costs.length).toBe(1)

      globalBus.off('debug:record-cost', handler)
    })
  })

  describe('H-1 诚实账本批（G-2/G-4/G-5/G-8）', () => {
    async function setupReadyStore() {
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      return store
    }

    it('G-2: routingOptions.temperature 经 IPC 透传；未传时 ipcArgs 无 temperature（冷启动等价现状）', async () => {
      const store = await setupReadyStore()
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `temp probe ${i}` }))
      await store.chatCompletion(msgs, false, undefined, undefined, undefined, { taskType: 'chat', temperature: 0.3 })
      let ipcOpts = electronApi.llmChatCompletion.mock.calls[0][0] as Record<string, unknown>
      expect(ipcOpts.temperature).toBe(0.3)

      await store.chatCompletion(msgs, false, undefined, undefined, undefined, { taskType: 'chat' })
      ipcOpts = electronApi.llmChatCompletion.mock.calls[1][0] as Record<string, unknown>
      expect(ipcOpts.temperature).toBeUndefined()
    })

    it('G-5: recordOutcome actualCost 按实际 usage 计价，非 budgetResult.estimatedCost；qualityScore 为显式占位 0（G-4）', async () => {
      const { getRoutingHistory, clearRoutingHistory } = await import('@/services/smartRouter')
      const { calculateCost } = await import('@/services/tokenPricing')
      const store = await setupReadyStore()
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cacheHitTokens: 0, cacheMissTokens: 1000 }
      })
      clearRoutingHistory()
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `cost probe ${i}` }))
      await store.chatCompletion(msgs, false, undefined, undefined, undefined, { taskType: 'chat' })

      const history = getRoutingHistory()
      expect(history).toHaveLength(1)
      const expected = calculateCost(1000, 500, 0).totalCost
      expect(history[0].actualCost).toBe(expected)
      // G-4：不再编造 overkill?5:3 的质量分；0=未评测占位
      expect(history[0].qualityScore).toBe(0)
      clearRoutingHistory()
    })

    it('G-5: cacheHitTokens 真实值经 record-cost 透传（原硬编码 0）', async () => {
      const { globalBus } = await import('@/kernel/bus')
      const store = await setupReadyStore()
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cacheHitTokens: 400, cacheMissTokens: 600 }
      })
      const costs: Record<string, unknown>[] = []
      const handler = (e: Record<string, unknown>) => costs.push(e)
      globalBus.on('debug:record-cost', handler)
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `cache probe ${i}` }))
      await store.chatCompletion(msgs, false, undefined, undefined, undefined, { taskType: 'chat' })
      globalBus.off('debug:record-cost', handler)
      expect(costs.length).toBe(1)
      expect(costs[0].cacheHitTokens).toBe(400)
    })

    it('G-8: 非流式主路径 routingOptions.traceId 贯穿 record-cost 归因', async () => {
      const { globalBus } = await import('@/kernel/bus')
      const store = await setupReadyStore()
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })
      const costs: Record<string, unknown>[] = []
      const handler = (e: Record<string, unknown>) => costs.push(e)
      globalBus.on('debug:record-cost', handler)
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `trace probe ${i}` }))
      await store.chatCompletion(msgs, false, undefined, undefined, undefined, { taskType: 'chat', traceId: 'trace-main-001' })
      globalBus.off('debug:record-cost', handler)
      expect(costs.length).toBe(1)
      expect(costs[0].traceId).toBe('trace-main-001')
    })
  })

  describe('EXAM-1 exam 流量隔离（学习回路隔离 / 记账保留）', () => {
    it('exam taskType：record-cost 照常发射（监考归因），routingHistory 不记录（学习隔离）', async () => {
      const { globalBus } = await import('@/kernel/bus')
      const { getRoutingHistory, clearRoutingHistory } = await import('@/services/smartRouter')
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })

      const costs: Record<string, unknown>[] = []
      const handler = (e: Record<string, unknown>) => costs.push(e)
      globalBus.on('debug:record-cost', handler)
      clearRoutingHistory()

      // 6 条消息绕过语义缓存资格路径（generateVector 在测试环境不可用会挂起）
      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `exam probe ${i}` }))
      await store.chatCompletion(
        msgs,
        false, undefined, undefined, undefined,
        { taskType: 'exam', traceId: 'trace-exam-001' }
      )
      // 与 benchmark 相反：exam 记账保留（监考按 traceId 归因 token/费用）
      expect(costs.length).toBe(1)
      expect(costs[0].traceId).toBe('trace-exam-001')
      // 学习回路与 benchmark 同口径隔离
      expect(getRoutingHistory()).toHaveLength(0)

      globalBus.off('debug:record-cost', handler)
      clearRoutingHistory()
    })

    it('注册 exam traceId（无显式 taskType，主路径形态）：同样隔离学习回路、保留记账', async () => {
      const { registerExamTrace, clearExamTraces } = await import('@/exam/examRegistry')
      const { globalBus } = await import('@/kernel/bus')
      const { getRoutingHistory, clearRoutingHistory } = await import('@/services/smartRouter')
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })

      const costs: Record<string, unknown>[] = []
      const handler = (e: Record<string, unknown>) => costs.push(e)
      globalBus.on('debug:record-cost', handler)
      clearRoutingHistory()
      registerExamTrace('trace-exam-002')

      const examMsgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `registry exam probe ${i}` }))
      await store.chatCompletion(
        examMsgs,
        false, undefined, undefined, undefined,
        { traceId: 'trace-exam-002' }
      )
      expect(costs.length).toBe(1)
      expect(getRoutingHistory()).toHaveLength(0)

      // 对照：未注册的普通 traceId → 两者均记录（生产行为不变）
      const normalMsgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `registry normal probe ${i}` }))
      await store.chatCompletion(
        normalMsgs,
        false, undefined, undefined, undefined,
        { traceId: 'trace-normal-002' }
      )
      expect(costs.length).toBe(2)
      expect(getRoutingHistory().length).toBeGreaterThan(0)

      clearExamTraces()
      globalBus.off('debug:record-cost', handler)
      clearRoutingHistory()
    })

    it('G-17：流式 benchmark 流量不写 routingHistory（原流式两处 recordOutcome 无隔离守卫）', async () => {
      const { getRoutingHistory, clearRoutingHistory } = await import('@/services/smartRouter')
      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      clearRoutingHistory()

      const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `g17 stream probe ${i}` }))
      await store.chatCompletionStream(
        msgs,
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        undefined, undefined, undefined,
        { taskType: 'benchmark' }
      )
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(getRoutingHistory()).toHaveLength(0)

      // 对照：普通流式调用仍记录（生产学习行为不变）
      await store.chatCompletionStream(
        msgs,
        { onChunk: () => {}, onDone: () => {}, onError: () => {} },
        undefined, undefined, undefined,
        { taskType: 'chat' }
      )
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(getRoutingHistory().length).toBeGreaterThan(0)
      clearRoutingHistory()
    })
  })

  describe('P0-C5 隐式偏好注入（F-1）', () => {
    it('chat/llm_generate/未标注任务注入 [用户偏好] system 前缀；classify/exam/结构化输出跳过', async () => {
      const { vault } = await import('@/vault')
      vault.clearCache()
      const { useMemoryStore } = await import('@/stores/memoryStore')
      const { registerExamTrace, clearExamTraces } = await import('@/exam/examRegistry')
      const memoryStore = useMemoryStore()
      memoryStore.setPreference('style', '输出要简洁')

      const store = useApiStore()
      store.addProvider({ id: 'test-provider', name: 'Test', baseUrl: 'http://test', authType: 'none' })
      store.setReachable(true)
      store.setActiveModel('test-model')
      electronApi.llmChatCompletion.mockResolvedValue({
        success: true, content: 'mock response', toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })

      const msgs = () => Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `c5 probe ${i}` }))
      const lastPayload = () => electronApi.llmChatCompletion.mock.calls[electronApi.llmChatCompletion.mock.calls.length - 1][0] as { messages: { role: string; content: string }[] }

      // chat：注入
      await store.chatCompletion(msgs(), false, undefined, undefined, undefined, { taskType: 'chat' })
      expect(lastPayload().messages[0].role).toBe('system')
      expect(lastPayload().messages[0].content).toContain('[用户偏好]')
      expect(lastPayload().messages[0].content).toContain('输出要简洁')
      expect(lastPayload().messages.length).toBe(7)

      // llm_generate：注入
      await store.chatCompletion(msgs(), false, undefined, undefined, undefined, { taskType: 'llm_generate' })
      expect(lastPayload().messages[0].content).toContain('[用户偏好]')

      // 未标注 taskType（主路径只带 traceId）：注入
      await store.chatCompletion(msgs(), false, undefined, undefined, undefined, { traceId: 'trace-c5-main' })
      expect(lastPayload().messages[0].content).toContain('[用户偏好]')

      // classify：跳过
      await store.chatCompletion(msgs(), false, undefined, undefined, undefined, { taskType: 'classify' })
      expect(lastPayload().messages[0].role).toBe('user')

      // exam（经 traceId 反查）：跳过
      registerExamTrace('trace-c5-exam')
      await store.chatCompletion(msgs(), false, undefined, undefined, undefined, { traceId: 'trace-c5-exam' })
      expect(lastPayload().messages[0].role).toBe('user')
      clearExamTraces()

      // 结构化输出任务（提示词含"只输出JSON"）：跳过
      const jsonMsgs = [{ role: 'system', content: '你是编译器，只输出JSON' }, ...msgs().slice(0, 5)]
      await store.chatCompletion(jsonMsgs, false, undefined, undefined, undefined, { taskType: 'chat' })
      expect(lastPayload().messages[0].content).toBe('你是编译器，只输出JSON')
      expect(lastPayload().messages.some(m => m.content.includes('[用户偏好]'))).toBe(false)

      // 防重复注入：已含 [用户偏好] 前缀不再叠加
      const dupMsgs = [{ role: 'system', content: '[用户偏好]\n- style: 输出要简洁' }, ...msgs().slice(0, 5)]
      await store.chatCompletion(dupMsgs, false, undefined, undefined, undefined, { taskType: 'chat' })
      expect(lastPayload().messages.filter(m => m.content.includes('[用户偏好]'))).toHaveLength(1)

      // 清理：防止 vault 内存缓存泄漏到同文件后续测试
      memoryStore.setPreference('style', '')
      vault.clearCache()
    })
  })
})
