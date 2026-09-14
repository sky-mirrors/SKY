import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HoloEventBus, BusLedger, NamespacedBus, makeDisposer, scanOrphanChannels } from '@/kernel/bus'

describe('M3: NamespacedBus 通道台账', () => {
  let bus: HoloEventBus
  let ledger: BusLedger
  let ns: NamespacedBus

  beforeEach(() => {
    bus = new HoloEventBus()
    ledger = new BusLedger()
    ns = new NamespacedBus('test-plugin', bus, ledger)
  })

  it('registerHandler adds plugin: prefix and forwards requests', () => {
    const handler = vi.fn((payload: { x: number }) => payload.x * 2)
    ns.registerHandler('double', handler)

    expect(bus.listHandlers()).toContain('plugin:test-plugin:double')
    expect(ns.request<number>('double', { x: 21 })).toBe(42)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disposer removes the channel and is idempotent', () => {
    const d = ns.registerHandler('chan', () => 1)
    expect(bus.listHandlers()).toContain('plugin:test-plugin:chan')

    d.dispose()
    d.dispose()
    expect(bus.listHandlers()).not.toContain('plugin:test-plugin:chan')
  })

  it('registrations automatically enter the ledger; runAll releases all channels', () => {
    ns.registerHandler('a', () => 1)
    ns.registerHandler('b', () => 2)
    const d = ns.on('c', () => {})
    expect(ledger.size('test-plugin')).toBe(3)

    const released = ledger.runAll('test-plugin')
    expect(released).toBe(3)
    expect(bus.listHandlers()).toEqual([])
    expect(ledger.has('test-plugin')).toBe(false)
    // already-disposed entry is harmless
    d.dispose()
    expect(ledger.size('test-plugin')).toBe(0)
  })

  it('on() disposer unsubscribes the listener', () => {
    const listener = vi.fn()
    const d = ns.on('event', listener)
    ns.emit('event', { v: 1 })
    expect(listener).toHaveBeenCalledTimes(1)

    d.dispose()
    ns.emit('event', { v: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stream handler registers and disposes with prefix', () => {
    const d = ns.registerStreamHandler('stream', () => {})
    expect(bus.listStreamHandlers()).toContain('plugin:test-plugin:stream')
    d.dispose()
    expect(bus.listStreamHandlers()).not.toContain('plugin:test-plugin:stream')
  })

  it('ledger.runAll tolerates throwing disposers', () => {
    const ok = vi.fn()
    ledger.add('owner', makeDisposer(() => { throw new Error('boom') }))
    ledger.add('owner', makeDisposer(ok))
    expect(() => ledger.runAll('owner')).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('scanOrphanChannels reports plugin: channels whose owner is gone, keeps active owners and bare channels', () => {
    const gone = new NamespacedBus('ghost', bus, ledger)
    const alive = new NamespacedBus('alive', bus, ledger)
    gone.registerHandler('orphaned', () => 1)
    alive.registerHandler('kept', () => 1)
    bus.registerHandler('system:channel', () => 1)

    const orphans = scanOrphanChannels(bus, new Set(['alive']))
    expect(orphans).toEqual(['plugin:ghost:orphaned'])
  })

  it('request on a missing channel throws (existing behavior preserved)', () => {
    expect(() => ns.request('missing')).toThrow(/no handler registered/)
  })

  it('bus clear warns outside test env but still clears', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fresh = new HoloEventBus()
    fresh.registerHandler('x', () => 1)
    // NODE_ENV is 'test' under vitest, so no warning expected here
    fresh.clear()
    expect(fresh.listHandlers()).toEqual([])
    warnSpy.mockRestore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
