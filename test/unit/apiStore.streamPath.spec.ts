import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useApiStore } from '@/stores/apiStore'
import { globalBus } from '@/kernel/bus'
import { clearProbeCache } from '@/services/providerChain'
import { setBudget, resetBudget, recordCost, resetSessionSpent, clearCostRecords } from '@/services/tokenBudget'

/**
 * 流式路径口径对齐（原机制快照登记项 S-1 同型 / S-5；文档已删）
 *
 * 背景：非流式路径的 S-1（角色绑定 + 大模型兜底对 Ollama 目标失效）已由 `8dea4e4`
 * 用 `resolveDirectTarget` 修复，但同一片代码的**流式**分支仍一律用
 * activeProvider/activeModel（`apiStore.ts:1134/1221/1229/1324-1327`）——快照 §426
 * 称之为"单侧修复模式"（非流式修了流式没同步）。
 *
 * 本文件钉住两件事：
 *   1) 流式两条分支（IHost 主路径 IPC / 渲染进程直连）按 tierTarget 解析目标；
 *   2) S-5：降级态（本地 Ollama，零费用）不被预算 block 拦截——与非流式同口径。
 */

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
    llmChatCompletion: vi.fn().mockResolvedValue({ success: true, content: 'unused', toolCalls: [] }),
    llmChatCompletionStream: undefined as undefined | ReturnType<typeof vi.fn>,
    llmListModels: vi.fn().mockResolvedValue([])
  }
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

/** 6 条消息绕过语义缓存（cacheEligible 要求 <=5 条） */
function sixMessages(): Array<{ role: string; content: string }> {
  return Array.from({ length: 6 }, (_, i) => ({ role: i === 0 ? 'system' : 'user', content: `msg-${i}` }))
}

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i]))
        i++
      } else {
        controller.close()
      }
    }
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
}

const OLLAMA_B_BASE = 'http://127.0.0.1:11435'
const OLLAMA_B_NDJSON = [
  '{"message":{"content":"绑定"},"done":false}\n',
  '{"message":{"content":"模型回答"},"done":false}\n',
  '{"message":{"content":""},"done":true,"prompt_eval_count":4,"eval_count":6}\n'
]

interface StreamRun {
  chunks: string[]
  done?: { content?: string }
  error?: unknown
  ipcPayloads: Array<Record<string, unknown>>
  fetchCalls: Array<{ url: string; body?: Record<string, unknown> }>
}

