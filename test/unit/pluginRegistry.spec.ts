import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HoloEventBus } from '@/kernel/bus'
import { PluginRegistry, semverSatisfies } from '@/host/pluginRegistry'
import type { HoloPlugin, LifecycleEvent, MountResult } from '@/host/types'

function makePlugin(id: string, overrides: Partial<HoloPlugin> = {}): HoloPlugin {
  const base: HoloPlugin = {
    id,
    version: '1.0.0',
    kind: 'tool-provider',
    manifest: { id, version: '1.0.0', kind: 'tool-provider' },
    mount: vi.fn(async () => {}),
    unmount: vi.fn(async () => {}),
  }
  return { ...base, ...overrides, manifest: { ...base.manifest, ...(overrides.manifest ?? {}) } }
}

describe('semverSatisfies', () => {
  it('supports exact, caret, tilde, wildcard and comparator ranges', () => {
    expect(semverSatisfies('1.2.3', '1.2.3')).toBe(true)
    expect(semverSatisfies('1.2.4', '1.2.3')).toBe(false)
    expect(semverSatisfies('1.2.9', '^1.2.3')).toBe(true)
    expect(semverSatisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(semverSatisfies('1.3.0', '~1.2.3')).toBe(false)
    expect(semverSatisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(semverSatisfies('9.9.9', '*')).toBe(true)
    expect(semverSatisfies('1.5.0', '>=1.0.0')).toBe(true)
    expect(semverSatisfies('0.9.0', '>=1.0.0')).toBe(false)
  })
})

describe('M1: PluginRegistry.register', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry({ bus: new HoloEventBus(), mountTimeoutMs: 2000 })
  })

  it('rejects invalid ids', async () => {
    expect((await registry.register(makePlugin('Bad_ID'))).ok).toBe(false)
    expect((await registry.register(makePlugin('1abc'))).ok).toBe(false)
    expect((await registry.register(makePlugin(''))).ok).toBe(false)
  })

  it('rejects duplicate ids', async () => {
    await registry.register(makePlugin('dup'))
    const result = await registry.register(makePlugin('dup'))
    expect(result).toEqual({ ok: false, errors: ['duplicate-id: dup'] })
  })

  it('rejects manifest mismatch with field paths', async () => {
    const p = makePlugin('mismatch', { manifest: { id: 'other', version: 'not-semver', kind: 'tool-provider' } })
    const result = await registry.register(p)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('manifest.id'))).toBe(true)
      expect(result.errors.some(e => e.includes('manifest.version'))).toBe(true)
    }
  })

  it('rejects missing dependencies', async () => {
    const p = makePlugin('dependent', {
      manifest: { id: 'dependent', version: '1.0.0', kind: 'tool-provider', dependencies: { ghost: '*' } },
    })
    const result = await registry.register(p)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('missing-deps: [ghost]')
  })

  it('rejects version mismatch in dependencies', async () => {
    await registry.register(makePlugin('dep', { version: '1.0.0' }))
    const p = makePlugin('dependent', {
      manifest: { id: 'dependent', version: '1.0.0', kind: 'tool-provider', dependencies: { dep: '^2.0.0' } },
    })
    const result = await registry.register(p)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('version-mismatch')
  })

  it('emits mounted lifecycle and lists the plugin', async () => {
    const events: LifecycleEvent[] = []
    registry.onLifecycle(e => events.push(e))
    const p = makePlugin('good')
    const result = await registry.register(p)
    expect(result.ok).toBe(true)
    expect(events).toEqual([{ type: 'mounted', id: 'good', kind: 'tool-provider' }])
    expect(registry.get<HoloPlugin>('good')).toBe(p)
    expect(registry.list()).toHaveLength(1)
  })

  it('reentrant register during mount is refused immediately', async () => {
    let inner: MountResult | undefined
    const self: HoloPlugin = makePlugin('reentrant', {
      mount: vi.fn(async () => {
        inner = await registry.register(self)
      }),
    })
    const outer = await registry.register(self)
    expect(outer.ok).toBe(true)
    expect(inner).toEqual({ ok: false, errors: ['reentrant: mount in progress'] })
  })

  it('mount failure triggers full rollback: bus channels released, plugin not listed', async () => {
    const bus = new HoloEventBus()
    registry = new PluginRegistry({ bus, mountTimeoutMs: 2000 })
    const events: LifecycleEvent[] = []
    registry.onLifecycle(e => events.push(e))
    const p = makePlugin('failer', {
      mount: vi.fn(async (ctx) => {
        ctx.bus.registerHandler('my-channel', () => 1)
        throw new Error('mount exploded')
      }),
    })
    const result = await registry.register(p)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('mount-failed: mount exploded')
    expect(bus.listHandlers()).toEqual([])
    expect(registry.get('failer')).toBeUndefined()
    expect(events.some(e => e.type === 'mount-failed')).toBe(true)
    // re-register after failure is allowed
    const ok = await registry.register(makePlugin('failer', { mount: vi.fn(async () => {}) }))
    expect(ok.ok).toBe(true)
  })

  it('mount timeout marks the id zombie; register/unregister on zombie are refused', async () => {
    const events: LifecycleEvent[] = []
    registry.onLifecycle(e => events.push(e))
    const hanging = makePlugin('zombie', { mount: vi.fn(() => new Promise<void>(() => {})) })
    const result = await registry.register(hanging)
    expect(result.ok).toBe(false)
    expect(events.some(e => e.type === 'zombie' && e.id === 'zombie')).toBe(true)

    const again = await registry.register(makePlugin('zombie'))
    expect(again).toEqual({ ok: false, errors: ['zombie: previous mount timed out'] })

    const un = await registry.unregister('zombie')
    expect(un.ok).toBe(false)
  }, 5000)
})

