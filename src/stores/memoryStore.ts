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
    try {
      const snapshotKey = `precompress-snapshot-${conv.projectId}-${Date.now()}`
      window.electronAPI.storeWrite(snapshotKey, JSON.stringify(conv.messages))
    } catch { /* snapshot non-critical */ }
  }

  const oldMessages = conv.messages.slice(0, Math.floor(conv.messages.length / 2))
  const recentMessages = conv.messages.slice(Math.floor(conv.messages.length / 2))

  const summaries = loadSummaries()
  const existingSummary = summaries[conv.projectId] || ''
  const oldContent = oldMessages.map(m => `${m.role}: ${m.content}`).join('\n')
  const newSummary = existingSummary
    ? `${existingSummary}\n[后续摘要] ${oldContent.slice(0, 500)}...`
    : `[对话摘要] ${oldContent.slice(0, 800)}...`

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

  function addDialogMessage(_msg: Omit<DialogMessage, 'id' | 'timestamp'>) {
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

  function archiveSession() {
    const raw = vault.readCache('memory', 'holo-session-archive') || '[]'
    try {
      const arr = JSON.parse(raw) as SessionMemory[]
      arr.push({ ...sessionMemory.value })
      if (arr.length > 20) arr.splice(0, arr.length - 20)
      vault.writeThrough('memory', 'holo-session-archive', JSON.stringify(arr))
    } catch { /* ignore */ }
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
    const rows = auditLogs.value.map(e =>
      `${e.id},${e.userId},${e.action},${e.toolId},${e.fileName || ''},${e.mcpId || ''},${e.timestamp},${e.details.replace(/,/g, ';')}`
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
    const conv = conversations.value.find(c => c.projectId === projectId)
    if (!conv) return
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
      try { sessionMemory.value = JSON.parse(s) as SessionMemory } catch { /* ignore */ }
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
    setProjectGroup,
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
