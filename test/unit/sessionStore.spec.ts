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

  // P0-C2：请求级会话归属路由原语
  it('appendSessionMessage追加消息到指定会话（跨会话路由写入）', () => {
    const store = useSessionStore()
    const s1 = store.initOrLoad()
    const s2 = store.createSession('会话2')
    store.switchToSession(s2.id, [])

    const routed = makeMessage('assistant', '原会话的响应')
    routed.sessionId = s1.id
    store.appendSessionMessage(s1.id, routed)

    expect(s1.messages.some(m => m.content === '原会话的响应')).toBe(true)
    expect(s2.messages.length).toBe(0)
    // 持久化往返：新 store 实例从 vault 恢复后消息仍在
    const saved = JSON.parse(vault.readCache('session', 'holo-sessions')!)
    const savedS1 = saved.find((s: { id: string }) => s.id === s1.id)
    expect(savedS1.messages.some((m: DialogMessage) => m.content === '原会话的响应')).toBe(true)
  })

  it('updateSessionMessage按id改写指定会话消息（流式补写/docx附件改写）', () => {
    const store = useSessionStore()
    const s1 = store.initOrLoad()
    const msg = makeMessage('assistant', '生成中...')
    store.appendSessionMessage(s1.id, msg)

    store.updateSessionMessage(s1.id, msg.id, { content: '已完成', fileAttachment: { fileName: 'a.docx', filePath: 'C:\\a.docx', fileType: 'docx' } })

    const updated = s1.messages.find(m => m.id === msg.id)!
    expect(updated.content).toBe('已完成')
    expect(updated.fileAttachment?.fileName).toBe('a.docx')
  })

  it('updateSessionMessages全量替换指定会话消息（拷贝断别名）', () => {
    const store = useSessionStore()
    const s1 = store.initOrLoad()
    const source: DialogMessage[] = [makeMessage('user', 'v2')]
    store.updateSessionMessages(s1.id, source)
    expect(s1.messages[0].content).toBe('v2')
    // 拷贝断别名：改源数组不回写会话存储
    source[0].content = 'mutated'
    expect(s1.messages[0].content).toBe('v2')
  })
})
