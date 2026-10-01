import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDebugStore } from '@/stores/debugStore'
import { vault } from '@/vault'

/**
 * 2026-10-01（用户诉求：「token 预算和探针需要更细粒度，比如每轮对话的每个步骤都花费了多少 token」）。
 * 不变量：步骤成本键含 traceId（`traceId:stepNum`），跨轮同号步骤互不覆盖；
 * 无 traceId 落 `_:stepNum`；重复记录覆盖旧值；不同步骤号互不影响。
 * 背景：此前 stepCosts 用裸 stepNum 作键且**零写入方**（probeStep 查它恒 undefined），
 * 「每轮」维度根本不存在——本组测试锁定修复后的语义。
 */
const originalWindow = globalThis.window

beforeEach(() => {
  vault.clearCache()
  ;(globalThis as any).window = {
    electronAPI: {
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([])
    }
  }
  setActivePinia(createPinia())
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('步骤级 token 归因（每轮对话 × 每个步骤）', () => {
  it('同一 stepNum 在不同轮次（traceId）互不覆盖', () => {
    const s = useDebugStore()
    s.recordStepCost(1, 100, 10, 20, 'trace-A')
    s.recordStepCost(1, 200, 30, 40, 'trace-B')
    expect(s.getStepCost(1, 'trace-A')?.promptTokens).toBe(10)
    expect(s.getStepCost(1, 'trace-B')?.promptTokens).toBe(30)
    expect(Object.keys(s.stepCosts).sort()).toEqual(['trace-A:1', 'trace-B:1'])
  })

  it('无 traceId 时落 `_:stepNum` 键，仍可按 stepNum 取回', () => {
    const s = useDebugStore()
    s.recordStepCost(2, 50, 5, 7)
    expect(s.stepCosts['_:2']).toBeDefined()
    expect(s.getStepCost(2)?.completionTokens).toBe(7)
  })

  it('重复记录同一步骤覆盖旧值（取最新）', () => {
    const s = useDebugStore()
    s.recordStepCost(3, 10, 1, 1, 't')
    s.recordStepCost(3, 20, 2, 2, 't')
    expect(s.getStepCost(3, 't')?.durationMs).toBe(20)
    expect(s.getStepCost(3, 't')?.promptTokens).toBe(2)
  })

  it('不同步骤号互不影响', () => {
    const s = useDebugStore()
    s.recordStepCost(1, 10, 1, 1, 't')
    s.recordStepCost(2, 20, 2, 2, 't')
    expect(Object.keys(s.stepCosts).sort()).toEqual(['t:1', 't:2'])
  })

  it('同时记录 prompt/completion 与估算成本', () => {
    const s = useDebugStore()
    s.recordStepCost(1, 42, 128, 256, 't')
    const c = s.getStepCost(1, 't')!
    expect(c.promptTokens).toBe(128)
    expect(c.completionTokens).toBe(256)
    expect(c.durationMs).toBe(42)
    expect(typeof c.estimatedCostCny).toBe('number')
  })

  it('查不到时返回 undefined（不抛）', () => {
    const s = useDebugStore()
    expect(s.getStepCost(99, 'nope')).toBeUndefined()
    expect(s.getStepCost(99)).toBeUndefined()
  })
})
