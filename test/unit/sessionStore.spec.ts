import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/sessionStore'
import type { DialogMessage } from '@/models'
import { vault } from '@/vault'

function makeMessage(role: 'user' | 'assistant' | 'system', content: string): DialogMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    type: 'text',
    content,
    timestamp: Date.now()
  }
}

describe('sessionStore', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
      }
    })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initOrLoad创建默认会话', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    expect(session.id).toBeTruthy()
    expect(session.name).toBe('默认会话')
    expect(session.status).toBe('active')
    expect(store.activeSessionId).toBe(session.id)
  })

  it('createSession新增会话', () => {
    const store = useSessionStore()
    store.initOrLoad()
    const s2 = store.createSession('测试会话')
    expect(s2.name).toBe('测试会话')
    expect(store.sessions.length).toBe(2)
  })

  it('switchToSession切换并保存当前消息', () => {
    const store = useSessionStore()
    const s1 = store.initOrLoad()
    const s2 = store.createSession('会话2')

    const msgs: DialogMessage[] = [makeMessage('user', 'hello')]
    const target = store.switchToSession(s2.id, msgs)
    expect(target).not.toBeNull()
    expect(target!.id).toBe(s2.id)
    expect(store.activeSessionId).toBe(s2.id)

    const prev = store.sessions.find(s => s.id === s1.id)
    expect(prev!.messages.length).toBe(1)
  })

  it('clearSession清空消息', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    session.messages = [makeMessage('user', 'test')]
    store.clearSession(session.id)
    expect(session.messages.length).toBe(0)
  })

  it('archiveSession标记为archived', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    store.archiveSession(session.id)
    expect(session.status).toBe('archived')
  })

  it('deleteSession删除会话', () => {
    const store = useSessionStore()
    store.initOrLoad()
    const s2 = store.createSession('会话2')
    store.deleteSession(s2.id)
    expect(store.sessions.length).toBe(1)
    expect(store.sessions.find(s => s.id === s2.id)).toBeUndefined()
  })

  it('renameSession改名', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    store.renameSession(session.id, '新名字')
    expect(session.name).toBe('新名字')
  })

  it('exportSessionQA输出对话式Markdown', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    session.messages = [
      makeMessage('user', '帮我审合同'),
      makeMessage('assistant', '已审查，风险点如下...'),
      { id: 'sys1', role: 'system', type: 'system_notice', content: '系统消息', timestamp: Date.now() }
    ]
    const md = store.exportSessionQA(session.id)
    expect(md).toContain('帮我审合同')
    expect(md).toContain('已审查')
    expect(md).not.toContain('系统消息')
    expect(md).toContain('用户')
    expect(md).toContain('助手')
  })

  it('exportSessionNarrative输出整合式', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    session.messages = [
      makeMessage('user', '帮我审合同'),
      makeMessage('assistant', '已审查，风险点如下...')
    ]
    const md = store.exportSessionNarrative(session.id)
    expect(md).toContain('已审查')
    expect(md).not.toContain('用户')
    expect(md).not.toContain('助手')
  })

  it('updateActiveMessages更新当前会话消息', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    const msgs = [makeMessage('user', 'updated')]
    store.updateActiveMessages(msgs)
    expect(session.messages.length).toBe(1)
    expect(session.messages[0].content).toBe('updated')
  })

  it('exportHistory记录导出历史', () => {
    const store = useSessionStore()
    const session = store.initOrLoad()
    session.messages = [makeMessage('user', 'test')]
    store.exportSessionQA(session.id)
    expect(session.exportHistory.length).toBe(1)
    expect(session.exportHistory[0].mode).toBe('qa')
  })
})
