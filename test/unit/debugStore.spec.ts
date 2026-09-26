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

  it('hasAbortable 随注册表增减变化，terminateExecution 返回实际中止数', () => {
    const store = useDebugStore()
    expect(store.hasAbortable).toBe(false)
    expect(store.abortableCount).toBe(0)

    const a = new AbortController()
    const b = new AbortController()
    store.registerAbortController(a)
    store.registerAbortController(b)
    expect(store.abortableCount).toBe(2)
    expect(store.hasAbortable).toBe(true)

    expect(store.terminateExecution()).toBe(2)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(store.abortableCount).toBe(0)
    expect(store.hasAbortable).toBe(false)
  })

  it('空注册表时 terminateExecution 返回 0（对应路由/规划阶段的静默空窗）', () => {
    const store = useDebugStore()
    expect(store.hasAbortable).toBe(false)
    expect(store.terminateExecution()).toBe(0)
    expect(store.hasAbortable).toBe(false)
  })

  it('unregisterAbortController 只摘除自身，不波及仍在册的控制器', () => {
    const store = useDebugStore()
    const a = new AbortController()
    const b = new AbortController()
    store.registerAbortController(a)
    store.registerAbortController(b)
    store.unregisterAbortController(a)
    expect(store.abortableCount).toBe(1)

    expect(store.terminateExecution()).toBe(1)
    expect(a.signal.aborted).toBe(false)
    expect(b.signal.aborted).toBe(true)
    expect(store.hasAbortable).toBe(false)
  })

  it('clearAbortController 清空注册表但不中止任何控制器', () => {
    const store = useDebugStore()
    const a = new AbortController()
    store.registerAbortController(a)
    expect(store.hasAbortable).toBe(true)

    store.clearAbortController()
    expect(store.hasAbortable).toBe(false)
    expect(store.abortableCount).toBe(0)
    expect(a.signal.aborted).toBe(false)
  })
})
