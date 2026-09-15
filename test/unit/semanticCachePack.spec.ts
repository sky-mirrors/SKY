import { describe, it, expect, beforeEach, vi } from 'vitest'
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
  invalidateByPack,
  invalidateByDomain,
  clearCache,
  setConfig,
  getCacheSize
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
  calculateCost: vi.fn(() => ({ inputCost: 0, outputCost: 0, cacheSaving: 0, totalCost: 0 })),
  // B-14：lookup 节省成本改用 calculateCostByTier
  calculateCostByTier: vi.fn(() => ({ inputCost: 0, outputCost: 0, cacheSaving: 0, totalCost: 0 }))
}))

describe('semanticCache M10：packId 隔离与精确匹配', () => {
  beforeEach(() => {
    vault.clearCache()
    clearCache()
    setConfig({ similarityThreshold: 0.92, enabled: true, maxEntries: 500 })
  })

  it('带 packId 的条目仅被同 packId 查询命中', async () => {
    await store({
      queryText: '劳动合同法第十条原文',
      responseText: 'pack 版回答',
      tier: 'standard',
      promptTokens: 10,
      completionTokens: 10,
      packId: 'legal'
    })

    const samePack = await lookup('劳动合同法第十条原文', undefined, 'legal')
    expect(samePack.hit).toBe(true)
    expect(samePack.entry!.packId).toBe('legal')

    const noPack = await lookup('劳动合同法第十条原文')
    expect(noPack.hit).toBe(false)

    const otherPack = await lookup('劳动合同法第十条原文', undefined, 'finance')
    expect(otherPack.hit).toBe(false)
  })

  it('无 packId 条目不被带 packId 的查询命中', async () => {
    await store({
      queryText: '通用问题',
      responseText: '通用回答',
      tier: 'nano',
      promptTokens: 5,
      completionTokens: 5
    })

    const hostLookup = await lookup('通用问题')
    expect(hostLookup.hit).toBe(true)

    const packLookup = await lookup('通用问题', undefined, 'legal')
    expect(packLookup.hit).toBe(false)
  })

  it('同查询不同 pack 各自独立成条（store 复合键去重，不互相顶替）', async () => {
    await store({
      queryText: '竞业限制补偿标准',
      responseText: 'legal 版回答',
      tier: 'standard',
      promptTokens: 10,
      completionTokens: 10,
      domain: 'legal',
      packId: 'legal'
    })
    await store({
      queryText: '竞业限制补偿标准',
      responseText: 'finance 版回答',
      tier: 'standard',
      promptTokens: 10,
      completionTokens: 10,
      domain: 'finance',
      packId: 'finance'
    })

    expect(getCacheSize()).toBe(2)

    const legalHit = await lookup('竞业限制补偿标准', 'legal', 'legal')
    expect(legalHit.hit).toBe(true)
    expect(legalHit.entry!.responseText).toBe('legal 版回答')

    const financeHit = await lookup('竞业限制补偿标准', 'finance', 'finance')
    expect(financeHit.hit).toBe(true)
    expect(financeHit.entry!.responseText).toBe('finance 版回答')
  })

  it('invalidateByPack 仅摘除目标 pack 条目并返回计数', async () => {
    await store({ queryText: 'q1', responseText: 'r1', tier: 'nano', promptTokens: 1, completionTokens: 1, packId: 'legal' })
    await store({ queryText: 'q2', responseText: 'r2', tier: 'nano', promptTokens: 1, completionTokens: 1, packId: 'legal' })
    await store({ queryText: 'q3', responseText: 'r3', tier: 'nano', promptTokens: 1, completionTokens: 1, packId: 'finance' })
    await store({ queryText: 'q4', responseText: 'r4', tier: 'nano', promptTokens: 1, completionTokens: 1 })

    const removed = invalidateByPack('legal')
    expect(removed).toBe(2)
    expect(getCacheSize()).toBe(2)

    expect((await lookup('q1', undefined, 'legal')).hit).toBe(false)
    expect((await lookup('q3', undefined, 'finance')).hit).toBe(true)
    expect((await lookup('q4')).hit).toBe(true)
  })

  it('invalidateByPack 空串返回 0（不允许用空串清洗全库）', () => {
    expect(invalidateByPack('')).toBe(0)
  })

  it('domain 与 packId 正交：domain 命中但 pack 不命中 → miss', async () => {
    await store({
      queryText: '增值税率是多少',
      responseText: '13%',
      tier: 'standard',
      promptTokens: 5,
      completionTokens: 5,
      domain: 'finance',
      packId: 'finance'
    })

    const wrongPack = await lookup('增值税率是多少', 'finance', 'legal')
    expect(wrongPack.hit).toBe(false)
  })

  it('invalidateByDomain 与 packId 复合键协同（domain 摘除后 pack 查询也 miss）', async () => {
    await store({
      queryText: '仲裁协议效力',
      responseText: '有效',
      tier: 'standard',
      promptTokens: 5,
      completionTokens: 5,
      domain: 'legal',
      packId: 'legal'
    })

    expect(invalidateByDomain('legal')).toBe(1)
    expect((await lookup('仲裁协议效力', 'legal', 'legal')).hit).toBe(false)
  })
})
