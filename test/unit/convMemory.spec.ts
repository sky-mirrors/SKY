import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shouldCompress, detectChallenge, savePeriodSummary, getLatestSummary, getAllSummaries, clearConvMemory } from '@/services/convMemory'

const SUMMARY_KEY = 'holo-conv-summaries'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

describe('convMemory', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = mockLocalStorage()
    clearConvMemory()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('shouldCompress', () => {
    it('returns false for short conversations', () => {
      const msgs = [
        { role: 'user', content: 'hi', timestamp: Date.now() },
        { role: 'assistant', content: 'hello', timestamp: Date.now() }
      ]
      expect(shouldCompress(msgs)).toBe(false)
    })

    it('returns true when 10+ user rounds', () => {
      const msgs = Array.from({ length: 22 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `message ${i}`,
        timestamp: Date.now() + i * 1000
      }))
      expect(shouldCompress(msgs)).toBe(true)
    })

    it('returns true when total content exceeds 20000 chars', () => {
      const msgs = [
        { role: 'user', content: 'x'.repeat(15000), timestamp: Date.now() },
        { role: 'assistant', content: 'y'.repeat(10000), timestamp: Date.now() }
      ]
      expect(shouldCompress(msgs)).toBe(true)
    })

    it('returns false for moderate conversations', () => {
      const msgs = Array.from({ length: 6 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `short msg ${i}`,
        timestamp: Date.now() + i * 1000
      }))
      expect(shouldCompress(msgs)).toBe(false)
    })
  })

  describe('detectChallenge', () => {
    it('detects "不对" challenge phrase', () => {
      expect(detectChallenge('不对，这个数据是错的', '数据显示100')).toBe(true)
    })

    it('detects "你确定吗" challenge phrase', () => {
      expect(detectChallenge('你确定吗？', '是的，我确定')).toBe(true)
    })

    it('detects "搞错了" challenge phrase', () => {
      expect(detectChallenge('你搞错了', '数据显示100')).toBe(true)
    })

    it('detects "纠正" challenge phrase', () => {
      expect(detectChallenge('请纠正你的回答', '数据显示100')).toBe(true)
    })

    it('detects "记错了" challenge phrase', () => {
      expect(detectChallenge('你记错了', '我说的对')).toBe(true)
    })

    it('returns false for normal conversation', () => {
      expect(detectChallenge('请帮我分析这个合同', '好的，我来分析')).toBe(false)
    })

    it('returns false for simple question', () => {
      expect(detectChallenge('什么是增值税？', '增值税是一种...')).toBe(false)
    })

    it('detects number discrepancy between user and AI', () => {
      expect(detectChallenge('应该是48万元', '总金额为50万元')).toBe(true)
    })

    it('does not flag drastically different numbers as challenge', () => {
      expect(detectChallenge('应该是50万元', '总金额为100万元')).toBe(false)
    })

    it('does not flag matching numbers', () => {
      expect(detectChallenge('是100万元', '总金额为100万元')).toBe(false)
    })

    it('handles no numbers in input gracefully', () => {
      expect(detectChallenge('请再确认一下', '数据显示100')).toBe(false)
    })
  })

  describe('summaries', () => {
    it('saves and retrieves period summary', () => {
      const now = Date.now()
      savePeriodSummary('讨论了合同条款', now - 1000, now)
      expect(getLatestSummary()).toBe('讨论了合同条款')
    })

    it('returns empty string when no summaries', () => {
      expect(getLatestSummary()).toBe('')
    })

    it('getAllSummaries returns formatted string', () => {
      const now = Date.now()
      savePeriodSummary('摘要1', now - 2000, now - 1000)
      savePeriodSummary('摘要2', now - 1000, now)
      const all = getAllSummaries()
      expect(all).toContain('摘要1')
      expect(all).toContain('摘要2')
    })

    it('getAllSummaries returns empty when no summaries', () => {
      expect(getAllSummaries()).toBe('')
    })

    it('clearConvMemory removes summary data', () => {
      savePeriodSummary('test summary', Date.now() - 1000, Date.now())
      clearConvMemory()
      expect(getLatestSummary()).toBe('')
    })

    it('keeps only last 20 summaries', () => {
      for (let i = 0; i < 25; i++) {
        savePeriodSummary(`summary-${i}`, Date.now() - (25 - i) * 1000, Date.now() - (24 - i) * 1000)
      }
      const all = getAllSummaries()
      expect(all).toContain('summary-24')
      expect(all).toContain('summary-5')
      expect(all).not.toContain('summary-4')
    })
  })
})
