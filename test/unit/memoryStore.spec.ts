import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMemoryStore } from '@/stores/memoryStore'
import { vault } from '@/vault'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

describe('memoryStore', () => {
  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct initial state', () => {
    const store = useMemoryStore()
    expect(store.projectMemories).toEqual([])
    expect(store.activeProjectId).toBeNull()
    expect(store.mcpRequestLogs).toEqual([])
    expect(store.auditLogs).toEqual([])
  })

  it('addProjectMemory creates a new project', () => {
    const store = useMemoryStore()
    const project = store.addProjectMemory('Test Project')
    expect(project).not.toBeNull()
    expect(project!.name).toBe('Test Project')
    expect(store.projectMemories.length).toBe(1)
  })

  it('setActiveProject and getActiveProject work', () => {
    const store = useMemoryStore()
    const project = store.addProjectMemory('Active Test')
    store.setActiveProject(project!.id)
    expect(store.activeProjectId).toBe(project!.id)
    const active = store.getActiveProject()
    expect(active).not.toBeNull()
    expect(active!.id).toBe(project!.id)
    store.setActiveProject(null)
    expect(store.activeProjectId).toBeNull()
  })

  it('addFileFingerprint adds fingerprint to project', () => {
    const store = useMemoryStore()
    const project = store.addProjectMemory('FP Test')
    store.addFileFingerprint(project!.id, 'fp-abc123')
    expect(store.projectMemories[0].fileFingerprints).toContain('fp-abc123')
  })

  it('addKnowledgeEntry adds entry to project', () => {
    const store = useMemoryStore()
    const project = store.addProjectMemory('KE Test')
    store.addKnowledgeEntry(project!.id, 'entry-1')
    expect(store.projectMemories[0].knowledgeEntryIds).toContain('entry-1')
  })

  it('setPreference stores global preference', () => {
    const store = useMemoryStore()
    store.setPreference('language', 'zh-CN')
    expect(store.globalMemory.preferences['language']).toBe('zh-CN')
  })

  it('addFrequentTerm adds term', () => {
    const store = useMemoryStore()
    store.addFrequentTerm('合同')
    expect(store.globalMemory.frequentTerms).toContain('合同')
  })

  it('addPromptTemplate adds template', () => {
    const store = useMemoryStore()
    store.addPromptTemplate({ name: 'Test Template', content: 'Hello {{name}}' })
    expect(store.globalMemory.promptTemplates.length).toBe(1)
    expect(store.globalMemory.promptTemplates[0].name).toBe('Test Template')
  })

  it('removePromptTemplate removes by id', () => {
    const store = useMemoryStore()
    store.addPromptTemplate({ name: 'ToRemove', content: 'test' })
    const id = store.globalMemory.promptTemplates[0].id
    store.removePromptTemplate(id)
    expect(store.globalMemory.promptTemplates.length).toBe(0)
  })

  it('addMcpRequestLog stores log entry', () => {
    const store = useMemoryStore()
    store.addMcpRequestLog({
      mcpId: 'mcp-1',
      toolName: 'test_tool',
      request: 'test request',
      response: 'test response',
      success: true
    })
    expect(store.mcpRequestLogs.length).toBe(1)
    expect(store.mcpRequestLogs[0].mcpId).toBe('mcp-1')
  })

  it('addAuditLog stores audit entry', () => {
    const store = useMemoryStore()
    store.addAuditLog({
      userId: 'user-1',
      action: 'execute',
      toolId: 'tool-1',
      details: 'test action'
    })
    expect(store.auditLogs.length).toBe(1)
    expect(store.auditLogs[0].action).toBe('execute')
  })

  it('exportAuditCsv returns string', () => {
    const store = useMemoryStore()
    store.addAuditLog({
      userId: 'user-1',
      action: 'execute',
      toolId: 'tool-1',
      details: 'test'
    })
    const csv = store.exportAuditCsv()
    expect(typeof csv).toBe('string')
    expect(csv.length).toBeGreaterThan(0)
  })

  it('getOrCreateConversation creates new if not exists', () => {
    const store = useMemoryStore()
    const conv = store.getOrCreateConversation('project-1')
    expect(conv).toBeDefined()
    expect(conv.projectId).toBe('project-1')
  })

  it('getOrCreateConversation returns existing conversation', () => {
    const store = useMemoryStore()
    const conv1 = store.getOrCreateConversation('project-1')
    const conv2 = store.getOrCreateConversation('project-1')
    expect(conv1.id).toBe(conv2.id)
  })

  it('addConvMessage adds message to conversation', () => {
    const store = useMemoryStore()
    store.getOrCreateConversation('project-1')
    store.addConvMessage('project-1', { role: 'user', content: 'hello', timestamp: Date.now() })
    const recent = store.getRecentMessages('project-1')
    expect(recent.length).toBe(1)
    expect(recent[0].content).toBe('hello')
  })

  it('getRecentMessages returns limited messages', () => {
    const store = useMemoryStore()
    store.getOrCreateConversation('project-1')
    for (let i = 0; i < 10; i++) {
      store.addConvMessage('project-1', { role: 'user', content: `msg-${i}`, timestamp: Date.now() + i })
    }
    const recent = store.getRecentMessages('project-1', 3)
    expect(recent.length).toBe(3)
  })

  it('addConvFileFingerprint adds fingerprint to conversation', () => {
    const store = useMemoryStore()
    store.getOrCreateConversation('project-1')
    store.addConvFileFingerprint('project-1', 'fp-test')
    const conv = store.conversations.find(c => c.projectId === 'project-1')
    expect(conv!.fileFingerprints).toContain('fp-test')
  })

  it('clearSession resets sessionMemory', () => {
    const store = useMemoryStore()
    store.clearSession()
    expect(store.sessionMemory.id).toBeDefined()
  })

  // G-16 残留（2026-09-25 修复）：archiveSession 此前全仓零调用方、只被它调用的 clearSession 同样零调用。
  // 现在它挂在会话边界（dialogStore.newSession / clearCurrentSession），成为真实路径。
  it('archiveSession 重置会话记忆且不抛（归档写入 vault holo-session-archive）', () => {
    const store = useMemoryStore()
    const beforeId = store.sessionMemory.id
    store.addDialogMessage({ role: 'user', type: 'text', content: '归档前的会话消息' })
    expect((store.sessionMemory.messages || []).length).toBeGreaterThan(0)
    expect(() => store.archiveSession()).not.toThrow()
    expect(store.sessionMemory.id).not.toBe(beforeId)
    expect(store.sessionMemory.messages || []).toEqual([])
  })

  it('setProjectGroup assigns group to project', () => {
    const store = useMemoryStore()
    const project = store.addProjectMemory('Group Test')
    store.setProjectGroup(project!.id, 'group-1')
    expect(store.projectMemories[0].parentGroupId).toBe('group-1')
    store.setProjectGroup(project!.id, undefined)
    expect(store.projectMemories[0].parentGroupId).toBeUndefined()
  })

  // HANDOFF 下一步 4：会话记忆按「会话」隔离——进程重启即新会话。上一次运行残留的会话记忆
  // （正常关窗不经过会话边界）不得恢复进本次运行，否则会经 apiStore 的 buildSessionMemoryPrefix
  // 作为「会话记忆」注入新会话上下文（曾实测含陈旧字符串 20260924）。
  it('loadFromStorage 不把上一次运行的会话记忆恢复进本次运行（会话隔离）', () => {
    vault.clearCache()
    const store = useMemoryStore()
    store.addDialogMessage({ role: 'user', type: 'text', content: '陈旧消息20260924' })
    expect((store.sessionMemory.messages || []).length).toBe(1)

    // 模拟进程重启：重新从 vault 加载
    store.loadFromStorage()

    // 本次运行应是全新会话，不含上一次运行的消息
    expect(store.sessionMemory.messages || []).toEqual([])
    // 旧会话不丢——归档到 holo-session-archive
    const archive = JSON.parse(vault.readCache('memory', 'holo-session-archive') || '[]') as { messages?: { content?: string }[] }[]
    expect(archive.some(s => (s.messages || []).some(m => m.content === '陈旧消息20260924'))).toBe(true)
  })
})
