/**
 * S-3（快照 `docs\2026.9.24最新快照.md` §S-3）：主进程流式 usage 解析。
 *
 * 与渲染层 `src\services\sseParser.ts` 同口径——原实现只取 `prompt_tokens` /
 * `completion_tokens`，缓存命中字段从未解析，end payload 三处硬编码
 * `cacheHitTokens: 0`，于是 DeepSeek 等 OpenAI 兼容 provider 的缓存折扣在**桌面流式
 * 主路径**被系统性清零（G-5「按实际 usage 计价」只在 direct-fetch 分支生效）。
 *
 * 兼容形态：OpenAI 的 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`、
 * OpenAI 兼容的 `prompt_tokens_details.cached_tokens`/`uncached_tokens`，
 * 以及 Anthropic 的 `cache_read_input_tokens`。
 */

export interface StreamUsageSnapshot {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

/** 各家 usage 载荷的兼容形状（OpenAI / OpenAI 兼容 / Anthropic） */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; uncached_tokens?: number }
  cache_read_input_tokens?: number
}

/**
 * 从一条流式分帧的 usage 载荷里取出可用字段。
 *
 * 只返回**确实存在**的键（缺失即不出现在结果里），调用方据此决定是否覆盖累加器；
 * 判定用 `??` + `typeof` 而非 `||`——缓存命中为 0 是有效值，不能被当成"缺失"而回退。
 */
export function parseStreamUsage(raw: unknown): Partial<StreamUsageSnapshot> {
  if (!raw || typeof raw !== 'object') return {}
  const u = raw as RawUsage
  const out: Partial<StreamUsageSnapshot> = {}

  const prompt = u.prompt_tokens ?? u.input_tokens
  if (typeof prompt === 'number') out.promptTokens = prompt
  const completion = u.completion_tokens ?? u.output_tokens
  if (typeof completion === 'number') out.completionTokens = completion
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens
  if (typeof hit === 'number') out.cacheHitTokens = hit
  const miss = u.prompt_cache_miss_tokens ?? u.prompt_tokens_details?.uncached_tokens
  if (typeof miss === 'number') out.cacheMissTokens = miss

  return out
}

/**
 * 把解析结果并入累加器（就地更新）。仅覆盖确实出现的字段——避免一条不含 usage 的
 * 分帧把已累计的 token 数清成 0（原实现用 `|| existing` 也有此意，但会吞掉 0 值）。
 */
export function mergeStreamUsage(
  acc: StreamUsageSnapshot,
  raw: unknown
): StreamUsageSnapshot {
  const u = parseStreamUsage(raw)
  if (u.promptTokens !== undefined) acc.promptTokens = u.promptTokens
  if (u.completionTokens !== undefined) acc.completionTokens = u.completionTokens
  if (u.cacheHitTokens !== undefined) acc.cacheHitTokens = u.cacheHitTokens
  if (u.cacheMissTokens !== undefined) acc.cacheMissTokens = u.cacheMissTokens
  return acc
}
