import { describe, it, expect } from 'vitest'
import { getTierConfig } from '@/services/scheduleOptimizer'

// 2026-09-23 实测（CDP 直连 deepseek-flash，同一提示词只改预算）：
//   maxTokens=512  → completionTokens=512、content 为空（reasoning 吃满整份预算）
//   maxTokens=2048 → reasoning ≈820 + 正文 249 字，正常输出商务邮件
// 结论：当前档位表（nano 512 / mini 1024）是按"本地非推理小模型"校准的
// （HANDOFF 记载校准依据为 qwen2.5:3b ~10 tok/s），而 deepseek-flash / deepseek-v4-pro
// 都是**推理模型**，会先消耗 reasoning_content 的 token —— 512 预算下正文必然为空，
// 落到 `resp.content || '(LLM无输出)'`（macroExecutor.ts:334），
// 这就是验收考试 8/18 题「(LLM无输出)」的根因。
//
// 不变量：任何档位都必须为 reasoning 留出余量。maxTokens 是**上限**不是配额，
// 提高它不会增加实际消耗（512 那次实际烧掉 512 tokens 却零产出，才是真浪费）。
const MIN_TIER_MAX_TOKENS = 4096

describe('档位 maxTokens 必须为推理模型的 reasoning 留出预算', () => {
  const TIERS = ['nano', 'mini', 'standard', 'pro'] as const

  it.each(TIERS)('%s 档 maxTokens ≥ %i（含 reasoning 余量）', (tier) => {
    expect(getTierConfig(tier).maxTokens).toBeGreaterThanOrEqual(MIN_TIER_MAX_TOKENS)
  })

  it('档位单调不减，且未知 tier 回退到 standard', () => {
    const vals = TIERS.map(t => getTierConfig(t).maxTokens)
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThan(vals[i - 1])
    }
    expect(getTierConfig('no-such-tier').maxTokens).toBe(getTierConfig('standard').maxTokens)
  })
})
