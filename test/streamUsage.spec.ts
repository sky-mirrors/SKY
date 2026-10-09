import { describe, it, expect } from 'vitest'
import { parseStreamUsage, mergeStreamUsage } from '@electron/streamUsage'

/**
 * S-3（原机制快照登记项，P1；文档已删）：主进程流式 usage 解析。
 *
 * 原实现（`electron\ipc-handlers.ts`）流式分支只取 `prompt_tokens` / `completion_tokens`，
 * `prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens` 从未解析 ⇒ end payload
 * 三处硬编码 `cacheHitTokens: 0`。后果：DeepSeek 等 OpenAI 兼容 provider 的缓存命中折扣在
 * **桌面流式主路径**被系统性清零，`actualCostOf` 与 record-cost 记账均按全价计——G-5
 * 「按实际 usage 计价」只在 direct-fetch 分支完整生效。
 *
 * 渲染层解析器 `src\services\sseParser.ts` 早已支持这些字段（含 details 兼容形态），
 * 主进程维护着一套独立且更弱的解析，两边已实质漂移。本模块与渲染层同口径并对齐
 * Anthropic 的 `cache_read_input_tokens`。
 */
describe('S-3: 主进程流式 usage 解析（parseStreamUsage）', () => {
  it('OpenAI 形态：prompt_cache_hit_tokens / prompt_cache_miss_tokens', () => {
    expect(parseStreamUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 768,
      prompt_cache_miss_tokens: 232
    })).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      cacheHitTokens: 768,
      cacheMissTokens: 232
    })
  })

  it('OpenAI 兼容形态：prompt_tokens_details.cached_tokens / uncached_tokens', () => {
    expect(parseStreamUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 512, uncached_tokens: 488 }
    })).toEqual({
      promptTokens: 1000,
      completionTokens: 200,
      cacheHitTokens: 512,
      cacheMissTokens: 488
    })
  })

  it('扁平字段优先于 details 兼容形态（与渲染层 sseParser 同口径）', () => {
    const u = parseStreamUsage({
      prompt_cache_hit_tokens: 700,
      prompt_tokens_details: { cached_tokens: 512 }
    })
    expect(u.cacheHitTokens).toBe(700)
  })

  it('Anthropic 形态：input_tokens / output_tokens + cache_read_input_tokens', () => {
    expect(parseStreamUsage({
      input_tokens: 900,
      output_tokens: 150,
      cache_read_input_tokens: 640
    })).toEqual({
      promptTokens: 900,
      completionTokens: 150,
      cacheHitTokens: 640
    })
  })

  it('缺失字段不出现在结果里（调用方据此保留累加器既有值）', () => {
    expect(parseStreamUsage({ completion_tokens: 12 })).toEqual({ completionTokens: 12 })
  })

  it('0 是有效值：不得被当作缺失（用 ?? 而非 ||，否则命中为 0 时会回退到旧值）', () => {
    expect(parseStreamUsage({
      prompt_tokens: 0,
      completion_tokens: 0,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0
    })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0
    })
  })

  it('非对象输入 → 空结果且不抛（流里任何一行都可能是非预期载荷）', () => {
    expect(parseStreamUsage(undefined)).toEqual({})
    expect(parseStreamUsage(null)).toEqual({})
    expect(parseStreamUsage('boom')).toEqual({})
    expect(parseStreamUsage(42)).toEqual({})
  })
})

describe('S-3: mergeStreamUsage —— 逐字段并入累加器（不许把已累计值清成 0）', () => {
  it('只覆盖确实出现的字段，其余保持原值', () => {
    const acc = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 1, cacheMissTokens: 2 }
    mergeStreamUsage(acc, { completion_tokens: 7 })
    expect(acc.promptTokens).toBe(10)
    expect(acc.completionTokens).toBe(7)
    expect(acc.cacheHitTokens).toBe(1)
    expect(acc.cacheMissTokens).toBe(2)
  })

  it('0 是有效值：命中为 0 时确实覆盖（与 parseStreamUsage 同口径，不得当缺失跳过）', () => {
    const acc = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 99, cacheMissTokens: 99 }
    mergeStreamUsage(acc, { prompt_cache_hit_tokens: 0 })
    expect(acc.cacheHitTokens).toBe(0)
    expect(acc.cacheMissTokens).toBe(99)
  })

  it('空载荷 / 非对象 → 累加器原样不动', () => {
    const acc = { promptTokens: 3, completionTokens: 4, cacheHitTokens: 5, cacheMissTokens: 6 }
    mergeStreamUsage(acc, {})
    mergeStreamUsage(acc, null)
    mergeStreamUsage(acc, 'nope')
    expect(acc).toEqual({ promptTokens: 3, completionTokens: 4, cacheHitTokens: 5, cacheMissTokens: 6 })
  })

  it('Anthropic 分段累加：message_start(仅 input) + message_delta(仅 output) 各自并入、互不清零', () => {
    const acc = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
    mergeStreamUsage(acc, { input_tokens: 120, cache_read_input_tokens: 100 })
    mergeStreamUsage(acc, { output_tokens: 45 })
    expect(acc.promptTokens).toBe(120)
    expect(acc.completionTokens).toBe(45)
    expect(acc.cacheHitTokens).toBe(100)
  })

  it('返回同一引用（就地更新），便于调用方链式使用', () => {
    const acc = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
    expect(mergeStreamUsage(acc, { prompt_tokens: 9 })).toBe(acc)
  })
})
