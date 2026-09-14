import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createKernel } from '@/kernel'
import { globalClusterRegistry } from '@/kernel/clusters/registry'
import * as defaultCache from '@/kernel/clusters/cache'
import type { CacheLookupResult, KernelContext } from '@/kernel/types'

function fakeCacheCluster(responseText: string, onLookup?: () => void) {
  return {
    ...defaultCache,
    lookup: vi.fn(async (_queryText: string, _domain?: string, _context?: KernelContext): Promise<CacheLookupResult> => {
      onLookup?.()
      return { hit: true, responseText, tier: 'nano', promptTokens: 3, completionTokens: 4 }
    }),
  }
}

describe('簇注册表：委托可换（spec 6.3）', () => {
  beforeEach(() => {
    globalClusterRegistry.unregister('cache')
  })

  afterEach(() => {
    globalClusterRegistry.unregister('cache')
  })

  it('defaults to the built-in cluster modules', () => {
    expect(globalClusterRegistry.get('cache')).toBe(defaultCache)
    expect(globalClusterRegistry.isCustom('cache')).toBe(false)
  })

  it('register swaps the delegate; unregister restores the default', () => {
    const fake = fakeCacheCluster('x')
    globalClusterRegistry.register('cache', fake)
    expect(globalClusterRegistry.get('cache')).toBe(fake)
    expect(globalClusterRegistry.isCustom('cache')).toBe(true)

    globalClusterRegistry.unregister('cache')
    expect(globalClusterRegistry.get('cache')).toBe(defaultCache)
  })

  it('kernel.cache getter reflects the current delegate', () => {
    const kernel = createKernel()
    expect(kernel.cache).toBe(defaultCache)
    const fake = fakeCacheCluster('x')
    globalClusterRegistry.register('cache', fake)
    expect(kernel.cache).toBe(fake)
  })

  it('dispatch smoke: a replaced cache cluster serves the request without any LLM', async () => {
    const kernel = createKernel()
    globalClusterRegistry.register('cache', fakeCacheCluster('from-fake-cache'))

    const result = await kernel.dispatch('hello', { stream: false })
    expect(result.success).toBe(true)
    expect(result.fromCache).toBe(true)
    expect(result.responseText).toBe('from-fake-cache')
  })

  it('M15 snapshot semantics: a swap during an in-flight request does not affect that request', async () => {
    const kernel = createKernel()
    let releaseFirst: (() => void) | undefined
    const fake1 = {
      ...defaultCache,
      lookup: vi.fn(async (): Promise<CacheLookupResult> => {
        await new Promise<void>(resolve => { releaseFirst = resolve })
        return { hit: true, responseText: 'from-fake-1', tier: 'nano', promptTokens: 1, completionTokens: 1 }
      }),
    }
    globalClusterRegistry.register('cache', fake1)

    const inFlight = kernel.dispatch('hello', { stream: false })
    // swap the delegate while the request is awaiting the slow cache lookup
    await vi.waitFor(() => expect(fake1.lookup).toHaveBeenCalledTimes(1))
    globalClusterRegistry.register('cache', fakeCacheCluster('from-fake-2'))

    releaseFirst!()
    const result = await inFlight
    expect(result.responseText).toBe('from-fake-1')

    // the next request uses the new delegate
    const next = await kernel.dispatch('again', { stream: false })
    expect(next.responseText).toBe('from-fake-2')
  })
})
