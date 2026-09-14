import type { CacheLookupResult, CacheStoreInput, KernelContext } from '../types'
import { lookup as cacheLookup, store as cacheStore, getConfig as getCacheConfig, invalidateByDomain, invalidateByConstraint } from '@/services/semanticCache'

export async function lookup(queryText: string, domain?: string, context?: KernelContext): Promise<CacheLookupResult> {
  if (context?.skipCacheRead) {
    return { hit: false }
  }
  // P1-13：packId 透传——此前 adapter 丢弃 pack 维度，pack 隔离条目永远查不到
  const result = await cacheLookup(queryText, domain, context?.packId)
  if (!result) {
    return { hit: false }
  }
  return {
    hit: true,
    responseText: result.entry?.responseText,
    tier: result.entry?.tier,
    promptTokens: result.entry?.tokenUsage.promptTokens,
    completionTokens: result.entry?.tokenUsage.completionTokens,
    similarity: result.similarity,
    entryId: result.entry?.id,
  }
}

export async function store(entry: CacheStoreInput, context?: KernelContext): Promise<void> {
  if (context?.skipCacheWrite) {
    return
  }
  await cacheStore({
    queryText: entry.queryText,
    responseText: entry.responseText,
    tier: entry.tier,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    domain: entry.domain,
    // P1-13：显式传入优先，缺省回退 KernelContext（adapter 不再丢弃）
    packId: entry.packId ?? context?.packId,
    constraintIds: entry.constraintIds,
    ttl: entry.ttl,
  })
}

export function getConfig(): any {
  return getCacheConfig()
}

export function invalidate(options: { domain?: string; constraintId?: string }): number {
  if (options.domain) {
    return invalidateByDomain(options.domain)
  }
  if (options.constraintId) {
    return invalidateByConstraint(options.constraintId)
  }
  return 0
}
