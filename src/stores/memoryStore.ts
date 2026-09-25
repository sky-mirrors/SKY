import { defineStore } from 'pinia'
import { ref } from 'vue'
import { SessionMemory, ProjectMemory, GlobalMemory, PromptTemplate, DialogMessage, ChatMessage, MemoryAdapter } from '@/models'
import { estimateTokens } from '@/services/tokenEstimate'
import { vault } from '@/vault'

const CONV_KEY = 'holo-conversations'
const SUMMARY_KEY = 'holo-conversation-summaries'
const TOKEN_BUDGET_DEFAULT = 4000

interface ConversationMemory {
  id: string
  projectId: string
  messages: ChatMessage[]
  fileFingerprints: string[]
  updatedAt: number
}

function loadConversations(): ConversationMemory[] {
  const raw = vault.readCache('memory', CONV_KEY)
  if (raw) {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

function saveConversations(convs: ConversationMemory[]) {
  vault.writeThrough('memory', CONV_KEY, JSON.stringify(convs))
}

function loadSummaries(): Record<string, string> {
  const raw = vault.readCache('memory', SUMMARY_KEY)
  if (raw) {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

function saveSummaries(summaries: Record<string, string>) {
  vault.writeThrough('memory', SUMMARY_KEY, JSON.stringify(summaries))
}

function compressOldMessages(convs: ConversationMemory[], conv: ConversationMemory): void {
  if (conv.messages.length < 10) return

  if (window.electronAPI?.storeWrite) {
    // C-24：storeWrite 返回 Promise，同步 try/catch 对 rejection 无效——
    // 必须挂 .catch，否则写入失败变成 unhandled rejection
    try {
      const snapshotKey = `precompress-snapshot-${conv.projectId}-${Date.now()}`
      window.electronAPI.storeWrite(snapshotKey, JSON.stringify(conv.messages))
        .catch(() => { /* snapshot non-critical */ })
    } catch { /* snapshot non-critical */ }
  }

  const oldMessages = conv.messages.slice(0, Math.floor(conv.messages.length / 2))
  const recentMessages = conv.messages.slice(Math.floor(conv.messages.length / 2))

  const summaries = loadSummaries()
  const existingSummary = summaries[conv.projectId] || ''
  const oldContent = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n')
  // C-24：不再对新增内容 slice(0,500) 静默丢弃（完整快照已另存）；
  // 摘要总量超限时从最旧端截断并显式标记，保留最新内容
  const MAX_SUMMARY_CHARS = 4000
  let newSummary = existingSummary
    ? `${existingSummary}\n[后续摘要] ${oldContent}`
    : `[对话摘要] ${oldContent}`
  if (newSummary.length > MAX_SUMMARY_CHARS) {
    newSummary = `[早期摘要已截断，完整快照见 precompress-snapshot] ${newSummary.slice(newSummary.length - MAX_SUMMARY_CHARS)}`
  }

  summaries[conv.projectId] = newSummary
  saveSummaries(summaries)

  conv.messages = recentMessages
  conv.updatedAt = Date.now()
  saveConversations(convs)
}

export const useMemoryStore = defineStore('memory', () => {
  const sessionMemory = ref<SessionMemory>({
    id: `session-${Date.now()}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const projectMemories = ref<ProjectMemory[]>([])
  const activeProjectId = ref<string | null>(null)

  const globalMemory = ref<GlobalMemory>({
    id: 'global',
    preferences: {},
    promptTemplates: [],
    frequentTerms: [],
    updatedAt: Date.now()
  })

  const mcpRequestLogs = ref<{ id: string; mcpId: string; toolName: string; request: string; response: string; timestamp: number; success: boolean }[]>([])
  const auditLogs = ref<{ id: string; userId: string; action: string; toolId: string; fileName?: string; mcpId?: string; timestamp: number; details: string }[]>([])

  const conversations = ref<ConversationMemory[]>(loadConversations())

  const MAX_SESSION_MESSAGES = 200

  function addDialogMessage(msg: Omit<DialogMessage, 'id' | 'timestamp'>) {
    // P1-41：此前实现丢弃 payload（`_msg` 未使用），对话消息从未落会话记忆
    const entry: DialogMessage = {
      ...msg,
      id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now()
    }
    if (!sessionMemory.value.messages) sessionMemory.value.messages = []
    sessionMemory.value.messages.push(entry)
    if (sessionMemory.value.messages.length > MAX_SESSION_MESSAGES) {
      sessionMemory.value.messages.splice(0, sessionMemory.value.messages.length - MAX_SESSION_MESSAGES)
    }
    sessionMemory.value.updatedAt = Date.now()
    saveSessionToStorage()
  }

  function clearSession() {
    sessionMemory.value = {
      id: `session-${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    saveSessionToStorage()
  }

  // 会话记忆归档：把一段会话记忆推入 vault holo-session-archive（保留最近 20 段）。
  // archiveSession（会话边界）与 loadFromStorage（进程重启）共用，避免两处各写一份。
  function pushSessionToArchive(session: SessionMemory) {
    const raw = vault.readCache('memory', 'holo-session-archive') || '[]'
    try {
      const arr = JSON.parse(raw) as SessionMemory[]
      arr.push(session)
      if (arr.length > 20) arr.splice(0, arr.length - 20)
      vault.writeThrough('memory', 'holo-session-archive', JSON.stringify(arr))
    } catch { /* ignore */ }
  }

  function archiveSession() {
    pushSessionToArchive({ ...sessionMemory.value })
    clearSession()
  }

  function addProjectMemory(name: string): ProjectMemory | null {
    if (projectMemories.value.find(p => p.name === name)) return null
    const pm: ProjectMemory = {
      id: `proj-${Date.now()}`,
      name,
      fileFingerprints: [],
      knowledgeEntryIds: [],
      vectorIndex: {},
      updatedAt: Date.now()
    }
    projectMemories.value.push(pm)
    saveProjectsToStorage()
    return pm
  }

  function addFileFingerprint(projectId: string, fingerprint: string) {
    const pm = projectMemories.value.find(p => p.id === projectId)
    if (pm && !pm.fileFingerprints.includes(fingerprint)) {
      pm.fileFingerprints.push(fingerprint)
      pm.updatedAt = Date.now()
      saveProjectsToStorage()
    }
  }

  function setProjectGroup(projectId: string, groupId: string | undefined) {
    const pm = projectMemories.value.find(p => p.id === projectId)
    if (pm) { pm.parentGroupId = groupId; pm.updatedAt = Date.now(); saveProjectsToStorage() }
  }

  function addKnowledgeEntry(projectId: string, entryId: string) {
    const pm = projectMemories.value.find(p => p.id === projectId)
    if (pm && !pm.knowledgeEntryIds.includes(entryId)) {
      pm.knowledgeEntryIds.push(entryId)
      pm.updatedAt = Date.now()
      saveProjectsToStorage()
    }
  }

  // C-16：条目删除时清除所有项目对它的悬空引用
  function removeKnowledgeEntryRef(entryId: string) {
    let changed = false
    for (const pm of projectMemories.value) {
      if (pm.knowledgeEntryIds.includes(entryId)) {
        pm.knowledgeEntryIds = pm.knowledgeEntryIds.filter(id => id !== entryId)
        pm.updatedAt = Date.now()
        changed = true
      }
    }
    if (changed) saveProjectsToStorage()
  }

  function getActiveProject(): ProjectMemory | null {
    if (!activeProjectId.value) return null
    return projectMemories.value.find(p => p.id === activeProjectId.value) ?? null
  }

  function setActiveProject(id: string | null) {
    activeProjectId.value = id
  }

  function addPromptTemplate(template: Omit<PromptTemplate, 'id' | 'createdAt'>) {
    const t: PromptTemplate = { ...template, id: `pt-${Date.now()}`, createdAt: Date.now() }
    globalMemory.value.promptTemplates.push(t)
    globalMemory.value.updatedAt = Date.now()
    saveGlobalToStorage()
  }

  function removePromptTemplate(id: string) {
    globalMemory.value.promptTemplates = globalMemory.value.promptTemplates.filter(t => t.id !== id)
    saveGlobalToStorage()
  }

  function setPreference(key: string, value: string) {
    globalMemory.value.preferences[key] = value
    globalMemory.value.updatedAt = Date.now()
    saveGlobalToStorage()
  }

  function addFrequentTerm(term: string) {
    if (!globalMemory.value.frequentTerms.includes(term)) {
      globalMemory.value.frequentTerms.push(term)
      if (globalMemory.value.frequentTerms.length > 100) {
        globalMemory.value.frequentTerms.shift()
      }
      saveGlobalToStorage()
    }
  }

  function addMcpRequestLog(log: { mcpId: string; toolName: string; request: string; response: string; success: boolean }) {
    mcpRequestLogs.value.unshift({
      id: `mcplog-${Date.now()}`,
      ...log,
      timestamp: Date.now()
    })
    if (mcpRequestLogs.value.length > 100) mcpRequestLogs.value = mcpRequestLogs.value.slice(0, 100)
    saveMcpLogsToStorage()
  }

  function addAuditLog(entry: { userId: string; action: string; toolId: string; fileName?: string; mcpId?: string; details: string }) {
    auditLogs.value.unshift({
      id: `audit-${Date.now()}`,
      ...entry,
      timestamp: Date.now()
    })
    if (auditLogs.value.length > 500) auditLogs.value = auditLogs.value.slice(0, 500)
    saveAuditLogsToStorage()
  }

  function exportAuditCsv(): string {
    const header = 'id,userId,action,toolId,fileName,mcpId,timestamp,details'
    // C-28：完整 CSV 转义——含引号/逗号/换行/CRLF 的字段必须整体加引号并把内部引号翻倍，
    // 仅把逗号替换为分号会破坏 CSV 结构且丢失原内容
    const escapeCsv = (field: string | number): string => {
      const s = String(field ?? '')
      if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }
    const rows = auditLogs.value.map(e =>
      [e.id, e.userId, e.action, e.toolId, e.fileName || '', e.mcpId || '', e.timestamp, e.details].map(escapeCsv).join(',')
    )
    return [header, ...rows].join('\n')
  }

  // === Unified conversation memory (was in memory.ts) ===

  function getOrCreateConversation(projectId: string): ConversationMemory {
    let conv = conversations.value.find(c => c.projectId === projectId)
    if (!conv) {
      conv = {
        id: `conv-${Date.now()}`,
        projectId,
        messages: [],
        fileFingerprints: [],
        updatedAt: Date.now()
      }
      conversations.value.push(conv)
      saveConversations(conversations.value)
    }
    return conv
  }

  function addConvMessage(projectId: string, message: ChatMessage): void {
    // C-14：会话不存在时自动创建——原实现静默 return，pipelineExecutor 的
    // addMessage('default',...) 首条消息会被吞掉
    const conv = getOrCreateConversation(projectId)
    conv.messages.push(message)
    conv.updatedAt = Date.now()
    saveConversations(conversations.value)

    if (estimateTokens(conv.messages.map(m => m.content).join('')) > TOKEN_BUDGET_DEFAULT * 1.5) {
      compressOldMessages(conversations.value, conv)
    }
  }

  function addConvFileFingerprint(projectId: string, fingerprint: string): void {
    const conv = conversations.value.find(c => c.projectId === projectId)
    if (!conv) return
    if (!conv.fileFingerprints.includes(fingerprint)) {
      conv.fileFingerprints.push(fingerprint)
      conv.updatedAt = Date.now()
      saveConversations(conversations.value)
    }
  }

  function getRecentMessages(projectId: string, limit: number = 20): ChatMessage[] {
    const conv = getOrCreateConversation(projectId)
    return conv.messages.slice(-limit)
  }

  function getContextWindow(projectId: string, tokenBudget: number = TOKEN_BUDGET_DEFAULT): { messages: ChatMessage[]; summary: string } {
    const conv = getOrCreateConversation(projectId)
    const summaries = loadSummaries()
    const existingSummary = summaries[projectId] || ''

    const recentMessages = conv.messages.slice(-50)
    let totalTokens = estimateTokens(existingSummary)
    const selected: ChatMessage[] = []

    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i]
      const msgTokens = estimateTokens(msg.content)
      if (totalTokens + msgTokens > tokenBudget) break
      totalTokens += msgTokens
      selected.unshift(msg)
    }

    return { messages: selected, summary: existingSummary }
  }

  function summarizeOld(projectId: string, tokenBudget: number = TOKEN_BUDGET_DEFAULT): string {
    const { summary } = getContextWindow(projectId, tokenBudget)
    return summary
  }

  const memoryAdapter: MemoryAdapter = {
    getRecent(projectId, tokenBudget) {
      const { messages, summary } = getContextWindow(projectId, tokenBudget || TOKEN_BUDGET_DEFAULT)
      if (summary) {
        return [{ role: 'system' as const, content: `[上下文摘要] ${summary}`, timestamp: Date.now() }, ...messages]
      }
      return messages
    },
    addMessage(projectId, role, content) {
      addConvMessage(projectId, { role: role as 'system' | 'user' | 'assistant', content, timestamp: Date.now() })
    },
    summarizeOld(projectId, tokenBudget) {
      return summarizeOld(projectId, tokenBudget || TOKEN_BUDGET_DEFAULT)
    }
  }

  function saveSessionToStorage() {
    vault.writeThrough('memory', 'holo-session', JSON.stringify(sessionMemory.value))
  }

  function saveProjectsToStorage() {
    vault.writeThrough('memory', 'holo-projects', JSON.stringify(projectMemories.value))
  }

  function saveGlobalToStorage() {
    vault.writeThrough('memory', 'holo-global-memory', JSON.stringify(globalMemory.value))
  }

  function saveMcpLogsToStorage() {
    vault.writeThrough('memory', 'holo-mcp-logs', JSON.stringify(mcpRequestLogs.value))
  }

  function saveAuditLogsToStorage() {
    vault.writeThrough('memory', 'holo-audit-logs', JSON.stringify(auditLogs.value))
  }

  function loadFromStorage() {
    const s = vault.readCache('memory', 'holo-session')
    if (s) {
      // HANDOFF 下一步 4：会话记忆按「会话」隔离——进程重启即新会话。上一次运行残留的会话记忆
      // （正常关窗不经过会话边界）**不恢复进本次运行**（否则会经 apiStore 的 buildSessionMemoryPrefix
      // 作为「会话记忆」注入新会话上下文，曾实测含陈旧字符串 20260924）；把它归档到
      // holo-session-archive（不丢），本次运行从 store 初始化时的全新会话开始。
      try {
        const persisted = JSON.parse(s) as SessionMemory
        if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
          pushSessionToArchive(persisted)
        }
      } catch { /* ignore */ }
      // 本次运行从全新会话开始，并即时落盘覆盖 vault 里的旧值（避免下次启动再读到）
      clearSession()
    }
    const p = vault.readCache('memory', 'holo-projects')
    if (p) {
      try { projectMemories.value = JSON.parse(p) as ProjectMemory[] } catch { /* ignore */ }
    }
    const g = vault.readCache('memory', 'holo-global-memory')
    if (g) {
      try { globalMemory.value = JSON.parse(g) as GlobalMemory } catch { /* ignore */ }
    }
    const ml = vault.readCache('memory', 'holo-mcp-logs')
    if (ml) {
      try { mcpRequestLogs.value = JSON.parse(ml) as typeof mcpRequestLogs.value } catch { /* ignore */ }
    }
    const al = vault.readCache('memory', 'holo-audit-logs')
    if (al) {
      try { auditLogs.value = JSON.parse(al) as typeof auditLogs.value } catch { /* ignore */ }
    }
    conversations.value = loadConversations()
  }

  return {
    sessionMemory,
    projectMemories,
    activeProjectId,
    globalMemory,
    mcpRequestLogs,
    auditLogs,
    conversations,
    addDialogMessage,
    clearSession,
    archiveSession,
    addProjectMemory,
    addFileFingerprint,
    addKnowledgeEntry,
    removeKnowledgeEntryRef,
    setProjectGroup,
    saveProjectsToStorage,
    getActiveProject,
    setActiveProject,
    addPromptTemplate,
    removePromptTemplate,
    setPreference,
    addFrequentTerm,
    addMcpRequestLog,
    addAuditLog,
    exportAuditCsv,
    getOrCreateConversation,
    addConvMessage,
    addConvFileFingerprint,
    getRecentMessages,
    getContextWindow,
    summarizeOld,
    memoryAdapter,
    loadFromStorage
  }
})
