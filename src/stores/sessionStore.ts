import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { DialogMessage } from '@/models'

export interface Session {
  id: string
  name: string
  messages: DialogMessage[]
  createdAt: number
  updatedAt: number
  status: 'active' | 'archived'
  exportHistory: { mode: 'qa' | 'narrative'; exportedAt: number; path?: string }[]
  knowledgeGroupId?: string
  attachedEntryIds: string[]
}

const SESSIONS_KEY = 'holo-sessions'
const ACTIVE_SESSION_KEY = 'holo-active-session'

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveSessions(sessions: Session[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
  } catch {
    console.warn('[SessionStore] localStorage写入失败')
  }
}

function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY)
  } catch { return null }
}

function saveActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id)
    else localStorage.removeItem(ACTIVE_SESSION_KEY)
  } catch { /* ignore */ }
}

  function ensureSessionFields(session: Session): void {
    if (!session.attachedEntryIds) session.attachedEntryIds = []
  }

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>(loadSessions().map(s => { ensureSessionFields(s); return s }))
  const activeSessionId = ref<string | null>(loadActiveId())

  const activeSession = computed(() => {
    return sessions.value.find(s => s.id === activeSessionId.value) ?? null
  })

  const activeSessions = computed(() => {
    return sessions.value.filter(s => s.status === 'active')
  })

  function createSession(name?: string): Session {
    const session: Session = {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || `会话 ${sessions.value.length + 1}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'active',
      exportHistory: [],
      attachedEntryIds: []
    }
    sessions.value.push(session)
    saveSessions(sessions.value)
    return session
  }

  function switchToSession(sessionId: string, currentMessages: DialogMessage[]): Session | null {
    if (sessionId === activeSessionId.value) return null

    if (activeSessionId.value) {
      const prev = sessions.value.find(s => s.id === activeSessionId.value)
      if (prev) {
        prev.messages = currentMessages
        prev.updatedAt = Date.now()
      }
    }

    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return null

    activeSessionId.value = sessionId
    saveActiveId(sessionId)
    saveSessions(sessions.value)
    return target
  }

  function clearSession(sessionId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.messages = []
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function archiveSession(sessionId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.status = 'archived'
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function deleteSession(sessionId: string): void {
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    if (activeSessionId.value === sessionId) {
      const firstActive = sessions.value.find(s => s.status === 'active')
      activeSessionId.value = firstActive?.id ?? null
      saveActiveId(activeSessionId.value)
    }
    saveSessions(sessions.value)
  }

  function renameSession(sessionId: string, name: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.name = name
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function updateActiveMessages(messages: DialogMessage[]): void {
    const session = sessions.value.find(s => s.id === activeSessionId.value)
    if (!session) return
    session.messages = messages
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function exportSessionQA(sessionId: string): string {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || session.messages.length === 0) return ''

    const lines: string[] = [`# ${session.name}`, '']

    for (const msg of session.messages) {
      if (msg.type === 'system_notice') continue
      const role = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统'
      const time = new Date(msg.timestamp).toLocaleString('zh-CN')
      lines.push(`### ${role} (${time})`)
      lines.push(msg.content || '(空)')
      lines.push('')
    }

    const record = { mode: 'qa' as const, exportedAt: Date.now() }
    session.exportHistory.push(record)
    saveSessions(sessions.value)

    return lines.join('\n')
  }

  function exportSessionNarrative(sessionId: string): string {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || session.messages.length === 0) return ''

    const lines: string[] = [`# ${session.name}`, '']

    let narrative = ''
    for (const msg of session.messages) {
      if (msg.type === 'system_notice') continue
      if (msg.role === 'user') {
        if (narrative) {
          lines.push(narrative.trim())
          lines.push('')
        }
        narrative = ''
      } else if (msg.role === 'assistant') {
        narrative += (narrative ? '\n\n' : '') + (msg.content || '')
      }
    }
    if (narrative) {
      lines.push(narrative.trim())
    }

    const record = { mode: 'narrative' as const, exportedAt: Date.now() }
    session.exportHistory.push(record)
    saveSessions(sessions.value)

    return lines.join('\n')
  }

  function initOrLoad(): Session {
    if (sessions.value.length === 0) {
      const session = createSession('默认会话')
      activeSessionId.value = session.id
      saveActiveId(session.id)
      return session
    }

    const saved = loadActiveId()
    if (saved && sessions.value.find(s => s.id === saved && s.status === 'active')) {
      activeSessionId.value = saved
      return sessions.value.find(s => s.id === saved)!
    }

    const first = sessions.value.find(s => s.status === 'active')
    if (first) {
      activeSessionId.value = first.id
      saveActiveId(first.id)
      return first
    }

    const session = createSession('新会话')
    activeSessionId.value = session.id
    saveActiveId(session.id)
    return session
  }

  function saveToFile(content: string, filename: string): void {
    if (!content) return
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function exportAndDownload(sessionId: string, mode: 'qa' | 'narrative'): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const content = mode === 'qa' ? exportSessionQA(sessionId) : exportSessionNarrative(sessionId)
    const ext = 'md'
    const suffix = mode === 'qa' ? '对话式' : '整合式'
    const dateStr = new Date().toISOString().slice(0, 10)
    saveToFile(content, `${session.name}_${suffix}_${dateStr}.${ext}`)
  }

  function countDialogRounds(msgs: DialogMessage[]): number {
    let rounds = 0
    for (const m of msgs) {
      if (m.role === 'user') rounds++
    }
    return rounds
  }

  function connectKnowledge(sessionId: string, groupId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.knowledgeGroupId = groupId
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function disconnectKnowledge(sessionId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.knowledgeGroupId = undefined
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  function addSessionEntry(sessionId: string, entryId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    if (!session.attachedEntryIds) session.attachedEntryIds = []
    if (!session.attachedEntryIds.includes(entryId)) {
      session.attachedEntryIds.push(entryId)
      session.updatedAt = Date.now()
      saveSessions(sessions.value)
    }
  }

  function removeSessionEntry(sessionId: string, entryId: string): void {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session || !session.attachedEntryIds) return
    session.attachedEntryIds = session.attachedEntryIds.filter(id => id !== entryId)
    session.updatedAt = Date.now()
    saveSessions(sessions.value)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeSessions,
    countDialogRounds,
    createSession,
    switchToSession,
    clearSession,
    archiveSession,
    deleteSession,
    renameSession,
    updateActiveMessages,
    exportSessionQA,
    exportSessionNarrative,
    exportAndDownload,
    initOrLoad,
    saveToFile,
    connectKnowledge,
    disconnectKnowledge,
    addSessionEntry,
    removeSessionEntry
  }
})
