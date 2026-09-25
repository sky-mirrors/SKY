// G-16（B）接线：memoryStore.sessionMemory 此前「只写不读」——它由 dialogStore 经
// `memory:add-dialog-message` 累积、持久化到 vault `holo-session`、启动读回，但除 memoryStore
// 自身外全仓零读取（快照 §〇 已核实）。用户裁定「接线进对话上下文」。
//
// 本模块把会话记忆转成一段可注入对话上下文的 `[会话记忆]` system 前缀，注入点与门控对齐既有的
// `[用户偏好]` 注入先例（apiStore.chatCompletion，P0-C5/F-1）：exam/benchmark 隔离、结构化输出
// （提示词含「只输出JSON」）跳过、防重复注入。
//
// 去重策略：会话记忆存的是**全文**，而当前对话上下文（buildChatHistory 的窗口）可能存的是
// 截断过的 displayContent，且两者本就包含同一批消息（dialogStore 同时写入 messages 与 sessionMemory）。
// 故构造前缀时既按 role+前缀精确去重，也按 role+前 80 字重叠去重，避免把本轮窗口重复注入。

export interface MemoryMessageLike {
  role: string
  content: string
}

const DEFAULT_LIMIT = 8
const MAX_ITEM_CHARS = 400
const OVERLAP_CHARS = 80

function norm(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

function overlap(a: string, b: string): boolean {
  if (!a || !b) return false
  const n = Math.min(a.length, b.length, OVERLAP_CHARS)
  return a.slice(0, n) === b.slice(0, n)
}

/**
 * 由会话记忆构造 `[会话记忆]` system 前缀。
 * - 仅取含文本的 user / assistant 消息；
 * - 与当前对话上下文（currentMessages）去重，避免重复注入本轮窗口；
 * - 取最近 `limit` 条，单条截断 MAX_ITEM_CHARS 字符；
 * - 无可用内容时返回 null（调用方据此跳过注入，不产生空 system 消息、不影响缓存键）。
 */
export function buildSessionMemoryPrefix(
  memoryMessages: MemoryMessageLike[],
  currentMessages: MemoryMessageLike[],
  limit: number = DEFAULT_LIMIT
): string | null {
  const current = (currentMessages || [])
    .filter(m => m && m.content)
    .map(m => ({ role: m.role, text: norm(m.content) }))

  const seen = new Set(current.map(m => `${m.role}::${m.text.slice(0, OVERLAP_CHARS)}`))

  const picked: string[] = []
  const mem = memoryMessages || []
  for (let i = mem.length - 1; i >= 0 && picked.length < limit; i--) {
    const m = mem[i]
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const content = norm(m.content)
    if (!content) continue

    const key = `${m.role}::${content.slice(0, OVERLAP_CHARS)}`
    if (seen.has(key)) continue
    if (current.some(c => c.role === m.role && overlap(c.text, content))) continue

    seen.add(key)
    const who = m.role === 'user' ? '用户' : '助手'
    const body = content.length > MAX_ITEM_CHARS ? content.slice(0, MAX_ITEM_CHARS) + '…' : content
    picked.unshift(`${who}：${body}`)
  }

  if (picked.length === 0) return null
  return '[会话记忆]\n以下是此前与用户的对话记录（可能来自更早的会话），供你延续上下文时参考：\n' + picked.join('\n')
}
