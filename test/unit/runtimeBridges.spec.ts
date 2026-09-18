import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { globalBus } from '@/kernel/bus'
import { registerFeedbackHandlers } from '@/domains/feedback/handlers'
import { registerDialogHandlers } from '@/domains/dialog/handlers'
import { useFeedbackStore } from '@/stores/feedbackStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { vault } from '@/vault'

// dialogStore 依赖面大，本测试只断言 notice → notificationStore 桥接 → mock 掉
vi.mock('@/stores/dialogStore', () => ({
  useDialogStore: () => ({
    requestRiskConfirm: vi.fn(),
    setMode: vi.fn(),
    requestTakeover: vi.fn(),
    dagPaused: false,
    dagPausedStep: null,
    awaitingTakeover: false,
    takeoverStepNum: null
  })
}))

describe('A2-5 runtime bridges（emit 频道 → store 接线）', () => {
  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
        storeRead: vi.fn().mockResolvedValue(null),
        storeWrite: vi.fn().mockResolvedValue(undefined)
      }
    })
    setActivePinia(createPinia())
    registerFeedbackHandlers(globalBus)
    registerDialogHandlers(globalBus)
  })

  it('feedback:add-side-effect emit → feedbackStore 入列且字段对齐（undoExecution 数据源）', () => {
    const payload = {
      executionId: 'exec-1',
      manifestId: 'm-finance-1',
      userInput: '帮我记账',
      queryFingerprint: 'fp-1',
      sideEffects: [{
        stepNum: 1, tool: 'file_write', operation: 'create',
        filePath: 'a.txt', originalExisted: false, timestamp: 1
      }],
      timestamp: 123
    }
    globalBus.emit('feedback:add-side-effect', payload)

    const store = useFeedbackStore()
    expect(store.sideEffects).toHaveLength(1)
    expect(store.sideEffects[0]).toMatchObject({ executionId: 'exec-1', manifestId: 'm-finance-1' })
    expect(store.getLatestSideEffect('exec-1')?.sideEffects).toHaveLength(1)
  })

  it('feedback:add-side-effect 畸形 payload → 静默丢弃不炸', () => {
    globalBus.emit('feedback:add-side-effect', { executionId: 123 })
    globalBus.emit('feedback:add-side-effect', null)
    globalBus.emit('feedback:add-side-effect', { executionId: 'e', sideEffects: 'not-array' })
    expect(useFeedbackStore().sideEffects).toHaveLength(0)
  })

  it('dialog:add-notice emit → notificationStore 通知（复用 tool_complete 通道）', () => {
    globalBus.emit('dialog:add-notice', { message: '⏸️ 步骤2(file_write)已暂停，等待操作...' })

    const store = useNotificationStore()
    expect(store.notifications).toHaveLength(1)
    expect(store.notifications[0]).toMatchObject({
      type: 'tool_complete',
      message: '⏸️ 步骤2(file_write)已暂停，等待操作...'
    })
    expect(store.unreadCount).toBe(1)
  })

  it('重复注册（HMR 重挂载）不重复消费', () => {
    registerFeedbackHandlers(globalBus)
    registerDialogHandlers(globalBus)

    globalBus.emit('dialog:add-notice', { message: 'x' })
    globalBus.emit('feedback:add-side-effect', {
      executionId: 'e', manifestId: 'm', userInput: '', queryFingerprint: '', sideEffects: [], timestamp: 1
    })

    expect(useNotificationStore().notifications).toHaveLength(1)
    expect(useFeedbackStore().sideEffects).toHaveLength(1)
  })
})
