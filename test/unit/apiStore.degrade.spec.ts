import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useApiStore } from '@/stores/apiStore'
import { globalBus } from '@/kernel/bus'
import { clearProbeCache } from '@/services/providerChain'

// M20 降级链集成测试：mock IPC/fetch，验证 5xx 透明回退、链尽、401 不降、流式首 chunk 前降级

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

interface MockApi {
  storeRead: ReturnType<typeof vi.fn>
  storeWrite: ReturnType<typeof vi.fn>
  safeStorageEncrypt: ReturnType<typeof vi.fn>
  safeStorageDecrypt: ReturnType<typeof vi.fn>
  safeStorageIsAvailable: ReturnType<typeof vi.fn>
  llmChatCompletion: ReturnType<typeof vi.fn>
  llmChatCompletionStream?: ReturnType<typeof vi.fn>
  llmListModels: ReturnType<typeof vi.fn>
}

function mockWindow(): MockApi {
  const api: MockApi = {
    storeRead: vi.fn().mockResolvedValue(null),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    safeStorageEncrypt: vi.fn().mockResolvedValue(null),
    safeStorageDecrypt: vi.fn().mockResolvedValue(null),
    safeStorageIsAvailable: vi.fn().mockResolvedValue(false),
    llmChatCompletion: vi.fn().mockResolvedValue({ success: true, content: 'unused', toolCalls: [] }),
    llmChatCompletionStream: vi.fn(),
    llmListModels: vi.fn().mockResolvedValue([])
  }
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

/** 6 条消息绕过语义缓存（cacheEligible 要求 <=5 条，避免 IDB/向量路径） */
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

/**
 * fetch mock：按 URL 分发
 * - /api/tags → Ollama 模型清单（ollamaUp 控制可用性）
 * - /api/chat → Ollama 单 JSON 或 NDJSON（streamMode）
 * - 其余（远程端点）→ remoteStatus
 */
function mockFetch(opts: { ollamaUp: boolean; remoteStatus: number; streamMode?: boolean }) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/tags')) {
      if (!opts.ollamaUp) return new Response('down', { status: 500 })
      return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 })
    }
    if (url.endsWith('/api/chat')) {
      if (opts.streamMode) {
        return ndjsonResponse([
          '{"message":{"content":"本地"},"done":false}\n',
          '{"message":{"content":"流式回答"},"done":false}\n',
          '{"message":{"content":""},"done":true,"prompt_eval_count":4,"eval_count":6}\n'
        ])
      }
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: '本地降级回答' }, prompt_eval_count: 3, eval_count: 5, done: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response('upstream boom', { status: opts.remoteStatus })
  })
}

