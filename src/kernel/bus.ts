type HandlerFn = (payload: any) => any

export class HoloEventBus {
  private handlers: Map<string, HandlerFn> = new Map()
  private listeners: Map<string, Set<HandlerFn>> = new Map()
  private streamHandlers: Map<string, StreamHandlerFn> = new Map()

  registerHandler(channel: string, handler: HandlerFn): void {
    if (this.handlers.has(channel)) {
      console.warn(`[bus] overwriting handler for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  request<T = any>(channel: string, payload?: any): T {
    const handler = this.handlers.get(channel)
    if (!handler) {
      throw new Error(`[bus] no handler registered for channel: ${channel}`)
    }
    return handler(payload)
  }

  async requestAsync<T = any>(channel: string, payload?: any): Promise<T> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      throw new Error(`[bus] no handler registered for channel: ${channel}`)
    }
    return handler(payload)
  }

  emit(channel: string, payload?: any): void {
    const set = this.listeners.get(channel)
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch (e) {
        console.error(`[bus] error in listener for ${channel}:`, e)
      }
    }
  }

  on(channel: string, handler: HandlerFn): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  off(channel: string, handler: HandlerFn): void {
    const set = this.listeners.get(channel)
    if (set) set.delete(handler)
  }

  listHandlers(): string[] {
    return Array.from(this.handlers.keys())
  }

  listStreamHandlers(): string[] {
    return Array.from(this.streamHandlers.keys())
  }

  listListeners(): Map<string, number> {
    const result = new Map<string, number>()
    for (const [ch, set] of this.listeners) {
      result.set(ch, set.size)
    }
    return result
  }

  registerStreamHandler(channel: string, handler: StreamHandlerFn): void {
    if (this.streamHandlers.has(channel)) {
      console.warn(`[bus] overwriting stream handler for channel: ${channel}`)
    }
    this.streamHandlers.set(channel, handler)
  }

  removeStreamHandler(channel: string): void {
    this.streamHandlers.delete(channel)
  }

  requestStream<T = any>(channel: string, payload?: any): StreamHandle<T> {
    const handler = this.streamHandlers.get(channel)
    if (!handler) {
      throw new Error(`[bus] no stream handler registered for channel: ${channel}`)
    }
    const handle = new StreamHandleImpl<T>()
    handler(payload, {
      onChunk: (data: any) => handle._emit('chunk', data),
      onDone: (data: any) => { handle._emit('done', data); handle._closed = true },
      onError: (err: any) => { handle._emit('error', err); handle._closed = true },
    })
    return handle
  }

  clear(): void {
    if (!isTestEnvironment()) {
      console.error('[bus] clear() is only allowed in test environments (spec M3: ledger would desync)')
    }
    this.handlers.clear()
    this.listeners.clear()
    this.streamHandlers.clear()
  }
}

function isTestEnvironment(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env && (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true')) {
      return true
    }
  } catch { /* ignore */ }
  return false
}

/** M3: 幂等释放句柄 */
export interface Disposer {
  dispose(): void
}

export function makeDisposer(fn: () => void): Disposer {
  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        fn()
      } catch (e) {
        console.error('[bus] disposer error:', e)
      }
    }
  }
}

/** M3: 通道台账——按 owner 归集 Disposer，卸载时容错全量执行 */
export class BusLedger {
  private entries = new Map<string, Set<Disposer>>()

  add(ownerId: string, disposer: Disposer): void {
    let set = this.entries.get(ownerId)
    if (!set) {
      set = new Set()
      this.entries.set(ownerId, set)
    }
    set.add(disposer)
  }

  /** 容错执行并清空该 owner 的全部 disposer，返回执行数 */
  runAll(ownerId: string): number {
    const set = this.entries.get(ownerId)
    if (!set) return 0
    const count = set.size
    for (const d of set) {
      d.dispose()
    }
    this.entries.delete(ownerId)
    return count
  }

  has(ownerId: string): boolean {
    return this.entries.has(ownerId)
  }

  size(ownerId: string): number {
    return this.entries.get(ownerId)?.size ?? 0
  }

  ownerIds(): string[] {
    return Array.from(this.entries.keys())
  }
}

const PLUGIN_CHANNEL_PREFIX = 'plugin:'

/** M3: 插件命名空间总线——通道自动加 plugin:<id>: 前缀，注册即入台账 */
export class NamespacedBus {
  constructor(
    private readonly ownerId: string,
    private readonly bus: HoloEventBus,
    private readonly ledger: BusLedger
  ) {}

  fullChannel(channel: string): string {
    return `${PLUGIN_CHANNEL_PREFIX}${this.ownerId}:${channel}`
  }

  private track(fullName: string, release: () => void): Disposer {
    const disposer = makeDisposer(release)
    this.ledger.add(this.ownerId, disposer)
    return disposer
  }

  registerHandler(channel: string, handler: HandlerFn): Disposer {
    const fullName = this.fullChannel(channel)
    this.bus.registerHandler(fullName, handler)
    return this.track(fullName, () => this.bus.removeHandler(fullName))
  }

  on(channel: string, handler: HandlerFn): Disposer {
    const fullName = this.fullChannel(channel)
    const unsubscribe = this.bus.on(fullName, handler)
    return this.track(fullName, unsubscribe)
  }

  registerStreamHandler(channel: string, handler: StreamHandlerFn): Disposer {
    const fullName = this.fullChannel(channel)
    this.bus.registerStreamHandler(fullName, handler)
    return this.track(fullName, () => this.bus.removeStreamHandler(fullName))
  }

  emit(channel: string, payload?: unknown): void {
    this.bus.emit(this.fullChannel(channel), payload)
  }

  request<T = any>(channel: string, payload?: any): T {
    return this.bus.request<T>(this.fullChannel(channel), payload)
  }

  requestAsync<T = any>(channel: string, payload?: any): Promise<T> {
    return this.bus.requestAsync<T>(this.fullChannel(channel), payload)
  }
}

/** M3.4: 孤儿扫描——plugin: 前缀通道的 owner 不在激活集则告警，不自动删除 */
export function scanOrphanChannels(bus: HoloEventBus, activeOwnerIds: Set<string>): string[] {
  const channels: string[] = [
    ...bus.listHandlers(),
    ...Array.from(bus.listListeners().keys()),
    ...bus.listStreamHandlers(),
  ]
  const orphans: string[] = []
  for (const channel of channels) {
    if (!channel.startsWith(PLUGIN_CHANNEL_PREFIX)) continue
    const owner = channel.split(':')[1]
    if (owner && !activeOwnerIds.has(owner)) {
      console.warn(`[bus] orphan-channel: ${channel} (owner '${owner}' not in registry)`)
      orphans.push(channel)
    }
  }
  return orphans
}

type StreamHandlerFn = (payload: any, callbacks: StreamCallbacks) => void | (() => void)

interface StreamCallbacks {
  onChunk: (data: any) => void
  onDone: (data: any) => void
  onError: (err: any) => void
}

class StreamHandleImpl<T> implements StreamHandle<T> {
  private listeners = new Map<string, Set<HandlerFn>>()
  _closed = false
  private _cancelFn: (() => void) | null = null

  on(event: 'chunk' | 'done' | 'error', handler: HandlerFn): StreamHandle<T> {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(handler)
    return this
  }

  _emit(event: string, data: any): void {
    const set = this.listeners.get(event)
    if (set) for (const fn of set) { try { fn(data) } catch (e) { console.error(`[bus] stream listener error:`, e) } }
  }

  cancel(): void {
    if (this._cancelFn) this._cancelFn()
    this._closed = true
    this.listeners.clear()
  }

  setCancelFn(fn: () => void): void { this._cancelFn = fn }
}

export interface StreamHandle<T> {
  on(event: 'chunk' | 'done' | 'error', handler: (data: any) => void): StreamHandle<T>
  cancel(): void
}

export const globalBus = new HoloEventBus()
