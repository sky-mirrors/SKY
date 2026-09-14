import type { HoloEventBus } from '@/kernel/bus'
import { useMemoryStore } from '@/stores/memoryStore'
import type { DialogMessage } from '@/models'

// HoloEventBus.emit() 只达 bus.on() 监听器、registerHandler() 仅 request() 可达；
// memory:* 频道全部走 emit() 发布（且 payload 为扁平结构），故必须桥接 on()

let _disposeDialogMsg: (() => void) | null = null
let _disposeAudit: (() => void) | null = null
let _disposeMcpLog: (() => void) | null = null

export function registerMemoryHandlers(bus: HoloEventBus) {
  bus.registerHandler('memory:get-recent', (payload) => {
    const store = useMemoryStore()
    return store.getRecentMessages(payload.projectId, payload.limit)
  })

  // P1-41：对话消息落会话记忆（此前 emit 无任何消费者）
  const addDialogMsgHandler = (payload: Omit<DialogMessage, 'id' | 'timestamp'> & { traceId?: string }) => {
    if (!payload?.role) return
    const store = useMemoryStore()
    store.addDialogMessage(payload)
  }
  bus.registerHandler('memory:add-dialog-message', addDialogMsgHandler)
  _disposeDialogMsg?.()
  _disposeDialogMsg = bus.on('memory:add-dialog-message', addDialogMsgHandler as (payload: unknown) => unknown)

  // P1-42：审计事件（此前 emit 无任何消费者）
  const addAuditHandler = (payload: { userId?: string; action?: string; toolId?: string; fileName?: string; mcpId?: string; details?: string }) => {
    if (!payload?.action) return
    const store = useMemoryStore()
    store.addAuditLog({
      userId: payload.userId || 'local',
      action: payload.action,
      toolId: payload.toolId || '',
      fileName: payload.fileName,
      mcpId: payload.mcpId,
      details: payload.details || ''
    })
  }
  bus.registerHandler('memory:add-audit-log', addAuditHandler)
  _disposeAudit?.()
  _disposeAudit = bus.on('memory:add-audit-log', addAuditHandler as (payload: unknown) => unknown)

  // A2-3：MCP 请求日志——原 handler 期望 { log } 包装而所有发射方均为扁平 payload，永不可达
  const addMcpLogHandler = (payload: { mcpId?: string; toolName?: string; request?: string; response?: string; success?: boolean } | { log: { mcpId: string; toolName: string; request: string; response: string; success: boolean } }) => {
    const entry = 'log' in payload ? payload.log : payload
    if (!entry?.mcpId) return
    const store = useMemoryStore()
    store.addMcpRequestLog({
      mcpId: entry.mcpId,
      toolName: entry.toolName || '',
      request: entry.request || '',
      response: entry.response || '',
      success: !!entry.success
    })
  }
  bus.registerHandler('memory:add-mcp-log', addMcpLogHandler)
  _disposeMcpLog?.()
  _disposeMcpLog = bus.on('memory:add-mcp-log', addMcpLogHandler as (payload: unknown) => unknown)
}
