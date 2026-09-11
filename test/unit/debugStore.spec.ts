import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDebugStore } from '@/stores/debugStore'

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

describe('debugStore', () => {
  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
    vi.stubGlobal('console', {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn()
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with enabled=false by default in test env', () => {
    const store = useDebugStore()
    expect(store.enabled).toBe(false)
  })

  it('emitEvent is callable', () => {
    const store = useDebugStore()
    expect(() => store.emitEvent('test-event', { data: 'test' })).not.toThrow()
  })

  it('registerAbortController and clearAbortController work', () => {
    const store = useDebugStore()
    const controller = new AbortController()
    expect(() => store.registerAbortController(controller)).not.toThrow()
    expect(() => store.clearAbortController()).not.toThrow()
  })

  it('recordProbe is callable', () => {
    const store = useDebugStore()
    expect(() => store.recordProbe({
      id: 'probe-test',
      stepNum: 0,
      manifestId: 'test-manifest',
      source: 'llm',
      sourceDetail: 'test',
      toolName: 'test-tool',
      inputSnapshot: {},
      outputSnapshot: 'output',
      timestamp: Date.now(),
      durationMs: 100
    })).not.toThrow()
  })
})
