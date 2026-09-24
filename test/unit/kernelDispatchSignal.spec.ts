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
  generateVectorWithMeta: vi.fn(async (text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return { vector: vec.map((v: number) => v / norm), isPseudo: false }
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
import type { LLMPort, LLMCallOptions } from '@/kernel/types'
import { clearCache, resetSavingsCounters } from '@/services/semanticCache'

/**
 * S-6（快照 §S-6，P3）：取消信号在内核契约这一层断了。
 *
 * 核验过的事实锚点（2026-09-24 快照 + 本轮独立复核）：
 *   ① src\kernel\types.ts:192 `LLMCallOptions` 没有 signal 字段
 *      （LLMPort.chatCompletionStream 的契约缺口——调用方无从把取消信号传下来）；
 *   ② src\kernel\index.ts:158 按该契约调用 LLMPort.chatCompletionStream，只带
 *      tier/taskType/callerId/domain/traceId/stream——没有 signal 的位置；
 *   ③ src\App.vue:593 的 LLMPort 适配器把 apiStore.chatCompletionStream 的第 5 参
 *      （externalSignal）写死 undefined。
 *
 * 本文件钉住内核这一层的契约：`DispatchOptions.signal` 必须原样落到
 * `LLMCallOptions.signal` 再交给 LLMPort——这是让 ①→②→③ 一线贯通的前提。
 */

describe('S-6：内核取消信号契约（DispatchOptions.signal → LLMPort）', () => {
  let kernel: HoloKernel
  let seen: Array<AbortSignal | undefined>

  function makePort(): LLMPort {
    return {
      async chatCompletion(_messages, options: LLMCallOptions) {
        seen.push(options.signal)
        return { content: 'sig-ok', tier: 'standard', promptTokens: 1, completionTokens: 1 }
      },
      async chatCompletionStream(_messages, options: LLMCallOptions) {
        seen.push(options.signal)
        return (async function* (): AsyncGenerator<string> {
          yield 'sig-chunk'
        })()
      },
      async listModels() {
        return []
      },
    }
  }

  beforeEach(() => {
    clearCache()
    resetSavingsCounters()
    seen = []
    kernel = createKernel()
    kernel.registerLLM(makePort())
  })

  it('非流式：dispatch 的 options.signal 透传到 LLMPort.chatCompletion', async () => {
    const ac = new AbortController()
    const result = await kernel.dispatch('sig-nonstream-2026', {
      messages: [{ role: 'user', content: 'sig-nonstream-2026' }],
      signal: ac.signal,
    })

    expect(result.success).toBe(true)
    expect(seen[0]).toBe(ac.signal)
  })

  it('流式：dispatch 的 options.signal 透传到 LLMPort.chatCompletionStream', async () => {
    const ac = new AbortController()
    const result = await kernel.dispatch('sig-stream-2026', {
      stream: true,
      messages: [{ role: 'user', content: 'sig-stream-2026' }],
      signal: ac.signal,
    })

    expect(result.success).toBe(true)
    expect(seen[0]).toBe(ac.signal)
  })

  it('守卫：未传 signal 时透传 undefined（老调用方零迁移）', async () => {
    const result = await kernel.dispatch('sig-absent-2026', {
      messages: [{ role: 'user', content: 'sig-absent-2026' }],
    })

    expect(result.success).toBe(true)
    expect(seen[0]).toBeUndefined()
  })
})
