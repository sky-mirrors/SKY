import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { vault } from '@/vault'

;(globalThis as any).window = {
  electronAPI: {
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
}

import {
  lookup,
  store,
  invalidateByDomain,
  invalidateByConstraint,
  invalidateExpired,
  clearCache,
  getConfig,
  setConfig,
  getCacheSize,
  getCacheSavings,
  resetSavingsCounters,
  getAdaptiveThreshold,
  resetAdaptiveThreshold,
  loadFromStorage
} from '@/services/semanticCache'

vi.mock('@/services/embedder', () => {
  const genVec = async (text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return vec.map((v: number) => v / norm)
  }
  return {
    generateVector: vi.fn(genVec),
    generateVectorWithMeta: vi.fn(async (text: string) => ({ vector: await genVec(text), isPseudo: false })),
    isEmbedderReady: vi.fn(() => false),
    cosineSimilarity: vi.fn((a: number[], b: number[]) => {
      if (a.length !== b.length || a.length === 0) return 0
      let dot = 0, normA = 0, normB = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        normA += a[i] * a[i]
        normB += b[i] * b[i]
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB)
      return denom === 0 ? 0 : dot / denom
    }),
    needsReembedding: vi.fn((vector: number[], isPseudo?: boolean) => vector.length !== 384 || isPseudo !== false)
  }
})

vi.mock('@/services/tokenPricing', () => ({
  calculateCost: vi.fn((inputTokens: number, outputTokens: number, cacheHitTokens: number) => {
    const inputCost = (inputTokens / 1000) * 0.005
    const outputCost = (outputTokens / 1000) * 0.015
    const cacheSaving = (cacheHitTokens / 1000) * 0.005 * 0.5
    return { inputCost, outputCost, cacheSaving, totalCost: Math.max(0, inputCost + outputCost - cacheSaving) }
  })
}))