describe('M20 apiStore 降级链', () => {
  let electronApi: MockApi
  let emitSpy: ReturnType<typeof vi.spyOn>
  let requestSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
    electronApi = mockWindow()
    clearProbeCache()
    emitSpy = vi.spyOn(globalBus, 'emit').mockImplementation(() => {})
    requestSpy = vi.spyOn(globalBus, 'request').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function setupRemoteStore() {
    const store = useApiStore()
    store.addProvider({
      id: 'remote-1', name: 'RemoteAPI', baseUrl: 'https://api.remote.test/v1',
      authType: 'bearer', apiKey: 'sk-test', modelsEndpoint: '/models', chatFormat: 'openai'
    })
    store.setReachable(true)
    store.setActiveModel('remote-model')
    return store
  }

  it('IPC 5xx 失败 → 透明降级本地 Ollama，发 llm-degraded + notification，active provider 不变', async () => {
    const fetchMock = mockFetch({ ollamaUp: true, remoteStatus: 503 })
    vi.stubGlobal('fetch', fetchMock)
    electronApi.llmChatCompletion.mockResolvedValue({ success: false, error: 'API error 503: upstream unavailable' })
    const store = setupRemoteStore()

    const r = await store.chatCompletion(sixMessages() as never, false)

    expect(r.content).toBe('本地降级回答')
    expect(r.usage?.totalTokens).toBe(8)
    expect(emitSpy).toHaveBeenCalledWith('llm-degraded', expect.objectContaining({
      fromProviderId: 'remote-1',
      toProviderId: 'implicit-ollama',
      reason: expect.stringContaining('503')
    }))
    expect(requestSpy).toHaveBeenCalledWith('notification:add', expect.objectContaining({
      type: 'api_degrade',
      title: 'LLM 通道降级'
    }))
    // per-request 降级：配置原样
    expect(store.config.activeProviderId).toBe('remote-1')
    expect(store.activeProvider?.chatFormat).toBe('openai')
    // 降级调用走渲染进程直连 /api/chat
    const chatCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/api/chat'))
    expect(chatCalls).toHaveLength(1)
    // M20/M17：本地降级记账 local=true（费用记 0，token 照记）
    const recordCost = emitSpy.mock.calls.find(c => c[0] === 'debug:record-cost')
    expect(recordCost?.[1]).toMatchObject({ promptTokens: 3, completionTokens: 5, local: true })
  })

  it('链尽（Ollama 也不可达）→ 抛统一离线错误', async () => {
    vi.stubGlobal('fetch', mockFetch({ ollamaUp: false, remoteStatus: 503 }))
    electronApi.llmChatCompletion.mockResolvedValue({ success: false, error: 'API error 503: upstream unavailable' })
    const store = setupRemoteStore()

    await expect(store.chatCompletion(sixMessages() as never, false))
      .rejects.toThrow('所有 LLM 通道均不可用：远程不可达且无本地模型（离线）')
    expect(emitSpy).not.toHaveBeenCalledWith('llm-degraded', expect.anything())
  })

  it('401 认证失败不降级，原样抛出', async () => {
    vi.stubGlobal('fetch', mockFetch({ ollamaUp: true, remoteStatus: 401 }))
    electronApi.llmChatCompletion.mockResolvedValue({ success: false, error: 'API error 401: unauthorized' })
    const store = setupRemoteStore()

    await expect(store.chatCompletion(sixMessages() as never, false)).rejects.toThrow('401')
    expect(emitSpy).not.toHaveBeenCalledWith('llm-degraded', expect.anything())
    expect(requestSpy).not.toHaveBeenCalledWith('notification:add', expect.anything())
  })

  it('熔断 open → 先试降级链，成功返回本地结果', async () => {
    vi.stubGlobal('fetch', mockFetch({ ollamaUp: true, remoteStatus: 503 }))
    const store = setupRemoteStore()
    store.recordFailure()
    store.recordFailure()
    store.recordFailure()
    expect(store.isCircuitOpen).toBe(true)

    const r = await store.chatCompletion(sixMessages() as never, false)

    expect(r.content).toBe('本地降级回答')
    expect(emitSpy).toHaveBeenCalledWith('llm-degraded', expect.objectContaining({
      reason: expect.stringContaining('circuit breaker open')
    }))
  })

  it('流式首 chunk 前远程 500 → 降级 NDJSON 流，onChunk/onDone 正常发射', async () => {
    const fetchMock = mockFetch({ ollamaUp: true, remoteStatus: 500, streamMode: true })
    vi.stubGlobal('fetch', fetchMock)
    // 禁用 IPC 流式 → 走直连 fetch 路径触发降级
    electronApi.llmChatCompletionStream = undefined
    const store = setupRemoteStore()

    const chunks: string[] = []
    let donePayload: { content?: string } | undefined
    let errorPayload: unknown
    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        {
          onChunk: (c: { content: string }) => { chunks.push(c.content) },
          onDone: (f: { content: string }) => { donePayload = f; resolve() },
          onError: (e: unknown) => { errorPayload = e; resolve() }
        }
      )
    })

    expect(errorPayload).toBeUndefined()
    expect(chunks).toEqual(['本地', '本地流式回答'])
    expect(donePayload?.content).toBe('本地流式回答')
    expect(emitSpy).toHaveBeenCalledWith('llm-degraded', expect.objectContaining({
      toProviderId: 'implicit-ollama'
    }))
  })

  // ── S-2（快照 §S-2，P1）：桌面流式主路径（IPC）失败不接降级链 ──
  // 原实现 IPC 流 onError 只有 recordFailure + callbacks.onError，无 isRetryableProviderError
  // /tryDegradeChain；同一时刻非流式与直连分支都会正常降级。M20 承诺在
  // 流式/非流式 × IPC/直连四种组合中行为不一致，用户最常踩到的恰是"桌面 + 流式"组合
  // （主对话路径）。

  it('S-2：IPC 流式主路径遇 503 → 降级本地 Ollama NDJSON 流（与直连/非流式同构）', async () => {
    const fetchMock = mockFetch({ ollamaUp: true, remoteStatus: 503, streamMode: true })
    vi.stubGlobal('fetch', fetchMock)
    electronApi.llmChatCompletionStream = vi.fn((_payload: unknown, cbs: { onError: (e: string) => void }) => {
      Promise.resolve().then(() => cbs.onError('API error 503: upstream unavailable'))
      return () => {}
    })
    const store = setupRemoteStore()

    const chunks: string[] = []
    let donePayload: { content?: string } | undefined
    let errorPayload: unknown
    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        {
          onChunk: (c: { content: string }) => { chunks.push(c.content) },
          onDone: (f: { content: string }) => { donePayload = f; resolve() },
          onError: (e: unknown) => { errorPayload = e; resolve() }
        }
      )
    })

    expect(errorPayload).toBeUndefined()
    expect(chunks).toEqual(['本地', '本地流式回答'])
    expect(donePayload?.content).toBe('本地流式回答')
    expect(emitSpy).toHaveBeenCalledWith('llm-degraded', expect.objectContaining({
      toProviderId: 'implicit-ollama',
      reason: expect.stringContaining('503')
    }))
  })

  it('S-2 守卫：IPC 已发射 chunk 后出错，不切换降级（避免调用方收到重复内容）', async () => {
    const fetchMock = mockFetch({ ollamaUp: true, remoteStatus: 503, streamMode: true })
    vi.stubGlobal('fetch', fetchMock)
    electronApi.llmChatCompletionStream = vi.fn((_payload: unknown, cbs: { onChunk: (c: { content: string; delta: string; done: boolean }) => void; onError: (e: string) => void }) => {
      Promise.resolve().then(() => {
        cbs.onChunk({ content: '半截', delta: '半截', done: false })
        cbs.onError('API error 503: mid-stream')
      })
      return () => {}
    })
    const store = setupRemoteStore()

    let errorPayload: unknown
    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        { onChunk: () => {}, onDone: () => resolve(), onError: (e: unknown) => { errorPayload = e; resolve() } }
      )
    })

    expect(String(errorPayload)).toContain('503')
    expect(emitSpy).not.toHaveBeenCalledWith('llm-degraded', expect.anything())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('S-2 守卫：IPC 401 认证失败不降级（换本地模型救不了配置错误）', async () => {
    const fetchMock = mockFetch({ ollamaUp: true, remoteStatus: 401, streamMode: true })
    vi.stubGlobal('fetch', fetchMock)
    electronApi.llmChatCompletionStream = vi.fn((_payload: unknown, cbs: { onError: (e: string) => void }) => {
      Promise.resolve().then(() => cbs.onError('API error 401: unauthorized'))
      return () => {}
    })
    const store = setupRemoteStore()

    let errorPayload: unknown
    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        { onChunk: () => {}, onDone: () => resolve(), onError: (e: unknown) => { errorPayload = e; resolve() } }
      )
    })

    expect(String(errorPayload)).toContain('401')
    expect(emitSpy).not.toHaveBeenCalledWith('llm-degraded', expect.anything())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
