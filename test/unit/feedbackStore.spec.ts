import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFeedbackStore, computeQueryFingerprint } from '@/stores/feedbackStore'
import { vault } from '@/vault'

describe('feedbackStore', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
      }
    })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recordFeedback stores feedback entry and adjusts weight', () => {
    const store = useFeedbackStore()
    store.recordFeedback('fp-1', 'skill-a', 'thumbs_up')
    const mod = store.getWeightModifier('skill-a')
    expect(mod).not.toBe(0)
  })

  it('getWeightModifier returns 0 for unknown skillId', () => {
    const store = useFeedbackStore()
    expect(store.getWeightModifier('unknown')).toBe(0)
  })

  it('thumbs_up increases weight modifier by 0.10', () => {
    const store = useFeedbackStore()
    store.recordFeedback('fp-1', 'skill-a', 'thumbs_up')
    expect(store.getWeightModifier('skill-a')).toBeCloseTo(0.10, 2)
  })

  it('thumbs_down decreases weight modifier by 0.15', () => {
    const store = useFeedbackStore()
    store.recordFeedback('fp-1', 'skill-a', 'thumbs_down')
    expect(store.getWeightModifier('skill-a')).toBeCloseTo(-0.15, 2)
  })

  it('undo decreases weight modifier by 0.20', () => {
    const store = useFeedbackStore()
    store.recordFeedback('fp-1', 'skill-a', 'undo')
    expect(store.getWeightModifier('skill-a')).toBeCloseTo(-0.20, 2)
  })

  it('weight modifier is clamped to [-0.50, 0.50]', () => {
    const store = useFeedbackStore()
    for (let i = 0; i < 10; i++) {
      store.recordFeedback(`fp-${i}`, 'skill-a', 'thumbs_up')
    }
    expect(store.getWeightModifier('skill-a')).toBeLessThanOrEqual(0.50)
  })

  it('addSideEffectManifest tracks side effects', () => {
    const store = useFeedbackStore()
    store.addSideEffectManifest({ id: 'se-1', type: 'file_created', filePath: '/test.txt', timestamp: Date.now() })
    expect(store.sideEffects.length).toBe(1)
  })
})

describe('computeQueryFingerprint', () => {
  it('returns consistent fingerprint for same input', () => {
    const fp1 = computeQueryFingerprint('hello world')
    const fp2 = computeQueryFingerprint('hello world')
    expect(fp1).toBe(fp2)
  })

  it('returns different fingerprint for different input', () => {
    const fp1 = computeQueryFingerprint('hello')
    const fp2 = computeQueryFingerprint('world')
    expect(fp1).not.toBe(fp2)
  })

  it('returns string', () => {
    const fp = computeQueryFingerprint('test')
    expect(typeof fp).toBe('string')
    expect(fp.length).toBeGreaterThan(0)
  })

  it('removes stop words', () => {
    const fp1 = computeQueryFingerprint('帮我看看合同')
    const fp2 = computeQueryFingerprint('合同')
    expect(fp1).toContain('合同')
  })

  it('is case-insensitive', () => {
    const fp1 = computeQueryFingerprint('Hello World')
    const fp2 = computeQueryFingerprint('hello world')
    expect(fp1).toBe(fp2)
  })

  it('sorts tokens', () => {
    const fp1 = computeQueryFingerprint('b a')
    const fp2 = computeQueryFingerprint('a b')
    expect(fp1).toBe(fp2)
  })
})