describe('M2: PluginRegistry.unregister', () => {
  let registry: PluginRegistry
  let bus: HoloEventBus

  beforeEach(async () => {
    bus = new HoloEventBus()
    registry = new PluginRegistry({ bus, mountTimeoutMs: 2000 })
    await registry.register(makePlugin('base'))
  })

  it('unknown id is a no-op with warning', async () => {
    const result = await registry.unregister('ghost')
    expect(result).toEqual({ ok: true, reason: 'not-present' })
  })

  it('refuses when other plugins depend on it', async () => {
    await registry.register(makePlugin('child', {
      manifest: { id: 'child', version: '1.0.0', kind: 'tool-provider', dependencies: { base: '*' } },
    }))
    const result = await registry.unregister('base')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('has-dependents: [child]')
    // remove dependent first, then base succeeds
    await registry.unregister('child')
    const ok = await registry.unregister('base')
    expect(ok.ok).toBe(true)
  })

  it('unmount error is tolerated; ledger cleanup and orphan scan still run', async () => {
    const events: LifecycleEvent[] = []
    registry.onLifecycle(e => events.push(e))
    const p = makePlugin('broken', {
      mount: vi.fn(async (ctx) => {
        ctx.bus.registerHandler('chan', () => 1)
      }),
      unmount: vi.fn(async () => { throw new Error('unmount blew up') }),
    })
    await registry.register(p)
    expect(bus.listHandlers()).toContain('plugin:broken:chan')

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await registry.unregister('broken')
    expect(result.ok).toBe(true)
    expect(bus.listHandlers()).toEqual([])
    expect(registry.get('broken')).toBeUndefined()
    expect(events.some(e => e.type === 'unmounted' && e.id === 'broken')).toBe(true)
    errSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('M14: runtime permission checks', () => {
  let registry: PluginRegistry

  beforeEach(async () => {
    registry = new PluginRegistry({ bus: new HoloEventBus(), mountTimeoutMs: 2000 })
    await registry.register(makePlugin('hooked', {
      kind: 'domain-pack',
      manifest: {
        id: 'hooked', version: '1.0.0', kind: 'domain-pack',
        capabilities: { hooks: { L2: ['advisory', 'override'], boundary: ['veto'] } },
      },
    }))
    await registry.register(makePlugin('nohooks', {
      kind: 'domain-pack',
      manifest: { id: 'nohooks', version: '1.0.0', kind: 'domain-pack' },
    }))
  })

  it('grants only declared tier@layer combinations', () => {
    expect(registry.checkPermission('hooked', 'L2', 'advisory')).toBe(true)
    expect(registry.checkPermission('hooked', 'L2', 'override')).toBe(true)
    expect(registry.checkPermission('hooked', 'boundary', 'veto')).toBe(true)
    expect(registry.checkPermission('hooked', 'L3', 'advisory')).toBe(false)
    expect(registry.checkPermission('hooked', 'boundary', 'advisory')).toBe(false)
  })

  it('undeclared hooks mean no permission at all (conservative default)', () => {
    expect(registry.checkPermission('nohooks', 'L2', 'advisory')).toBe(false)
  })

  it('unknown plugin denies without throwing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(registry.checkPermission('ghost', 'L2', 'advisory')).toBe(false)
    errSpy.mockRestore()
  })

  it('permission is revoked after unregister', async () => {
    await registry.unregister('hooked')
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(registry.checkPermission('hooked', 'L2', 'advisory')).toBe(false)
    warnSpy.mockRestore()
  })
})
