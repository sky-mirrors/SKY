import { describe, it, expect, vi } from 'vitest'

/**
 * ZOL 持久化：learner 的自适应状态必须在 init 时从 vault 加载（防「度量在跑、学习从不发生」）
 *
 * 根因（2026-10-07 实测）：`ZeroTokenLearner.initFromVault()` 全库无人调用（死代码），
 * 而构造期的 `loadState()` 走 `vault.readCache`——模块初始化时缓存是冷的 ⇒ 每次启动
 * outcomes/thresholds 都从零开始。后果：`outcomes.length % adjustWindow(20)` 永远到不了，
 * 阈值恒为默认值。实测证据：`mechanismStats.routing.thresholds` 与默认逐字一致，
 * 而 `holo-routing-history` 已有 103 条、overkillRate 43.7% —— 即「省 token 的自学习」从不生效。
 *
 * 本测试用「冷缓存 + 已有持久化状态」复现该条件：init 后阈值必须是持久化值，而非默认值。
 */
const { PERSISTED } = vi.hoisted(() => ({
  PERSISTED: {
    thresholds: { inputLength_trivial: 130, inputLength_simple: 650 },
    outcomes: Array.from({ length: 20 }, () => ({
      decisionPoint: 'routing',
      selectedStrategy: 'mini',
      outcome: 'overkill',
      timestamp: Date.now(),
      contextSnapshot: {}
    }))
  }
}))

vi.mock('@/vault', () => ({
  vault: {
    read: vi.fn(async (ns: string, key: string) =>
      ns === 'zol' && key === 'holo-zol-routing' ? JSON.stringify(PERSISTED) : null),
    // 关键：模拟「启动期冷缓存」——原 bug 的触发条件
    readCache: vi.fn(() => null),
    writeThrough: vi.fn(),
    delete: vi.fn(async () => {})
  }
}))

import { initSmartRouter, getAdaptiveThresholds } from '@/services/smartRouter'

describe('ZOL 持久化：init 时必须加载 learner 状态', () => {
  it('initSmartRouter 后自适应阈值反映持久化值（650），而非默认值（500）', async () => {
    await initSmartRouter()
    const t = getAdaptiveThresholds()
    expect(t.inputLength.simple).toBe(650)
    expect(t.inputLength.trivial).toBe(130)
  })
})
