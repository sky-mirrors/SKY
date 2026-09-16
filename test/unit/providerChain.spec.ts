import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildProviderChain,
  isRetryableProviderError,
  probeChainTarget,
  markChainResult,
  pickOllamaModel,
  emitDegraded,
  clearProbeCache,
  IMPLICIT_OLLAMA_PROVIDER_ID,
  PROBE_TTL_FAIL_MS,
  PROBE_TTL_OK_MS,
  DegradeBus,
  DegradeTarget
} from '@/services/providerChain'
import { ProviderConfig, ModelInfo } from '@/models'

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p1',
    name: 'P1',
    baseUrl: 'https://api.example.com/v1',
    authType: 'bearer',
    apiKey: '',
    modelsEndpoint: '/models',
    chatFormat: 'openai',
    models: [],
    isReachable: true,
    lastCheckedAt: 0,
    ...overrides
  }
}

describe('M20 buildProviderChain', () => {
  it('构建序：active → 其余 ollama → 隐式 Ollama', () => {
    const remote = makeProvider({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' })
    const ollamaA = makeProvider({ id: 'o1', name: 'Ollama A', baseUrl: 'http://127.0.0.1:11434', chatFormat: 'ollama' })
    const ollamaB = makeProvider({ id: 'o2', name: 'Ollama B', baseUrl: 'http://192.168.1.5:11434', chatFormat: 'ollama' })
    const chain = buildProviderChain('deepseek', [remote, ollamaA, ollamaB])
    // o1 端点即默认端点 → 覆盖隐式，不再追加 implicit-ollama
    expect(chain.map(t => t.providerId)).toEqual(['deepseek', 'o1', 'o2'])
  })

  it('baseUrl 去重：显式 ollama 覆盖默认端点则不追加隐式', () => {
    const remote = makeProvider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })
    const ollamaA = makeProvider({ id: 'o1', baseUrl: 'http://127.0.0.1:11434/', chatFormat: 'ollama' })
    const chain = buildProviderChain('deepseek', [remote, ollamaA])
    expect(chain.map(t => t.providerId)).toEqual(['deepseek', 'o1'])
  })

  it('无 active / 无 providers 时仅剩隐式 Ollama', () => {
    expect(buildProviderChain(undefined, [])).toHaveLength(1)
    const chain = buildProviderChain(undefined, [])
    expect(chain[0].implicit).toBe(true)
    expect(chain[0].baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('active 是 ollama 时打头；不同 baseUrl 的其余 ollama 保留', () => {
    const ollamaA = makeProvider({ id: 'o1', baseUrl: 'http://127.0.0.1:11434', chatFormat: 'ollama' })
    const ollamaB = makeProvider({ id: 'o2', baseUrl: 'http://127.0.0.1:11434/v1', chatFormat: 'ollama' })
    const chain = buildProviderChain('o1', [ollamaA, ollamaB])
    expect(chain.map(t => t.providerId)).toEqual(['o1', 'o2'])
  })
})

describe('M20 isRetryableProviderError', () => {
  it('5xx / 429 / 网络 / 超时可降级', () => {
    expect(isRetryableProviderError(new Error('API error 503: unavailable'))).toBe(true)
    expect(isRetryableProviderError(new Error('Ollama API error 500: boom'))).toBe(true)
    expect(isRetryableProviderError(new Error('API error 429: rate limited'))).toBe(true)
    expect(isRetryableProviderError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableProviderError(new Error('Request timed out'))).toBe(true)
    expect(isRetryableProviderError(new DOMException('signal timed out', 'TimeoutError'))).toBe(true)
  })

  it('401/403/404 / 用户 AbortError / 未知错误不降级', () => {
    expect(isRetryableProviderError(new Error('API error 401: unauthorized'))).toBe(false)
    expect(isRetryableProviderError(new Error('API error 403: forbidden'))).toBe(false)
    expect(isRetryableProviderError(new Error('API error 404: not found'))).toBe(false)
    expect(isRetryableProviderError(new Error('API error 400: bad request'))).toBe(false)
    expect(isRetryableProviderError(new DOMException('Aborted', 'AbortError'))).toBe(false)
    expect(isRetryableProviderError(new Error('weird unknown failure'))).toBe(false)
  })
})

describe('M20 探测缓存 TTL', () => {
  beforeEach(() => {
    clearProbeCache()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const target: DegradeTarget = {
    providerId: 'o1',
    name: 'Ollama A',
    baseUrl: 'http://127.0.0.1:11434',
    chatFormat: 'ollama',
    implicit: false,
    models: []
  }

  it('成功缓存 300s 内不重复探测', async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), { status: 200 }))
    const t0 = 1_000_000
    const r1 = await probeChainTarget(target, t0)
    expect(r1.ok).toBe(true)
    const r2 = await probeChainTarget(target, t0 + PROBE_TTL_OK_MS - 1)
    expect(r2.ok).toBe(true)
    expect(mock).toHaveBeenCalledTimes(1)
    await probeChainTarget(target, t0 + PROBE_TTL_OK_MS + 1)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('失败缓存 60s 短路', async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>
    mock.mockRejectedValue(new TypeError('fetch failed'))
    const t0 = 1_000_000
    const r1 = await probeChainTarget(target, t0)
    expect(r1.ok).toBe(false)
    await probeChainTarget(target, t0 + PROBE_TTL_FAIL_MS - 1)
    expect(mock).toHaveBeenCalledTimes(1)
    await probeChainTarget(target, t0 + PROBE_TTL_FAIL_MS + 1)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('markChainResult 回写缓存（成功延寿/失败短路）', async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), { status: 200 }))
    const t0 = 1_000_000
    await probeChainTarget(target, t0)
    markChainResult(target, false, t0 + 10)
    const r = await probeChainTarget(target, t0 + 20)
    expect(r.ok).toBe(false)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('pickOllamaModel：目标清单优先，探测兜底', () => {
    const models: ModelInfo[] = [{ id: 'qwen2.5:7b', name: 'qwen2.5:7b' }]
    const probe = { ok: true, models: [{ id: 'llama3.2', name: 'llama3.2' }] }
    expect(pickOllamaModel(target, { ok: true, models })).toBe('qwen2.5:7b')
    expect(pickOllamaModel({ ...target, models }, probe)).toBe('qwen2.5:7b')
    expect(pickOllamaModel(target, probe)).toBe('llama3.2')
    expect(pickOllamaModel(target, { ok: true, models: [] })).toBe('')
  })
})

describe('M20 emitDegraded', () => {
  it('emit llm-degraded + request notification:add(api_degrade)', () => {
    const emit = vi.fn()
    const request = vi.fn()
    const bus: DegradeBus = { emit, request }
    const to: DegradeTarget = {
      providerId: IMPLICIT_OLLAMA_PROVIDER_ID,
      name: 'Ollama(隐式)',
      baseUrl: 'http://127.0.0.1:11434',
      chatFormat: 'ollama',
      implicit: true,
      models: []
    }
    emitDegraded(bus, { providerId: 'deepseek', name: 'DeepSeek' }, to, 'API error 503')
    expect(emit).toHaveBeenCalledWith('llm-degraded', expect.objectContaining({
      fromProviderId: 'deepseek',
      toProviderId: IMPLICIT_OLLAMA_PROVIDER_ID,
      reason: 'API error 503'
    }))
    expect(request).toHaveBeenCalledWith('notification:add', expect.objectContaining({
      type: 'api_degrade',
      title: 'LLM 通道降级'
    }))
  })
})
