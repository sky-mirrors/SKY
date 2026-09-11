import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessagesTokens,
  estimatePromptTokens,
  getContextWindowBudget,
  truncateToTokenLimit
} from '@/services/tokenEstimate'

describe('tokenEstimate', () => {
  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0)
    })

    it('estimates CJK characters at ~1.8 tokens each', () => {
      const text = '你好世界'
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(4 * 1.8))
    })

    it('estimates ASCII at ~0.25 tokens per char', () => {
      const text = 'hello'
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(5 * 0.25))
    })

    it('handles mixed CJK and ASCII', () => {
      const text = '你好hello世界world'
      const tokens = estimateTokens(text)
      const cjk = 4
      const other = 10
      expect(tokens).toBe(Math.ceil(cjk * 1.8 + other * 0.25))
    })

    it('handles Japanese hiragana as CJK', () => {
      const text = 'こんにちは'
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(5 * 1.8))
    })

    it('handles Japanese katakana as CJK', () => {
      const text = 'コンニチハ'
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(5 * 1.8))
    })

    it('handles Korean as CJK', () => {
      const text = '안녕하세요'
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(5 * 1.8))
    })

    it('handles numbers and punctuation', () => {
      const text = '123.45, test!'
      const tokens = estimateTokens(text)
      expect(tokens).toBeGreaterThan(0)
    })

    it('handles long text', () => {
      const text = 'a'.repeat(1000)
      const tokens = estimateTokens(text)
      expect(tokens).toBe(Math.ceil(1000 * 0.25))
    })

    it('unified estimate is between old CJK*1.5 and CJK*2', () => {
      const cjkText = '你好世界测试中文估算'
      const tokens = estimateTokens(cjkText)
      const cjkCount = cjkText.length
      const oldLow = Math.ceil(cjkCount * 1.5)
      const oldHigh = Math.ceil(cjkCount * 2)
      expect(tokens).toBeGreaterThanOrEqual(oldLow)
      expect(tokens).toBeLessThanOrEqual(oldHigh)
    })
  })

  describe('estimateMessagesTokens', () => {
    it('estimates messages with overhead', () => {
      const messages = [
        { role: 'system', content: 'You are a helper' },
        { role: 'user', content: 'Hello' }
      ]
      const tokens = estimateMessagesTokens(messages)
      const rawTokens = estimateTokens('system') + estimateTokens('You are a helper') + estimateTokens('user') + estimateTokens('Hello') + 8
      expect(tokens).toBe(rawTokens)
    })

    it('handles empty messages', () => {
      expect(estimateMessagesTokens([])).toBe(0)
    })
  })

  describe('estimatePromptTokens', () => {
    it('estimates prompt with overhead', () => {
      const tokens = estimatePromptTokens('system prompt', 'context info', 'user question')
      const raw = estimateTokens('system prompt') + estimateTokens('context info') + estimateTokens('user question') + 20
      expect(tokens).toBe(raw)
    })
  })

  describe('getContextWindowBudget', () => {
    it('calculates remaining budget', () => {
      const budget = getContextWindowBudget(8000, 1000, 1024)
      expect(budget).toBe(8000 - 1000 - 1024)
    })

    it('returns 0 if over budget', () => {
      const budget = getContextWindowBudget(2000, 1500, 1024)
      expect(budget).toBe(0)
    })
  })

  describe('truncateToTokenLimit', () => {
    it('returns original text if within limit', () => {
      const text = 'short text'
      expect(truncateToTokenLimit(text, 100)).toBe(text)
    })

    it('truncates text that exceeds limit', () => {
      const text = 'a'.repeat(1000)
      const truncated = truncateToTokenLimit(text, 10)
      expect(truncated.length).toBeLessThan(text.length)
    })

    it('empty string stays empty', () => {
      expect(truncateToTokenLimit('', 100)).toBe('')
    })
  })
})