describe('流式路径口径对齐（S-1 同型 / S-5）', () => {
  let electronApi: ReturnType<typeof mockWindow>
  let emitSpy: ReturnType<typeof vi.spyOn>
  let requestSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
    electronApi = mockWindow()
    clearProbeCache()
    resetBudget()
    resetSessionSpent()
    clearCostRecords()
    emitSpy = vi.spyOn(globalBus, 'emit').mockImplementation(() => {})
    requestSpy = vi.spyOn(globalBus, 'request').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetBudget()
    resetSessionSpent()
    clearCostRecords()
  })

  /** 装配 store：两个云 provider + 一个本地 Ollama provider，active 指向 remote-a */
  function setupStore() {
    const store = useApiStore()
    store.addProvider({ id: 'remote-a', name: 'A', baseUrl: 'https://a.test/v1', authType: 'bearer', apiKey: 'sk-a', modelsEndpoint: '/models', chatFormat: 'openai' })
    store.addProvider({ id: 'remote-b', name: 'B', baseUrl: 'https://b.test/v1', authType: 'bearer', apiKey: 'sk-b', modelsEndpoint: '/models', chatFormat: 'openai' })
    store.addProvider({ id: 'ollama-b', name: 'Ollama(B)', baseUrl: OLLAMA_B_BASE, authType: 'none', apiKey: '', modelsEndpoint: '/api/tags', chatFormat: 'ollama' })
    // addProvider 之后 models 恒为 []，而 resolveRoleTarget/resolveDirectTarget 要求绑定模型确实存在
    store.config.providers.find(p => p.id === 'remote-a')!.models = [{ id: 'model-a', name: 'model-a' }]
    store.config.providers.find(p => p.id === 'remote-b')!.models = [{ id: 'model-b', name: 'model-b' }]
    store.config.providers.find(p => p.id === 'ollama-b')!.models = [{ id: 'model-b-local', name: 'model-b-local' }]
    store.switchProvider('remote-a')
    store.setActiveModel('model-a')
    store.setReachable(true)
    return store
  }

  /** 记录 fetch 目标（URL + JSON body），并按 URL 给出可用响应 */
  function mockFetchRecording(opts: { ipcTargets?: Response; remoteStatus?: number; ollamaBUp?: boolean } = {}) {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined
      calls.push({ url: String(url), body })
      if (String(url).endsWith('/api/chat')) return ndjsonResponse(OLLAMA_B_NDJSON)
      if (String(url).endsWith('/api/tags')) {
        if (opts.ollamaBUp === false) return new Response('down', { status: 500 })
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 })
      }
      return new Response('upstream boom', { status: opts.remoteStatus ?? 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return calls
  }

  /** 安装 IPC 流 mock（记录 payload，异步 onDone） */
  function mockIpcStream() {
    const payloads: Array<Record<string, unknown>> = []
    electronApi.llmChatCompletionStream = vi.fn((payload: Record<string, unknown>, cbs: { onDone: (f: unknown) => void }) => {
      payloads.push(payload)
      Promise.resolve().then(() => {
        cbs.onDone({ content: 'ipc-ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
      })
      return () => {}
    })
    return payloads
  }

  async function runStream(
    store: ReturnType<typeof useApiStore>,
    routingOptions?: { callerId?: string; taskType?: string }
  ): Promise<StreamRun> {
    const chunks: string[] = []
    let done: { content?: string } | undefined
    let error: unknown
    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        {
          onChunk: (c: { content: string }) => { chunks.push(c.content) },
          onDone: (f: { content: string }) => { done = f; resolve() },
          onError: (e: unknown) => { error = e; resolve() }
        },
        undefined, undefined, undefined, routingOptions
      )
      // 双保险：若实现静默返回（无回调），5s 后放行
      setTimeout(resolve, 5000)
    })
    return {
      chunks, done, error,
      ipcPayloads: [],
      fetchCalls: []
    }
  }

  it('S-1 同型｜IPC 主路径：aux 绑定到 remote-b 时，流式请求打到绑定目标而非 activeModel', async () => {
    mockFetchRecording()
    const payloads = mockIpcStream()
    const store = setupStore()
    store.config.roleModels = { aux: { providerId: 'remote-b', model: 'model-b' } }

    const run = await runStream(store, { callerId: 'l0SkillRouter' })

    expect(run.error).toBeUndefined()
    expect(payloads).toHaveLength(1)
    expect(payloads[0].providerId).toBe('remote-b')
    expect(payloads[0].model).toBe('model-b')
  })

  it('S-1 同型｜直连分支：aux 绑定到 Ollama provider 时，流打到绑定 baseUrl/model', async () => {
    const fetchCalls = mockFetchRecording({ ollamaBUp: true })
    mockIpcStream() // 即使 IPC 可用，绑定目标是 Ollama ⇒ 必须绕过 IPC 走直连
    const store = setupStore()
    store.config.roleModels = { aux: { providerId: 'ollama-b', model: 'model-b-local' } }

    const run = await runStream(store, { callerId: 'l0SkillRouter' })

    expect(run.error).toBeUndefined()
    const chatCall = fetchCalls.find(c => c.url.endsWith('/api/chat'))
    expect(chatCall).toBeTruthy()
    expect(chatCall!.url.startsWith(OLLAMA_B_BASE)).toBe(true)
    expect(chatCall!.body?.model).toBe('model-b-local')
    expect(run.done?.content).toContain('模型回答')
  })

  it('S-1 守卫｜未配置角色绑定时，流式请求仍打 active 目标（老配置零迁移）', async () => {
    mockFetchRecording()
    const payloads = mockIpcStream()
    const store = setupStore()

    const run = await runStream(store, { callerId: 'l0SkillRouter' })

    expect(run.error).toBeUndefined()
    expect(payloads).toHaveLength(1)
    expect(payloads[0].providerId).toBe('remote-a')
    expect(payloads[0].model).toBe('model-a')
  })

  it('S-5｜已选定降级态（本地 Ollama）时，流式请求不被预算 block 拦截（与非流式同口径）', async () => {
    setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'block' })
    recordCost({ tier: 'pro', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, inputCost: 0, outputCost: 0, cacheSaving: 0, totalCost: 1, category: 'test' })
    mockFetchRecording({ ollamaBUp: true })
    const store = setupStore()
    store.setReachable(false) // 远程不可达 ⇒ 进入降级态（目标是本地 Ollama，零费用）

    const run = await runStream(store)

    expect(String(run.error ?? '')).not.toContain('Budget exceeded')
    expect(run.done?.content).toContain('模型回答')
  })

  it('S-5 守卫｜非降级态的流式请求仍被预算 block 拦截（豁免不得放宽到全路径）', async () => {
    setBudget({ sessionBudgetCny: 0.001, overBudgetStrategy: 'block' })
    recordCost({ tier: 'pro', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, inputCost: 0, outputCost: 0, cacheSaving: 0, totalCost: 1, category: 'test' })
    mockFetchRecording()
    mockIpcStream()
    const store = setupStore() // 远程可达 ⇒ 非降级态

    const run = await runStream(store)

    expect(String(run.error ?? '')).toContain('Budget exceeded')
    expect(requestSpy).not.toHaveBeenCalledWith('notification:add', expect.anything())
  })
})