describe('semanticCache', () => {
  beforeEach(() => {
    vault.clearCache()
    clearCache()
    setConfig({ similarityThreshold: 0.92, enabled: true, maxEntries: 500 })
    resetAdaptiveThreshold()
  })

  describe('lookup / store (two-layer cache)', () => {
    it('misses on empty cache', async () => {
      const result = await lookup('hello')
      expect(result.hit).toBe(false)
      expect(result.entry).toBeNull()
    })

    it('stores and retrieves exact match (Layer 1)', async () => {
      await store({
        queryText: '什么是劳动合同法',
        responseText: '劳动合同法是...',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200
      })
      const result = await lookup('什么是劳动合同法')
      expect(result.hit).toBe(true)
      expect(result.entry).not.toBeNull()
      expect(result.entry!.responseText).toBe('劳动合同法是...')
      expect(result.savedTokens).toBe(200)
      expect(result.similarity).toBe(1.0)
    })

    it('hits on semantically similar query (Layer 2)', async () => {
      await store({
        queryText: '劳动合同法的内容是什么',
        responseText: '劳动合同法规定...',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 300,
        domain: 'legal'
      })
      const result = await lookup('劳动合同法有哪些内容', 'legal')
      expect(result.hit).toBe(true)
      expect(result.similarity).toBeGreaterThanOrEqual(0.92)
    })

    it('misses on very different query', async () => {
      await store({
        queryText: '劳动合同法的内容',
        responseText: '劳动合同法规定...',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200
      })
      const result = await lookup('今天天气怎么样')
      expect(result.hit).toBe(false)
    })

    it('misses when disabled', async () => {
      setConfig({ enabled: false })
      await store({
        queryText: 'test query',
        responseText: 'test response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50
      })
      const result = await lookup('test query')
      expect(result.hit).toBe(false)
    })

    it('increments hit count on subsequent hits', async () => {
      await store({
        queryText: 'hello world',
        responseText: 'response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50
      })
      await lookup('hello world')
      await lookup('hello world')
      const result = await lookup('hello world')
      expect(result.hit).toBe(true)
      expect(result.entry!.hitCount).toBeGreaterThanOrEqual(2)
    })

    it('does not duplicate on same query store', async () => {
      await store({
        queryText: 'same query',
        responseText: 'response 1',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 100
      })
      await store({
        queryText: 'same query',
        responseText: 'response 2',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 100
      })
      expect(getCacheSize()).toBe(1)
    })

    it('calculates savedCost using calculateCost', async () => {
      await store({
        queryText: 'cost test query',
        responseText: 'cost test response',
        tier: 'standard',
        promptTokens: 1000,
        completionTokens: 500
      })
      const result = await lookup('cost test query')
      expect(result.hit).toBe(true)
      expect(result.savedCost).toBeGreaterThan(0)
    })
  })

  describe('domain filtering', () => {
    it('misses when domain does not match', async () => {
      await store({
        queryText: '合同审查流程',
        responseText: '流程如下...',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'legal'
      })
      const result = await lookup('合同审查流程', 'finance')
      expect(result.hit).toBe(false)
    })

    it('hits when domain matches', async () => {
      await store({
        queryText: '合同审查流程',
        responseText: '流程如下...',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'legal'
      })
      const result = await lookup('合同审查流程', 'legal')
      expect(result.hit).toBe(true)
    })

    it('misses when lookup has no domain but entry has one (spec M10: strict match)', async () => {
      await store({
        queryText: '通用查询',
        responseText: '通用回答',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'legal'
      })
      const result = await lookup('通用查询')
      expect(result.hit).toBe(false)
    })

    it('hits when neither entry nor lookup has a domain', async () => {
      await store({
        queryText: '通用查询',
        responseText: '通用回答',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200
      })
      const result = await lookup('通用查询')
      expect(result.hit).toBe(true)
    })
  })

  describe('invalidation', () => {
    it('invalidateByDomain removes matching entries', async () => {
      await store({
        queryText: 'legal query 1',
        responseText: 'response 1',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'legal'
      })
      await store({
        queryText: 'finance query',
        responseText: 'response 2',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'finance'
      })
      const removed = invalidateByDomain('legal')
      expect(removed).toBe(1)
      expect(getCacheSize()).toBe(1)
    })

    it('invalidateByConstraint removes entries with that constraint', async () => {
      await store({
        queryText: 'query 1',
        responseText: 'response 1',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        constraintIds: ['constraint-1', 'constraint-2']
      })
      await store({
        queryText: 'query 2',
        responseText: 'response 2',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        constraintIds: ['constraint-3']
      })
      const removed = invalidateByConstraint('constraint-1')
      expect(removed).toBe(1)
    })

    it('invalidateExpired removes expired entries', async () => {
      await store({
        queryText: 'old query',
        responseText: 'old response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50,
        ttl: 0
      })
      await new Promise(r => setTimeout(r, 10))
      const removed = invalidateExpired()
      expect(removed).toBe(1)
      expect(getCacheSize()).toBe(0)
    })

    it('clearCache removes everything', async () => {
      await store({
        queryText: 'query',
        responseText: 'response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50
      })
      clearCache()
      expect(getCacheSize()).toBe(0)
    })

    it('invalidation removes from exact map too', async () => {
      await store({
        queryText: 'test exact invalidation',
        responseText: 'response',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 100,
        domain: 'legal'
      })
      invalidateByDomain('legal')
      const result = await lookup('test exact invalidation')
      expect(result.hit).toBe(false)
    })
  })

  describe('config', () => {
    it('returns default config', () => {
      const cfg = getConfig()
      expect(cfg.similarityThreshold).toBe(0.92)
      expect(cfg.maxEntries).toBe(500)
      expect(cfg.enabled).toBe(true)
    })

    it('updates partial config', () => {
      setConfig({ similarityThreshold: 0.95 })
      const cfg = getConfig()
      expect(cfg.similarityThreshold).toBe(0.95)
      expect(cfg.maxEntries).toBe(500)
    })
  })

  describe('LRU eviction', () => {
    it('evicts least recently used entries when exceeding maxEntries', async () => {
      setConfig({ maxEntries: 3 })
      await store({ queryText: 'first', responseText: 'r1', tier: 'nano', promptTokens: 10, completionTokens: 10 })
      await store({ queryText: 'second', responseText: 'r2', tier: 'nano', promptTokens: 10, completionTokens: 10 })
      await store({ queryText: 'third', responseText: 'r3', tier: 'nano', promptTokens: 10, completionTokens: 10 })

      await lookup('first')
      await lookup('second')

      await store({ queryText: 'fourth', responseText: 'r4', tier: 'nano', promptTokens: 10, completionTokens: 10 })

      expect(getCacheSize()).toBeLessThanOrEqual(3)
      const firstResult = await lookup('first')
      expect(firstResult.hit).toBe(true)
      const secondResult = await lookup('second')
      expect(secondResult.hit).toBe(true)
    })

    it('updates LRU order on hit', async () => {
      setConfig({ maxEntries: 2 })
      await store({ queryText: 'old', responseText: 'r1', tier: 'nano', promptTokens: 10, completionTokens: 10 })
      await store({ queryText: 'new', responseText: 'r2', tier: 'nano', promptTokens: 10, completionTokens: 10 })

      await lookup('old')

      await store({ queryText: 'newest', responseText: 'r3', tier: 'nano', promptTokens: 10, completionTokens: 10 })

      const oldResult = await lookup('old')
      expect(oldResult.hit).toBe(true)
    })
  })

  describe('adaptive threshold', () => {
    it('starts at default threshold', () => {
      expect(getAdaptiveThreshold()).toBe(0.92)
    })

    it('decreases threshold after many misses', async () => {
      setConfig({ maxEntries: 100 })
      await store({ queryText: 'cached query', responseText: 'response', tier: 'standard', promptTokens: 100, completionTokens: 100 })

      for (let i = 0; i < 25; i++) {
        await lookup(`completely different query ${i}`)
      }

      expect(getAdaptiveThreshold()).toBeLessThanOrEqual(0.92)
    })

    it('resetAdaptiveThreshold restores defaults', async () => {
      for (let i = 0; i < 25; i++) {
        await lookup(`miss query ${i}`)
      }
      resetAdaptiveThreshold()
      expect(getAdaptiveThreshold()).toBe(0.92)
    })

    it('does not go below minimum threshold', async () => {
      for (let i = 0; i < 100; i++) {
        await lookup(`miss query ${i}`)
      }
      expect(getAdaptiveThreshold()).toBeGreaterThanOrEqual(0.80)
    })
  })

  describe('getCacheSavings', () => {
    it('tracks hit rate', async () => {
      await store({
        queryText: 'test query',
        responseText: 'test response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50
      })
      await lookup('test query')
      await lookup('different query')
      const savings = getCacheSavings()
      expect(savings.totalLookups).toBe(2)
      expect(savings.semanticCacheHits).toBe(1)
      expect(savings.semanticCacheMisses).toBe(1)
      expect(savings.hitRate).toBeCloseTo(0.5, 2)
    })

    it('tracks saved tokens and cost', async () => {
      await store({
        queryText: 'test query',
        responseText: 'test response',
        tier: 'standard',
        promptTokens: 500,
        completionTokens: 500
      })
      const hit = await lookup('test query')
      expect(hit.hit).toBe(true)
      expect(hit.savedTokens).toBe(500)
      const savings = getCacheSavings()
      expect(savings.semanticCacheSavedTokens).toBe(500)
      expect(savings.semanticCacheSavedCost).toBeGreaterThan(0)
    })

    it('resetSavingsCounters clears counters', async () => {
      await store({
        queryText: 'test',
        responseText: 'response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50
      })
      await lookup('test')
      resetSavingsCounters()
      const savings = getCacheSavings()
      expect(savings.semanticCacheHits).toBe(0)
      expect(savings.semanticCacheSavedTokens).toBe(0)
    })
  })

  describe('persistence', () => {
    it('saves and loads entries from vault', async () => {
      await store({
        queryText: 'persist query',
        responseText: 'persist response',
        tier: 'standard',
        promptTokens: 100,
        completionTokens: 200,
        domain: 'legal'
      })

      await new Promise(r => setTimeout(r, 1100))

      clearCache()
      expect(getCacheSize()).toBe(0)

      loadFromStorage()
      expect(getCacheSize()).toBe(1)

      const result = await lookup('persist query', 'legal')
      expect(result.hit).toBe(true)
      expect(result.entry!.responseText).toBe('persist response')
    })

    it('filters expired entries on load', async () => {
      await store({
        queryText: 'expired query',
        responseText: 'expired response',
        tier: 'nano',
        promptTokens: 50,
        completionTokens: 50,
        ttl: 0
      })

      await new Promise(r => setTimeout(r, 1100))

      clearCache()
      loadFromStorage()
      expect(getCacheSize()).toBe(0)
    })
  })
})
