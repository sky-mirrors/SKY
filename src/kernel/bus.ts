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
    this.handlers.clear()
    this.listeners.clear()
    this.streamHandlers.clear()
  }
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
