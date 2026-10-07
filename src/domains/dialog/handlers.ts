import type { HoloEventBus } from '@/kernel/bus'
import { useDialogStore } from '@/stores/dialogStore'
import { useNotificationStore } from '@/stores/notificationStore'

// A2-5：add-notice 经 emit() 发布 → 必须 on() 桥接（HMR 重挂载先释放旧订阅）
let _disposeNotice: (() => void) | null = null

export function registerDialogHandlers(bus: HoloEventBus) {
  bus.registerHandler('dialog:confirm-risk', async (payload) => {
    const store = useDialogStore()
    // P0-9：真实等待用户在确认条上裁决（requestRiskConfirm 5 分钟超时按拒绝）；
    // 任何链路异常一律按拒绝返回（fail-closed），绝不放行高危步骤
    try {
      return await store.requestRiskConfirm(payload.actionManifest)
    } catch {
      return false
    }
  })

  // O10（2026-09-22 用户裁决 B）：写类原生工具的授权裁决三态。
  // 返回 'deny' | 'once' | 'always'；任何链路异常一律 'deny'（fail-closed）。
  bus.registerHandler('dialog:confirm-write', async (payload) => {
    const store = useDialogStore()
    try {
      return await store.requestWriteConfirm({
        toolName: String(payload?.toolName || ''),
        operation: String(payload?.operation || '写操作'),
        target: String(payload?.target || '')
      })
    } catch {
      return 'deny'
    }
  })

  bus.registerHandler('dialog:set-mode', (payload) => {
    const store = useDialogStore()
    store.setMode(payload.mode)
  })

  // P1-24：DAG 暂停/接管此前只被 macroExecutor 轮询、无 handler 注册，
  // request 直接 throw 被吞 → 人工暂停/接管整体不可用。绑定 store 真实状态。
  bus.registerHandler('dialog:get-paused-state', () => {
    const store = useDialogStore()
    return {
      paused: store.dagPaused,
      pausedStep: store.dagPausedStep,
      awaitingTakeover: store.awaitingTakeover,
      takeoverStepNum: store.takeoverStepNum
    }
  })

  // V2-T02/T04：宏路径承接上下文的数据源——最近一条 assistant 文本产出（无则空串）。
  // 宏的每步 LLM 调用原先都不带会话历史，承接类请求（「把那份改成…」）无从指代。
  bus.registerHandler('dialog:get-recent-context', () => {
    const store = useDialogStore()
    try {
      return store.getRecentAssistantOutput()
    } catch {
      return ''
    }
  })

  bus.registerHandler('dialog:request-takeover', (payload) => {
    const store = useDialogStore()
    return store.requestTakeover(payload.stepNum)
  })

  // A2-5：运行时通知（步骤暂停等）回流通知中心，既有通知铃/状态栏消费，模板零改动；
  // 复用 tool_complete 通道与优先级映射，不新增 NotificationType（前端实用主义）
  const noticeHandler = (payload: unknown) => {
    const d = payload as { message?: string } | null
    if (!d?.message) return
    useNotificationStore().addNotification('tool_complete', '执行通知', d.message)
  }
  _disposeNotice?.()
  _disposeNotice = bus.on('dialog:add-notice', noticeHandler)
}
