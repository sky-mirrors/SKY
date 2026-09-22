// P0-C（A3 修复批）：会话归属/重入守卫/切换入口统一（G-16）回归测试。
// 背景：sendMessage 处理期间切换会话，异步管线的追加消息会写进切换后的会话（跨会话污染）；
// Enter 路径无 isProcessing 禁用可并发第二条 sendMessage；WorkbenchNav 切换直接别名赋值。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDialogStore } from '@/stores/dialogStore'
import { useSessionStore } from '@/stores/sessionStore'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'
import type { DialogMessage } from '@/models'

function makeMessage(content: string): DialogMessage {
  return {
    id: `msg-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'user',
    type: 'text',
    content,
    timestamp: Date.now()
  }
}

describe('P0-C 会话归属（G-16）', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
    setActivePinia(createPinia())
    globalBus.clear()
    // yieldToUI 依赖 rAF（node 环境无）
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('C1：处理期间切换会话后，追加消息路由回原会话（不进新会话活动数组）', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    const s1 = sessionStore.initOrLoad()
    // 模拟 sendMessage 入口捕获的请求级归属
    dialogStore.originSessionId = s1.id
    const s2 = sessionStore.createSession('会话2')
    sessionStore.switchToSession(s2.id, [])

    dialogStore.addSystemNotice('路由测试')

    // 不进当前活动数组
    expect(dialogStore.messages.some(m => m.content === '路由测试')).toBe(false)
    // 写入原会话存储并带归属标记
    const stored1 = sessionStore.sessions.find(s => s.id === s1.id)!
    expect(stored1.messages.some(m => m.content === '路由测试' && m.sessionId === s1.id)).toBe(true)
    // 新会话未被污染
    const stored2 = sessionStore.sessions.find(s => s.id === s2.id)!
    expect(stored2.messages.length).toBe(0)
  })

  it('C1：未切换会话时消息正常进活动数组（携带 sessionId 归属标记）', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    const s1 = sessionStore.initOrLoad()
    dialogStore.originSessionId = s1.id

    dialogStore.addSystemNotice('普通追加')

    expect(dialogStore.messages.some(m => m.content === '普通追加' && m.sessionId === s1.id)).toBe(true)
    const stored1 = sessionStore.sessions.find(s => s.id === s1.id)!
    expect(stored1.messages.some(m => m.content === '普通追加')).toBe(true)
  })

  it('C1：updateMessageContent 对已路由消息按 id 改写原会话存储', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    const s1 = sessionStore.initOrLoad()
    dialogStore.originSessionId = s1.id
    const s2 = sessionStore.createSession('会话2')
    sessionStore.switchToSession(s2.id, [])

    dialogStore.addSystemNotice('待改写')
    const stored1 = sessionStore.sessions.find(s => s.id === s1.id)!
    const routed = stored1.messages.find(m => m.content === '待改写')!
    expect(routed).toBeTruthy()

    dialogStore.updateMessageContent(routed.id, '已改写')
    expect(stored1.messages.find(m => m.id === routed.id)!.content).toBe('已改写')
  })

  it('C1：addUserMessage/addAssistantMessage/addThoughtMessage/addToolLogMessage 均按归属路由', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    const s1 = sessionStore.initOrLoad()
    dialogStore.originSessionId = s1.id
    const s2 = sessionStore.createSession('会话2')
    sessionStore.switchToSession(s2.id, [])

    dialogStore.addUserMessage('用户输入')
    dialogStore.addAssistantMessage('助手回复')
    dialogStore.addThoughtMessage([{ step: 1, thought: '思考', action: '行动', conclusion: '结论' } as never])
    dialogStore.addToolLogMessage({ toolName: 'read_file', status: 'success', params: {}, result: '' } as never)

    expect(dialogStore.messages.length).toBe(0)
    const stored1 = sessionStore.sessions.find(s => s.id === s1.id)!
    expect(stored1.messages.length).toBe(4)
    expect(stored1.messages.every(m => m.sessionId === s1.id)).toBe(true)
  })

  it('C3：isProcessing 期间 sendMessage 重入被拒（排队重发/考试除外）', async () => {
    const dialogStore = useDialogStore()
    dialogStore.isProcessing = true

    const r = await dialogStore.sendMessage('第二条消息')

    expect(r).toBe('')
    expect(dialogStore.messages.some(m => m.content.includes('上一条消息还在处理中'))).toBe(true)
    // 重入未生成新 traceId / 未吞掉提示
    expect(dialogStore.isProcessing).toBe(true)
  })

  it('C3：考试发题不被重入守卫吞（taskType=exam 放行进入后续流程）', async () => {
    const dialogStore = useDialogStore()
    dialogStore.isProcessing = true
    // exam 放行后会继续走后续流程（无 api handler 的测试环境会抛错/提示未配置），但绝不应被"还在处理中"拒绝
    await dialogStore.sendMessage('考试题', false, { taskType: 'exam' }).catch(() => {})
    expect(dialogStore.messages.some(m => m.content.includes('上一条消息还在处理中'))).toBe(false)
  })

  it('C4：switchSession 返回目标会话且断开数组别名（push 不改写会话存储）', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    sessionStore.initOrLoad()
    const s2 = sessionStore.createSession('会话2')

    const target = dialogStore.switchSession(s2.id)
    expect(target?.id).toBe(s2.id)
    expect(dialogStore.messages.length).toBe(0)

    // 别名断开：后续 push 只进活动数组，不直改会话存储
    dialogStore.messages.push(makeMessage('alias-test'))
    const stored2 = sessionStore.sessions.find(s => s.id === s2.id)!
    expect(stored2.messages.some(m => m.content === 'alias-test')).toBe(false)
  })

  it('C4：newSession 返回新建会话并复位处理态', () => {
    const dialogStore = useDialogStore()
    dialogStore.isProcessing = true

    const s = dialogStore.newSession('新会话')
    expect(s.name).toBe('新会话')
    expect(dialogStore.isProcessing).toBe(false)
    expect(dialogStore.messages.length).toBe(0)
  })

  it('C2：sessionStore appendSessionMessage/updateSessionMessage 对不存在会话安全 no-op', () => {
    const sessionStore = useSessionStore()
    const msg = makeMessage('孤儿消息')
    expect(() => sessionStore.appendSessionMessage('session-nonexistent', msg)).not.toThrow()
    expect(() => sessionStore.updateSessionMessage('session-nonexistent', msg.id, { content: 'x' })).not.toThrow()
    expect(() => sessionStore.updateSessionMessages('session-nonexistent', [msg])).not.toThrow()
  })

  // ===== F-2（修复批）：会话持久化单一事实源 =====

  it('F-2：saveToStorage 不再写 dialog/holo-dialog-messages（双写键退役，唯一事实源=session/holo-sessions）', () => {
    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    sessionStore.initOrLoad()

    dialogStore.addSystemNotice('F2消息A')

    // 旧双写键不再被写入
    expect(vault.readCache('dialog', 'holo-dialog-messages')).toBeNull()
    // 消息唯一持久化路径：活动会话存储
    const active = sessionStore.sessions.find(s => s.id === sessionStore.activeSessionId)!
    expect(active.messages.some(m => m.content === 'F2消息A')).toBe(true)
  })

  it('F-2：initSession 迁移遗留 dialog/holo-dialog-messages 进会话并删除旧键', async () => {
    // 老版本数据形态：旧双写键有消息、会话存储为空
    vault.writeCache('dialog', 'holo-dialog-messages', JSON.stringify([makeMessage('遗留消息')]))

    const dialogStore = useDialogStore()
    const sessionStore = useSessionStore()
    dialogStore.initSession()

    // 迁入活动会话
    expect(dialogStore.messages.some(m => m.content === '遗留消息')).toBe(true)
    const active = sessionStore.sessions.find(s => s.id === sessionStore.activeSessionId)!
    expect(active.messages.some(m => m.content === '遗留消息')).toBe(true)
    // 旧键删除（best-effort 异步删除，缓存同步移除）
    await new Promise(r => setTimeout(r, 0))
    expect(vault.readCache('dialog', 'holo-dialog-messages')).toBeNull()
  })

  it('F-2：initSession 恢复会话消息为拷贝——push 活动数组不污染会话存储', () => {
    const sessionStore = useSessionStore()
    const s1 = sessionStore.initOrLoad()
    sessionStore.updateSessionMessages(s1.id, [makeMessage('历史消息')])

    const dialogStore = useDialogStore()
    dialogStore.initSession()

    expect(dialogStore.messages.some(m => m.content === '历史消息')).toBe(true)
    // 拷贝断别名：活动数组 push 不改写会话存储
    dialogStore.messages.push(makeMessage('后来追加'))
    const stored = sessionStore.sessions.find(s => s.id === s1.id)!
    expect(stored.messages.some(m => m.content === '后来追加')).toBe(false)
  })
})
