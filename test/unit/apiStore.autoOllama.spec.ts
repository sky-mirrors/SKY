/**
 * 本地 Ollama 自动发现 —— TDD 探针（先红后绿）
 *
 * 背景：docs/95 §8 记录的实现偏差 —— README 承诺「无密钥时回退到确定性规则层」，
 * 但 `src/stores/dialogStore.ts:1719-1733` 的门禁位于路由**之前**：未配置模型网关时
 * `sendMessage` 直接 `return ''`，L0/L0.5/L1/L2 全部不可达。本机虽常驻 Ollama
 * （`127.0.0.1:11434`，由 `providerChain.ts:9` 的隐式端点兜底）却因门禁在降级链之前而未生效。
 *
 * 采定方向：应用在**未配置任何 provider 时**自动发现本地 Ollama，使 isReady 为真、
 * 门禁自然放行，规则层与 LLM 层都恢复可用。
 *
 * 不可违背的约束：
 *   1. **绝不覆盖用户已有配置**（已配置时连探测都不该发生）
 *   2. 探测失败/异常必须静默，不得打断启动
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const probeMock = vi.hoisted(() => vi.fn())

vi.mock('@/services/ollamaProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ollamaProvider')>()
  return { ...actual, probeOllama: probeMock }
})

import { createPinia, setActivePinia } from 'pinia'
import { useApiStore } from '@/stores/apiStore'

function mockWindow() {
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      storeRead: vi.fn().mockResolvedValue(null),
      storeWrite: vi.fn().mockResolvedValue(undefined),
      safeStorageEncrypt: vi.fn().mockResolvedValue(null),
      safeStorageDecrypt: vi.fn().mockResolvedValue(null),
      safeStorageIsAvailable: vi.fn().mockResolvedValue(false),
    },
  }
}

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  })
}

describe('本地 Ollama 自动发现', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockWindow()
    mockLocalStorage()
    probeMock.mockReset()
  })

  it('未配置任何 provider 且本地 Ollama 可达 → 自动接入、置为 active、isReady 变真', async () => {
    probeMock.mockResolvedValue({ ok: true, models: [{ id: 'qwen2.5:3b', name: 'qwen2.5:3b' }] })
    const store = useApiStore()
    expect(store.isReady).toBe(false)

    const changed = await store.autoDiscoverLocalOllama()

    expect(changed).toBe(true)
    expect(probeMock).toHaveBeenCalledTimes(1)
    expect(store.config.providers.length).toBe(1)
    expect(store.config.activeProviderId).toBeTruthy()
    expect(store.config.activeModel).toBe('qwen2.5:3b')
    expect(store.isReady).toBe(true)
  })

  it('已配置 provider 时不探测、不改动（绝不覆盖用户配置）', async () => {
    const store = useApiStore()
    store.addProvider({
      id: 'mine',
      name: '我的网关',
      baseUrl: 'https://example.com',
      authType: 'bearer',
      apiKey: 'k',
      modelsEndpoint: '/v1/models',
      chatFormat: 'openai',
    })
    const pidBefore = store.config.activeProviderId
    const nBefore = store.config.providers.length

    const changed = await store.autoDiscoverLocalOllama()

    expect(changed).toBe(false)
    expect(probeMock).not.toHaveBeenCalled()
    expect(store.config.providers.length).toBe(nBefore)
    expect(store.config.activeProviderId).toBe(pidBefore)
    expect(store.config.providers[0].id).toBe('mine')
  })

  it('探测失败或无模型 → 静默返回 false，状态不变', async () => {
    probeMock.mockResolvedValue({ ok: false, models: [] })
    const store = useApiStore()

    const changed = await store.autoDiscoverLocalOllama()

    expect(changed).toBe(false)
    expect(store.config.providers.length).toBe(0)
    expect(store.isReady).toBe(false)
  })

  it('探测抛异常 → 不向上抛，状态不变', async () => {
    probeMock.mockRejectedValue(new Error('probe boom'))
    const store = useApiStore()

    await expect(store.autoDiscoverLocalOllama()).resolves.toBe(false)
    expect(store.config.providers.length).toBe(0)
  })
})
