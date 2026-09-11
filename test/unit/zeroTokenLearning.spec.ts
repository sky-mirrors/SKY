import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ZeroTokenLearner, DEFAULT_ZOL_CONFIG, clampThreshold } from '@/services/zeroTokenLearning'
import type { ZOLAdjustFn, ZOLConfig } from '@/services/zeroTokenLearning'
import { vault } from '@/vault'

function mockElectronAPI() {
  vi.stubGlobal('window', {
    electronAPI: {
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([]),
    }
  })
}

interface TestThresholds {
  threshold1: number
  threshold2: number
}

const DEFAULTS: TestThresholds = { threshold1: 10, threshold2: 0.5 }
const STORAGE_KEY = 'test-zol'
const VAULT_NS = 'zol'

const simpleAdjust: ZOLAdjustFn<TestThresholds> = (thresholds, successRate, _defaults, config) => {
  const step = config.adjustStep
  if (successRate < 0.70) {
    thresholds.threshold1 *= (1 - step)
    thresholds.threshold2 *= (1 - step)
  } else if (successRate > 0.90) {
    thresholds.threshold1 *= (1 + step)
    thresholds.threshold2 *= (1 + step)
  }
}

describe('zeroTokenLearning', () => {
  beforeEach(() => {
    vault.clearCache()
    mockElectronAPI()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('ZeroTokenLearner', () => {
    it('initializes with default thresholds', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
      })
      expect(learner.getThresholds().threshold1).toBe(10)
      expect(learner.getThresholds().threshold2).toBe(0.5)
    })

    it('records outcomes without error', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
      })
      learner.recordOutcome('strategy_a', 'success', { threshold1: 10 })
      const state = learner.getState()
      expect(state.outcomeCount).toBe(1)
      expect(state.recentSuccessRate).toBe(1.0)
    })

    it('adjusts thresholds after adjustWindow outcomes', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 5, adjustSampleSize: 10 },
      })
      for (let i = 0; i < 5; i++) {
        learner.recordOutcome('strategy_a', 'failure')
      }
      const t = learner.getThresholds()
      expect(t.threshold1).toBeLessThan(DEFAULTS.threshold1)
      expect(t.threshold2).toBeLessThan(DEFAULTS.threshold2)
    })

    it('does not adjust before adjustWindow outcomes', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 20, adjustSampleSize: 50 },
      })
      for (let i = 0; i < 10; i++) {
        learner.recordOutcome('strategy_a', 'failure')
      }
      const t = learner.getThresholds()
      expect(t.threshold1).toBe(DEFAULTS.threshold1)
      expect(t.threshold2).toBe(DEFAULTS.threshold2)
    })

    it('tightens thresholds on high success rate', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 5, adjustSampleSize: 10 },
      })
      for (let i = 0; i < 5; i++) {
        learner.recordOutcome('strategy_a', 'success')
      }
      const t = learner.getThresholds()
      expect(t.threshold1).toBeGreaterThan(DEFAULTS.threshold1)
    })

    it('clamps thresholds to ±30% of defaults', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 2, adjustSampleSize: 5, adjustStep: 0.20 },
      })
      for (let i = 0; i < 100; i++) {
        learner.recordOutcome('strategy_a', 'success')
      }
      const t = learner.getThresholds()
      const maxHi = DEFAULTS.threshold1 * 1.30
      expect(t.threshold1).toBeLessThanOrEqual(maxHi)
    })

    it('persists state to vault cache', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 2, adjustSampleSize: 5 },
      })
      learner.recordOutcome('strategy_a', 'failure')
      learner.recordOutcome('strategy_a', 'failure')

      vi.useFakeTimers()
      learner.recordOutcome('strategy_a', 'failure')
      vi.advanceTimersByTime(2000)
      vi.useRealTimers()

      const stored = vault.readCache(VAULT_NS, STORAGE_KEY)
      expect(stored).not.toBeNull()
      if (stored) {
        const parsed = JSON.parse(stored)
        expect(parsed.outcomes.length).toBeGreaterThanOrEqual(2)
      }
    })

    it('loads state from vault cache', () => {
      vault.writeCache(VAULT_NS, STORAGE_KEY, JSON.stringify({
        thresholds: { threshold1: 8, threshold2: 0.4 },
        outcomes: [{ decisionPoint: 'test', selectedStrategy: 'a', outcome: 'success', timestamp: Date.now(), contextSnapshot: {} }],
      }))
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
      })
      expect(learner.getThresholds().threshold1).toBe(8)
      expect(learner.getState().outcomeCount).toBe(1)
    })

    it('resets to defaults', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustWindow: 2, adjustSampleSize: 5 },
      })
      learner.recordOutcome('strategy_a', 'failure')
      learner.recordOutcome('strategy_a', 'failure')
      expect(learner.getThresholds().threshold1).toBeLessThan(DEFAULTS.threshold1)

      learner.reset()
      expect(learner.getThresholds().threshold1).toBe(DEFAULTS.threshold1)
      expect(learner.getState().outcomeCount).toBe(0)
    })

    it('cleans up migration keys on init', () => {
      vault.writeCache(VAULT_NS, 'test-legacy-key', JSON.stringify({ old: true }))
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        migrationKeys: ['test-legacy-key'],
      })
      expect(vault.readCache(VAULT_NS, 'test-legacy-key')).toBeNull()
    })

    it('truncates history to maxHistory', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { maxHistory: 5 },
      })
      for (let i = 0; i < 10; i++) {
        learner.recordOutcome('strategy_a', 'success')
      }
      expect(learner.getState().outcomeCount).toBe(5)
    })

    it('calculates recentSuccessRate correctly', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
        config: { adjustSampleSize: 100 },
      })
      learner.recordOutcome('a', 'success')
      learner.recordOutcome('a', 'success')
      learner.recordOutcome('a', 'failure')
      expect(learner.getState().recentSuccessRate).toBeCloseTo(2 / 3)
    })

    it('defaults to 0.5 success rate with no outcomes', () => {
      const learner = new ZeroTokenLearner<TestThresholds>({
        decisionPoint: 'test',
        defaultThresholds: DEFAULTS,
        adjustFn: simpleAdjust,
        storageKey: STORAGE_KEY,
      })
      expect(learner.getState().recentSuccessRate).toBe(0.5)
    })
  })

  describe('clampThreshold', () => {
    it('clamps high values', () => {
      expect(clampThreshold(100, 10, 0.30)).toBe(13)
    })

    it('clamps low values', () => {
      expect(clampThreshold(1, 10, 0.30)).toBe(7)
    })

    it('passes through values within range', () => {
      expect(clampThreshold(10, 10, 0.30)).toBe(10)
    })
  })

  describe('DEFAULT_ZOL_CONFIG', () => {
    it('has expected defaults', () => {
      expect(DEFAULT_ZOL_CONFIG.adjustWindow).toBe(20)
      expect(DEFAULT_ZOL_CONFIG.adjustSampleSize).toBe(50)
      expect(DEFAULT_ZOL_CONFIG.adjustStep).toBe(0.05)
      expect(DEFAULT_ZOL_CONFIG.adjustClamp).toBe(0.30)
      expect(DEFAULT_ZOL_CONFIG.maxHistory).toBe(500)
    })
  })
})
