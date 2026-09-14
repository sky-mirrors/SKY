import { HoloEventBus, globalBus, BusLedger } from '@/kernel/bus'
import type { DispatchOptions, KernelContext, KernelResult } from '@/kernel/types'
import type { FunnelBaseContext, FunnelGates, FunnelOutcome } from '@/kernel/funnel'
import type { HoloPlugin, PluginContext } from './types'
import { PLUGIN_ID_RE } from './types'
import { createPluginContext, createVaultConfigBackend } from './context'
import type { ConfigBackend } from './context'
import { withTimeout } from './pluginRegistry'

/** 规格 6.1：内核插件 = 六层路由管线 + 调度策略 + 簇委托的提供者；全局同一时刻至多一个激活 */
export interface KernelPlugin extends HoloPlugin {
  kind: 'kernel'
  dispatch?: (input: string, options: DispatchOptions, context?: KernelContext) => Promise<KernelResult>
  /** 规格 4.3 M5：六层路由管线入口（目标态 dispatch 的主入口；灰度期供 shadow 对照） */
  route?: (input: string, ctx: FunnelBaseContext, options?: { gates?: Partial<FunnelGates>; overrideTimeoutMs?: number }) => Promise<FunnelOutcome>
}

export type KernelState = 'idle' | 'active' | 'draining' | 'switching'

export type ActivateResult =
  | { ok: true; reason?: 'already-active' }
  | { ok: false; reason: 'not-registered' | 'switch-in-progress' | 'mount-failed' | 'switch-failed-rolled-back' | 'zombie' }

export type PoolResult = { ok: true } | { ok: false; reason: 'not-registered' | 'active-kernel-must-stay' | 'invalid-id' | 'duplicate-id' | 'zombie' }

export interface KernelRegistryOptions {
  bus?: HoloEventBus
  ledger?: BusLedger
  configBackend?: ConfigBackend
  mountTimeoutMs?: number
  drainTimeoutMs?: number
  queueLimit?: number
}

interface InFlightEntry {
  cancel: () => void
}

/**
 * 规格 6.2：换内核状态机
 * idle → active → draining（在途归零或超时取消）→ switching（新 mount）→ active(新)
 * 失败回滚旧内核；旧内核不可用 → 内核空缺态（kernel:fatal）。
 */
