import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * S-7（快照 §S-7，P3）：`tierTimer` 从不 dispose。
 *
 * 事实锚点（本轮独立复核）：
 *   - src\stores\apiStore.ts:817（非流式直连分支）与 :1149（流式）各建一个
 *     `timeoutSignalWithReason(...)` 计时器，全函数无一处 `dispose()`；
 *   - src\services\llmTimeouts.ts:38-44 的返回值自述「dispose 在请求完成后调用可清理
 *     挂起的计时器」——即契约一直在，只是没人消费。
 *
 * 后果：每次 LLM 调用都把一个最长 300s 的挂起 setTimeout 留给运行时（高频对话下
 * 计时器句柄堆积）。本文件用模块级 spy 钉住 dispose 确实被调用。
 */

const disposeLog = vi.hoisted(() => ({ count: 0, labels: [] as string[] }))

vi.mock('@/services/llmTimeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/llmTimeouts')>()
  return {
    ...actual,
    timeoutSignalWithReason: (ms: number, label: string) => {
      const inner = actual.timeoutSignalWithReason(ms, label)
      return {
        signal: inner.signal,
        dispose: () => {
          disposeLog.count++
          disposeLog.labels.push(label)
          inner.dispose()
        },
      }
    },
  }
})

import { createPinia, setActivePinia } from 'pinia'
import { useApiStore } from '@/stores/apiStore'
import { globalBus } from '@/kernel/bus'
import { clearProbeCache } from '@/services/providerChain'
import { resetBudget, resetSessionSpent, clearCostRecords } from '@/services/tokenBudget'

interface MockApi {
  storeRead: ReturnType<typeof vi.fn>
  storeWrite: ReturnType<typeof vi.fn>
  safeStorageEncrypt: ReturnType<typeof vi.fn>
  safeStorageDecrypt: ReturnType<typeof vi.fn>
  safeStorageIsAvailable: ReturnType<typeof vi.fn>
  llmChatCompletion: ReturnType<typeof vi.fn> | undefined
  llmChatCompletionStream: ReturnType<typeof vi.fn> | undefined
  llmListModels: ReturnType<typeof vi.fn>
}

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  })
  return store
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
    llmListModels: vi.fn().mockResolvedValue([]),
  }
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

/** 6 条消息绕过语义缓存（cacheEligible 要求 <=5 条） */
function sixMessages(): Array<{ role: string; content: string }> {
  return Array.from({ length: 6 }, (_, i) => ({ role: i === 0 ? 'system' : 'user', content: `msg-${i}` }))
}

describe('S-7：LLM 超时计时器显式释放（tierTimer.dispose）', () => {
  let electronApi: MockApi
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
    disposeLog.count = 0
    disposeLog.labels.length = 0
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

  function setupRemoteStore() {
    const store = useApiStore()
    store.addProvider({
      id: 'remote-1', name: 'RemoteAPI', baseUrl: 'https://api.remote.test/v1',
      authType: 'bearer', apiKey: 'sk-test', modelsEndpoint: '/models', chatFormat: 'openai',
    })
    store.setReachable(true)
    store.setActiveModel('remote-model')
    return store
  }

  it('非流式直连：请求完成后释放计时器（label 含 LLM non-stream）', async () => {
    electronApi.llmChatCompletion = undefined // 强制走渲染进程直连分支（该分支才建计时器）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '这是一段足够长的回答内容，用来避免命中不可解检测分支。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const store = setupRemoteStore()

    const r = await store.chatCompletion(sixMessages() as never, false)

    expect(r.content).toContain('足够长')
    expect(disposeLog.labels.some(l => l.includes('LLM non-stream'))).toBe(true)
  })

  it('流式 IPC：流结束后释放计时器（label 含 LLM stream）', async () => {
    electronApi.llmChatCompletionStream = vi.fn((_payload: unknown, cbs: { onDone: (f: unknown) => void }) => {
      Promise.resolve().then(() => {
        cbs.onDone({ content: 'ipc-ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
      })
      return () => {}
    })
    const store = setupRemoteStore()

    await new Promise<void>((resolve) => {
      store.chatCompletionStream(
        sixMessages() as never,
        { onChunk: () => {}, onDone: () => resolve(), onError: () => resolve() }
      )
      setTimeout(resolve, 3000)
    })

    expect(disposeLog.labels.some(l => l.includes('LLM stream'))).toBe(true)
  })

  it('守卫：未发起请求（API not ready）时不建计时器、也无从 dispose', async () => {
    const store = useApiStore() // 未配置任何 provider
    await expect(store.chatCompletion(sixMessages() as never, false)).rejects.toThrow()
    expect(disposeLog.count).toBe(0)
  })
})
