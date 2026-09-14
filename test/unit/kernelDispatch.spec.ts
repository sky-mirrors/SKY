import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/services/embedder', () => ({
  VECTOR_DIM: 384,
  isEmbedderReady: vi.fn(() => false),
  getEmbedder: vi.fn(async () => null),
  generatePseudoVector: vi.fn(() => [0]),
  generateVector: vi.fn(async (text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return vec.map((v: number) => v / norm)
  }),
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
  needsReembedding: vi.fn((vector: number[]) => vector.length !== 384),
}))

import { createKernel } from '@/kernel'
import type { HoloKernel } from '@/kernel'
import type { LLMPort } from '@/kernel/types'
import { clearCache, resetSavingsCounters } from '@/services/semanticCache'

const mockLLM: LLMPort = {
  async chatCompletion() {
    return { content: 'mock-llm-response', tier: 'standard', promptTokens: 12, completionTokens: 8 }
  },
  async chatCompletionStream() {
    return (async function* (): AsyncGenerator<string> {
      yield 'mock-'
      yield 'stream-chunk'
    })()
  },
  async listModels() {
    return []
  },
}

describe('kernel dispatch pipeline', () => {
  let kernel: HoloKernel

  beforeEach(() => {
    clearCache()
    resetSavingsCounters()
    kernel = createKernel()
    kernel.registerLLM(mockLLM)
  })

  it('cache-miss dispatch runs route → budget → LLM → cache-store and succeeds', async () => {
    const result = await kernel.dispatch('kernel-dispatch-smoke-1', {
      messages: [{ role: 'user', content: 'kernel-dispatch-smoke-1' }],
    })

    expect(result.success).toBe(true)
    expect(result.fromCache).toBe(false)
    expect(result.responseText).toBe('mock-llm-response')
    expect(result.routingDecision).toBeDefined()
    expect(result.routingDecision?.tier).toBeTruthy()
    expect(result.budgetCheck).toBeDefined()
    expect(result.costRecord).toBeDefined()
    expect(result.costRecord?.cost).toBeGreaterThanOrEqual(0)
  })

  it('second identical dispatch hits the semantic cache', async () => {
    const messages = [{ role: 'user', content: 'kernel-dispatch-smoke-2' }]
    const first = await kernel.dispatch('kernel-dispatch-smoke-2', { messages })
    expect(first.success).toBe(true)
    expect(first.fromCache).toBe(false)

    const second = await kernel.dispatch('kernel-dispatch-smoke-2', { messages })
    expect(second.success).toBe(true)
    expect(second.fromCache).toBe(true)
    expect(second.responseText).toBe('mock-llm-response')
  })

  it('stream mode returns an async iterable of chunks', async () => {
    const result = await kernel.dispatch('kernel-dispatch-smoke-3', {
      stream: true,
      messages: [{ role: 'user', content: 'kernel-dispatch-smoke-3' }],
    })

    expect(result.success).toBe(true)
    expect(result.responseStream).toBeDefined()

    const reader = result.responseStream![Symbol.asyncIterator]()
    const first = await reader.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe('mock-')
  })
})