export class KernelRegistry {
  private pool = new Map<string, KernelPlugin>()
  private zombies = new Set<string>()
  private mounted = new Set<string>()
  private activeId: string | undefined
  private state: KernelState = 'idle'
  private inFlight = new Map<number, InFlightEntry>()
  private queue: Array<() => void> = []
  private nextRequestId = 1
  private drainResolve: (() => void) | undefined
  private drainTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly opts: KernelRegistryOptions = {}) {}

  private get bus(): HoloEventBus {
    return this.opts.bus ?? globalBus
  }

  private get mountTimeoutMs(): number { return this.opts.mountTimeoutMs ?? 10_000 }
  private get drainTimeoutMs(): number { return this.opts.drainTimeoutMs ?? 5_000 }
  private get queueLimit(): number { return this.opts.queueLimit ?? 100 }

  getState(): KernelState { return this.state }
  getActiveId(): string | undefined { return this.activeId }

  /** 入池（不激活） */
  register(k: KernelPlugin): PoolResult {
    if (!k || !PLUGIN_ID_RE.test(k.id ?? '')) return { ok: false, reason: 'invalid-id' }
    if (this.pool.has(k.id)) {
      return { ok: false, reason: this.zombies.has(k.id) ? 'zombie' : 'duplicate-id' }
    }
    this.pool.set(k.id, k)
    return { ok: true }
  }

  /** M4：激活/切换 */
  async activate(id: string, actOpts?: { drainTimeoutMs?: number }): Promise<ActivateResult> {
    const candidate = this.pool.get(id)
    if (!candidate) return { ok: false, reason: 'not-registered' }
    if (this.zombies.has(id)) return { ok: false, reason: 'zombie' }
    if (this.state === 'draining' || this.state === 'switching') {
      return { ok: false, reason: 'switch-in-progress' }
    }
    if (this.activeId === id) return { ok: true, reason: 'already-active' }

    // 无激活内核：直接 mount
    if (!this.activeId) {
      try {
        await this.mountKernel(candidate)
      } catch (err) {
        this.handleMountFailure(candidate, err)
        return { ok: false, reason: 'mount-failed' }
      }
      this.activeId = id
      this.state = 'active'
      this.bus.emit('kernel:activated', { id })
      this.replayQueue()
      return { ok: true }
    }

    // 有激活内核：draining → switching
    const oldId = this.activeId
    const oldPlugin = this.pool.get(oldId)
    this.state = 'draining'
    await this.waitForDrain(actOpts?.drainTimeoutMs ?? this.drainTimeoutMs)

    this.state = 'switching'
    try {
      await this.mountKernel(candidate)
    } catch (err) {
      this.handleMountFailure(candidate, err)
      // 回滚：旧内核保持激活；旧内核不可用 → 内核空缺态
      if (oldPlugin && this.activeId === oldId && !this.zombies.has(oldId)) {
        this.state = 'active'
        this.replayQueue()
      } else {
        this.activeId = undefined
        this.state = 'idle'
        this.bus.emit('kernel:fatal', { failedId: id })
        this.replayQueue()
      }
      return { ok: false, reason: 'switch-failed-rolled-back' }
    }

    // 切换成功：卸载旧内核（容错）
    if (oldPlugin && this.mounted.has(oldId)) {
      try {
        await oldPlugin.unmount()
      } catch (err) {
        console.error(`[kernel-registry] old kernel unmount-error: ${oldId}`, err)
      }
      this.mounted.delete(oldId)
    }
    this.activeId = id
    this.state = 'active'
    this.bus.emit('kernel:switched', { from: oldId, to: id })
    this.replayQueue()
    return { ok: true }
  }

  /** 非激活内核：unmount 但保留池籍 */
  async standby(id: string): Promise<PoolResult> {
    const k = this.pool.get(id)
    if (!k) return { ok: false, reason: 'not-registered' }
    if (this.activeId === id) return { ok: false, reason: 'active-kernel-must-stay' }
    if (this.zombies.has(id)) return { ok: false, reason: 'zombie' }
    if (this.mounted.has(id)) {
      try {
        await k.unmount()
      } catch (err) {
        console.error(`[kernel-registry] standby unmount-error: ${id}`, err)
      }
      this.mounted.delete(id)
    }
    return { ok: true }
  }

  /** 出池 */
  async destroy(id: string): Promise<PoolResult> {
    if (this.activeId === id) return { ok: false, reason: 'active-kernel-must-stay' }
    if (!this.pool.has(id)) return { ok: false, reason: 'not-registered' }
    if (this.mounted.has(id)) {
      await this.standby(id)
    }
    this.pool.delete(id)
    this.zombies.delete(id)
    return { ok: true }
  }

  getActive(): KernelPlugin | undefined {
    if (!this.activeId) return undefined
    const k = this.pool.get(this.activeId)
    return k && !this.zombies.has(k.id) ? k : undefined
  }

  /**
   * 统一入口：空缺 → kernel-vacant；draining/switching → 入队（上限 overflow busy）；
   * active → 委托激活内核 dispatch 并跟踪在途（drain 超时可取消包装 promise）。
   */
  async dispatch(input: string, options: DispatchOptions, context?: KernelContext): Promise<KernelResult> {
    if (this.state === 'idle' || !this.activeId) {
      return { success: false, tier: 'nano', fromCache: false, error: 'kernel-vacant' }
    }
    if (this.state === 'draining' || this.state === 'switching') {
      if (this.queue.length >= this.queueLimit) {
        return { success: false, tier: 'nano', fromCache: false, error: 'kernel-switching-busy' }
      }
      return new Promise<KernelResult>((resolve, reject) => {
        this.queue.push(() => {
          this.dispatch(input, options, context).then(resolve, reject)
        })
      })
    }
    const kernel = this.getActive()
    if (!kernel?.dispatch) {
      return { success: false, tier: 'nano', fromCache: false, error: 'kernel-vacant' }
    }
    const requestId = this.nextRequestId++
    const dispatchFn = kernel.dispatch
    return new Promise<KernelResult>((resolve, reject) => {
      let settled = false
      const entry: InFlightEntry = {
        cancel: () => {
          if (settled) return
          settled = true
          this.inFlight.delete(requestId)
          reject(new Error('cancelled-by-kernel-switch'))
        },
      }
      this.inFlight.set(requestId, entry)
      dispatchFn(input, options, context).then(
        result => {
          if (settled) return
          settled = true
          this.inFlight.delete(requestId)
          this.afterRequestSettled()
          resolve(result)
        },
        err => {
          if (settled) return
          settled = true
          this.inFlight.delete(requestId)
          this.afterRequestSettled()
          reject(err)
        }
      )
    })
  }

  inFlightCount(): number { return this.inFlight.size }
  queueLength(): number { return this.queue.length }

  /**
   * 六层路由入口（M5）：空缺 → kernel-vacant；切换中 → busy（路由不入队，shadow 对照失败即丢弃）；
   * active → 委托激活内核 route。灰度期不计 inFlight（R11），主路径切换后并入统一 dispatch 跟踪。
   */
  async route(input: string, ctx: FunnelBaseContext, options?: { gates?: Partial<FunnelGates>; overrideTimeoutMs?: number }): Promise<FunnelOutcome> {
    if (this.state === 'idle' || !this.activeId) {
      return { kind: 'error', error: 'kernel-vacant' }
    }
    if (this.state === 'draining' || this.state === 'switching') {
      return { kind: 'error', error: 'kernel-switching-busy' }
    }
    const kernel = this.getActive()
    if (!kernel?.route) {
      return { kind: 'error', error: 'kernel-vacant' }
    }
    return kernel.route(input, ctx, options)
  }

  private afterRequestSettled(): void {
    if (this.state === 'draining' && this.inFlight.size === 0 && this.drainResolve) {
      this.drainResolve()
    }
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.drainResolve = resolve
      this.drainTimer = setTimeout(() => {
        // drain 超时：取消剩余在途请求
        for (const [requestId, entry] of Array.from(this.inFlight.entries())) {
          entry.cancel()
          this.bus.emit('kernel:switch-cancelled', { requestId })
        }
        this.inFlight.clear()
        resolve()
      }, timeoutMs)
    }).then(() => {
      if (this.drainTimer) clearTimeout(this.drainTimer)
      this.drainResolve = undefined
      this.drainTimer = undefined
    })
  }

  private replayQueue(): void {
    const pending = this.queue.splice(0)
    for (const run of pending) run()
  }

  private makeContext(pluginId: string): PluginContext {
    return createPluginContext(pluginId, {
      bus: this.bus,
      ledger: this.opts.ledger ?? new BusLedger(),
      configBackend: this.opts.configBackend ?? createVaultConfigBackend(),
    })
  }

  private async mountKernel(k: KernelPlugin): Promise<void> {
    await withTimeout(k.mount(this.makeContext(k.id)), this.mountTimeoutMs, `mount-timeout: ${k.id}`)
    this.mounted.add(k.id)
  }

  private handleMountFailure(k: KernelPlugin, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (message.startsWith('mount-timeout')) {
      this.zombies.add(k.id)
      this.bus.emit('kernel:zombie', { id: k.id, error: message })
      return
    }
    this.bus.emit('kernel:mount-failed', { id: k.id, error: message })
  }
}
