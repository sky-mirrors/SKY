import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { globalBus } from '@/kernel/bus'
import { useDebugStore } from '@/stores/debugStore'
import { registerDebugHandlers } from '@/domains/debug/handlers'

/**
 * /debug 斜杠命令（dialogStore.sendMessage）会 emit 4 条广播：
 *   debug:activate / debug:deactivate / debug:update-environment / debug:unfreeze-buffer
 * 而真正的开关是 debugStore 的方法（App.vue / DialogPanel / DebugWindowPage 直接调）。
 * 若这 4 条无人监听，`/debug` 就只会打印"调试模式已开启"却什么都没发生——谎报。
 */
describe('debug 域：/debug 命令的 4 条频道必须接线到 debugStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerDebugHandlers(globalBus)
  })

  it('debug:activate → debugStore.enabled = true', () => {
    const store = useDebugStore()
    expect(store.enabled).toBe(false)
    globalBus.emit('debug:activate', {})
    expect(store.enabled).toBe(true)
  })

  it('debug:deactivate → debugStore.enabled = false', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    expect(store.enabled).toBe(true)
    globalBus.emit('debug:deactivate', {})
    expect(store.enabled).toBe(false)
  })

  it('debug:update-environment → 当前调试会话的 environment 被更新', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    globalBus.emit('debug:update-environment', {
      environment: { model: 'qwen2.5:3b', provider: 'ollama', apiReachable: true, nodeCount: 125, manifestCount: 27 }
    })
    const env = (store as unknown as { currentSession: { environment: Record<string, unknown> } | null }).currentSession?.environment
    expect(env?.model).toBe('qwen2.5:3b')
    expect(env?.nodeCount).toBe(125)
  })

  it('debug:unfreeze-buffer → 冻结缓冲被解除', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    ;(store as unknown as { frozen: boolean }).frozen = true
    globalBus.emit('debug:unfreeze-buffer', {})
    expect((store as unknown as { frozen: boolean }).frozen).toBe(false)
  })
})

/**
 * 机制体检（2026-09-25）：constraintFeedback 的自治写侧在跑（factGuard → processConstraintResults），
 * 但结果无处可见。服务在每次记录/清空反馈时 emit 审计快照，此处验证它真的进了 debugStore
 * （再经 storeSync 镜像到独立的调试台窗口面板）。
 */
describe('debug 域：约束反馈自治审计频道接线', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerDebugHandlers(globalBus)
  })

  it('debug:constraint-feedback → debugStore.constraintFeedbackStats', () => {
    const store = useDebugStore()
    expect(store.constraintFeedbackStats).toEqual([])
    const snapshot = [{
      constraintId: 'legal-employment-protection',
      totalEvaluations: 12,
      falsePositives: 5,
      truePositives: 7,
      falsePositiveRate: 5 / 12,
      recentEvaluations: 12,
      recentFalsePositiveRate: 5 / 12,
      status: 'active' as const,
      lastEvaluated: 123,
      autonomy: 'downgrade' as const
    }]
    globalBus.emit('debug:constraint-feedback', snapshot)
    expect(store.constraintFeedbackStats).toHaveLength(1)
    expect(store.constraintFeedbackStats[0].constraintId).toBe('legal-employment-protection')
    expect(store.constraintFeedbackStats[0].autonomy).toBe('downgrade')
  })

  it('非数组 payload 被忽略（防脏广播破坏 store 状态）', () => {
    const store = useDebugStore()
    globalBus.emit('debug:constraint-feedback', { bad: true })
    expect(store.constraintFeedbackStats).toEqual([])
  })
})
