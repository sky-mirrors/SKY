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
})
