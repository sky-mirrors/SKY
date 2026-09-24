/**
 * O10 写类原生工具的权限边界（2026-09-22 用户裁决 B）。
 *
 * 裁决原文：「写类走风险确认条、读保持恒可用」——模型的文件**写**能力
 * （file_write / file_move / create_docx）须经既有风险确认路径；read_file /
 * list_directory 维持恒可用。默认 **fail-closed**：授权读取失败、确认链断裂、
 * 用户未表态，一律按拒绝处理，绝不放行写操作。
 *
 * 三态（用户裁决语义）：拒绝 / 本次允许 / 该类操作始终允许（按工具分别记录、
 * 可撤销）。撤销入口见 DialogPanel 的授权管理。
 *
 * 为什么需要本模块：确认条机制（dialog:confirm-risk → requestRiskConfirm）原先
 * 只在 executeStep 内、且仅当 LLM 审核判 risk_level === 'high' 时才触发；而工具
 * 回路里的工具执行走 callToolDirectWithTier（不经 executeStep）——运行时实测
 * Q15 的 file_move 就这样无任何确认地执行了（HANDOFF 卡点 3「实际风险已发生」）。
 */

import { globalBus } from '@/kernel/bus'

/** 受本边界约束的写类原生工具 */
export const WRITE_TOOLS = ['file_write', 'file_move', 'create_docx'] as const
export type WriteTool = (typeof WRITE_TOOLS)[number]
export type WriteDecision = 'deny' | 'once' | 'always'

const GRANT_STORE_KEY = 'write-tool-grants'

/** 确认条上展示的「操作」文案 */
export const WRITE_TOOL_LABELS: Record<string, string> = {
  file_write: '写入/覆盖文件',
  file_move: '重命名/移动文件',
  create_docx: '生成 Word 文档'
}

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name)
}

let _grants: Record<string, boolean> | null = null

/** 读取已持久化的授权；任何异常一律视为「无授权」（fail-closed） */
export async function loadWriteGrants(): Promise<Record<string, boolean>> {
  if (_grants) return _grants
  try {
    const raw = await window.electronAPI?.storeRead?.(GRANT_STORE_KEY)
    const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const clean: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) if (v === true) clean[k] = true
    _grants = clean
  } catch {
    _grants = {}
  }
  return _grants
}

/** 读类工具与未知工具不受本边界约束（返回 true = 无需确认） */
export async function isWriteToolGranted(name: string): Promise<boolean> {
  if (!isWriteTool(name)) return true
  const grants = await loadWriteGrants()
  return grants[name] === true
}

/** 用户选择「始终允许该类操作」→ 持久化（写盘失败不阻塞本次，仅内存生效） */
export async function grantWriteTool(name: string): Promise<void> {
  const grants = { ...(await loadWriteGrants()), [name]: true }
  _grants = grants
  try {
    await window.electronAPI?.storeWrite?.(GRANT_STORE_KEY, grants)
  } catch {
    /* 内存态已生效；下次启动需重新授权（偏保守，符合 fail-closed） */
  }
}

/** 撤销授权：给 name 撤销单个、缺省撤销全部；返回撤销后的授权表 */
export async function revokeWriteGrant(name?: string): Promise<Record<string, boolean>> {
  const grants = { ...(await loadWriteGrants()) }
  if (name) delete grants[name]
  else for (const k of Object.keys(grants)) delete grants[k]
  _grants = grants
  try {
    await window.electronAPI?.storeWrite?.(GRANT_STORE_KEY, grants)
  } catch {
    /* 同 grantWriteTool */
  }
  return grants
}

/** 测试/会话重置：清内存缓存（不动持久化） */
export function resetWriteGrantCache(): void {
  _grants = null
}

/** 确认条上展示的「目标」——把工具参数渲染成人可读的路径描述 */
export function describeWriteTarget(name: string, args: Record<string, unknown>): string {
  if (name === 'file_move') {
    const from = String(args.from || args.fromPath || '')
    const to = String(args.to || args.toPath || '')
    if (from && to) return `${from} → ${to}`
    return from || to || '(未提供路径)'
  }
  return String(args.filePath || args.path || args.to || '(未提供路径)')
}

/**
 * 请求用户裁决一次写类操作；返回 true = 放行。
 * fail-closed：确认链断裂 / 抛错 / 用户未表态 → false。
 *
 * 这是 O10 的**唯一裁决入口**——两处工具执行路径都经此：
 *   ① macroExecutor.callToolDirectWithTier（宏步骤 + 工具回路 + dialogStore 直调）
 *   ② dialogStore.executeToolCall（MCP 直达快速路径的 toolCalls，走 executeMcpToolCalls）
 * 若各写一份判定，两条路径的行为迟早漂移（② 正是首轮端到端验证暴露出的漏网路径）。
 */
export async function requestWriteApproval(
  toolName: string,
  args: Record<string, unknown>
): Promise<boolean> {
  if (!isWriteTool(toolName)) return true
  if (await isWriteToolGranted(toolName)) return true
  let decision: WriteDecision = 'deny'
  try {
    decision = (await globalBus.requestAsync<WriteDecision>('dialog:confirm-write', {
      toolName,
      operation: WRITE_TOOL_LABELS[toolName] || `执行 ${toolName}`,
      target: describeWriteTarget(toolName, args)
    })) || 'deny'
  } catch {
    decision = 'deny'
  }
  if (decision === 'always') {
    await grantWriteTool(toolName)
    return true
  }
  return decision === 'once'
}
