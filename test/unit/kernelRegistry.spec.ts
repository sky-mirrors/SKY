import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoloEventBus } from '@/kernel/bus'
import { KernelRegistry } from '@/host/kernelRegistry'
import type { KernelPlugin } from '@/host/kernelRegistry'
import type { KernelResult } from '@/kernel/types'

function makeKernel(id: string, overrides: Partial<KernelPlugin> = {}): KernelPlugin {
  const base: KernelPlugin = {
    id,
    version: '1.0.0',
    kind: 'kernel',
    manifest: { id, version: '1.0.0', kind: 'kernel' },
    mount: vi.fn(async () => {}),
    unmount: vi.fn(async () => {}),
    dispatch: vi.fn(async (): KernelResult => ({
      success: true, tier: 'nano', fromCache: false, responseText: `handled-by-${id}`,
    })),
  }
  return { ...base, ...overrides }
}

function resultFrom(text: string): KernelResult {
  return { success: true, tier: 'nano', fromCache: false, responseText: text }
}

describe('M4: KernelRegistry state machine', () => {
  let bus: HoloEventBus
  let registry: KernelRegistry

  beforeEach(() => {
    bus = new HoloEventBus()
    registry = new KernelRegistry({ bus, mountTimeoutMs: 500, drainTimeoutMs: 2000, queueLimit: 100 })
  })

  it('activate from idle mounts and emits kernel:activated', async () => {
    const k = makeKernel('k1')
    registry.register(k)
    const result = await registry.activate('k1')
    expect(result.ok).toBe(true)
    expect(registry.getState()).toBe('active')
    expect(registry.getActiveId()).toBe('k1')
    expect(k.mount).toHaveBeenCalledTimes(1)
    const events: string[] = []
    bus.on('kernel:activated', p => events.push((p as { id: string }).id))
    expect(registry.getActive()).toBe(k)
  })

  it('activate unknown id is refused', async () => {
    expect(await registry.activate('ghost')).toEqual({ ok: false, reason: 'not-registered' })
  })

  it('activate same id is a no-op', async () => {
    registry.register(makeKernel('k1'))
    expect(await registry.activate('k1')).toEqual({ ok: true })
    const k1 = registry.getActive()
    expect(await registry.activate('k1')).toEqual({ ok: true, reason: 'already-active' })
    expect(registry.getActive()).toBe(k1)
  })

  it('dispatch without active kernel returns kernel-vacant', async () => {
    const result = await registry.dispatch('hello', {})
    expect(result.success).toBe(false)
    expect(result.error).toBe('kernel-vacant')
  })

  it('dispatch delegates to the active kernel', async () => {
    const k = makeKernel('k1')
    registry.register(k)
    await registry.activate('k1')
    const result = await registry.dispatch('hello', {})
    expect(result.success).toBe(true)
    expect(result.responseText).toBe('handled-by-k1')
  })

  it('switch waits for in-flight to drain, queues new requests, then replays them on the new kernel', async () => {
    let releaseFirst: (() => void) | undefined
    const k1 = makeKernel('k1', {
      dispatch: vi.fn(async (): Promise<KernelResult> => {
        await new Promise<void>(resolve => { releaseFirst = resolve })
        return resultFrom('slow-k1')
      }),
    })
    const k2 = makeKernel('k2')
    registry.register(k1)
    registry.register(k2)
    await registry.activate('k1')

    const first = registry.dispatch('first', {})
    await vi.waitFor(() => expect(registry.inFlightCount()).toBe(1))

    const switching = registry.activate('k2')
    await vi.waitFor(() => expect(registry.getState()).toBe('draining'))

    const queued = registry.dispatch('queued', {})
    expect(registry.queueLength()).toBe(1)

    releaseFirst!()
    expect((await first).responseText).toBe('slow-k1')
    expect(await switching).toEqual({ ok: true })

    const switchedIds: string[] = []
    bus.on('kernel:switched', p => switchedIds.push((p as { to: string }).to))
    expect(registry.getState()).toBe('active')
    expect(registry.getActiveId()).toBe('k2')
    const queuedResult = await queued
    expect(queuedResult.responseText).toBe('handled-by-k2')
    expect(k1.unmount).toHaveBeenCalledTimes(1)
  })

  it('drain timeout cancels remaining in-flight requests and emits kernel:switch-cancelled', async () => {
    const cancelledIds: number[] = []
    bus.on('kernel:switch-cancelled', p => cancelledIds.push((p as { requestId: number }).requestId))

    const k1 = makeKernel('k1', {
      dispatch: vi.fn(() => new Promise<KernelResult>(() => { /* never settles */ })),
    })
    const k2 = makeKernel('k2')
    registry.register(k1)
    registry.register(k2)
    await registry.activate('k1')

    const hanging = registry.dispatch('hang', {})
    const rejection = hanging.catch((err: Error) => err.message)
    await vi.waitFor(() => expect(registry.inFlightCount()).toBe(1))

    const result = await registry.activate('k2', { drainTimeoutMs: 50 })
    expect(result).toEqual({ ok: true })
    expect(await rejection).toBe('cancelled-by-kernel-switch')
    expect(cancelledIds).toHaveLength(1)
    expect(registry.getActiveId()).toBe('k2')
  })

  it('activate during draining/switching is refused (switch-in-progress)', async () => {
    let release: (() => void) | undefined
    const k1 = makeKernel('k1', {
      dispatch: vi.fn(async (): Promise<KernelResult> => {
        await new Promise<void>(resolve => { release = resolve })
        return resultFrom('k1')
      }),
    })
    registry.register(k1)
    registry.register(makeKernel('k2'))
    registry.register(makeKernel('k3'))
    await registry.activate('k1')

    const first = registry.dispatch('x', {})
    await vi.waitFor(() => expect(registry.inFlightCount()).toBe(1))
    const switching = registry.activate('k2')
    await vi.waitFor(() => expect(registry.getState()).toBe('draining'))

    expect(await registry.activate('k3')).toEqual({ ok: false, reason: 'switch-in-progress' })
    release!()
    await first
    await switching
  })

  it('queue overflow returns kernel-switching-busy', async () => {
    let release: (() => void) | undefined
    const k1 = makeKernel('k1', {
      dispatch: vi.fn(async (): Promise<KernelResult> => {
        await new Promise<void>(resolve => { release = resolve })
        return resultFrom('k1')
      }),
    })
    registry = new KernelRegistry({ bus, mountTimeoutMs: 500, drainTimeoutMs: 2000, queueLimit: 2 })
    registry.register(k1)
    registry.register(makeKernel('k2'))
    await registry.activate('k1')

    const first = registry.dispatch('x', {})
    await vi.waitFor(() => expect(registry.inFlightCount()).toBe(1))
    const switching = registry.activate('k2')
    await vi.waitFor(() => expect(registry.getState()).toBe('draining'))

    const q1 = registry.dispatch('q1', {})
    const q2 = registry.dispatch('q2', {})
    const overflow = await registry.dispatch('q3', {})
    expect(overflow.success).toBe(false)
    expect(overflow.error).toBe('kernel-switching-busy')

    release!()
    await first
    await switching
    expect((await q1).responseText).toBe('handled-by-k2')
    expect((await q2).responseText).toBe('handled-by-k2')
  })

  it('new-kernel mount failure rolls back to the old kernel', async () => {
    const k1 = makeKernel('k1')
    const k2 = makeKernel('k2', { mount: vi.fn(async () => { throw new Error('cannot mount') }) })
    registry.register(k1)
    registry.register(k2)
    await registry.activate('k1')

    const result = await registry.activate('k2')
    expect(result).toEqual({ ok: false, reason: 'switch-failed-rolled-back' })
    expect(registry.getState()).toBe('active')
    expect(registry.getActiveId()).toBe('k1')
    // old kernel still serves
    const served = await registry.dispatch('ping', {})
    expect(served.responseText).toBe('handled-by-k1')
  })

  it('mount timeout marks the candidate zombie; later activate is refused', async () => {
    const k1 = makeKernel('k1')
    const k2 = makeKernel('k2', { mount: vi.fn(() => new Promise<void>(() => {})) })
    registry.register(k1)
    registry.register(k2)
    await registry.activate('k1')

    const result = await registry.activate('k2')
    expect(result).toEqual({ ok: false, reason: 'switch-failed-rolled-back' })
    expect(await registry.activate('k2')).toEqual({ ok: false, reason: 'zombie' })
    expect(registry.getActiveId()).toBe('k1')
  }, 5000)

  it('standby/destroy refuse the active kernel and work for pooled ones', async () => {
    const k1 = makeKernel('k1')
    const k2 = makeKernel('k2')
    registry.register(k1)
    registry.register(k2)
    await registry.activate('k1')

    expect(await registry.standby('k1')).toEqual({ ok: false, reason: 'active-kernel-must-stay' })
    expect(await registry.destroy('k1')).toEqual({ ok: false, reason: 'active-kernel-must-stay' })

    expect(await registry.standby('k2')).toEqual({ ok: true })
    expect(await registry.destroy('k2')).toEqual({ ok: true })
    expect(await registry.destroy('k2')).toEqual({ ok: false, reason: 'not-registered' })
    expect(await registry.standby('ghost')).toEqual({ ok: false, reason: 'not-registered' })
  })
})
