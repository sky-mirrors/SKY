// P0-B3（A3 修复批）：errorClassifier 超时确定性归类回归测试。
// 背景：apiStore/macroExecutor 统一超时体系 abort reason 均为 TimeoutError DOMException；
// 分类必须走关键词快速路径（不触发 unknown → 额外 LLM 分类调用的雪上加霜路径）。
import { describe, it, expect } from 'vitest'
import { classifyError, classifyErrorForUser } from '@/services/errorClassifier'

describe('errorClassifier (P0-B3)', () => {
  it('TimeoutError DOMException 消息 → timeout/retry 快速路径', async () => {
    const result = await classifyError(
      'TimeoutError: LLM non-stream (maxTok=512) timeout after 60000ms',
      'llm_generate',
      '生成步骤'
    )
    expect(result.category).toBe('timeout')
    expect(result.action).toBe('retry')
  })

  it('AbortSignal.timeout 原生文案 "signal timed out" → timeout', async () => {
    const result = await classifyError(
      'TimeoutError: The operation was aborted due to timeout',
      'http_request',
      '请求步骤'
    )
    expect(result.category).toBe('timeout')
  })

  it("'timeouterror' 显式关键词兜底（小写化后命中）", async () => {
    const result = await classifyError('timeouterror: something', 'llm_generate', 'x')
    expect(result.category).toBe('timeout')
  })

  it('TimeoutError 不被 syntax 档的 TypeError 关键词误伤', async () => {
    // 'TypeError' ≠ 'TimeoutError'——但小写化后都含 'error'，锁定不互相污染
    const timeoutResult = await classifyError('TimeoutError: aborted', 'x', 'x')
    const typeResult = await classifyError('TypeError: cannot read props', 'x', 'x')
    expect(timeoutResult.category).toBe('timeout')
    expect(typeResult.category).toBe('syntax')
  })

  it('classifyErrorForUser 对超时给出用户友好标签', () => {
    expect(classifyErrorForUser('TimeoutError: LLM step timeout after 30000ms')).toBe('超时')
  })
})
