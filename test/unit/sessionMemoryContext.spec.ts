import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildSessionMemoryPrefix } from '@/services/sessionMemoryContext'

// G-16（B）：会话记忆接线——source 级行为用例。会话记忆存全文，当前上下文可能是截断展示，
// 两者本就包含同一批消息，故去重是本模块的核心不变量。
describe('sessionMemoryContext · buildSessionMemoryPrefix', () => {
  it('空记忆 / 无可注入消息时返回 null（不产生空 system 前缀）', () => {
    expect(buildSessionMemoryPrefix([], [])).toBeNull()
    expect(buildSessionMemoryPrefix([{ role: 'tool', content: 'x' }], [])).toBeNull()
    expect(buildSessionMemoryPrefix([{ role: 'user', content: '   ' }], [])).toBeNull()
  })

  it('按时间顺序输出，最近的一条在最后', () => {
    const prefix = buildSessionMemoryPrefix(
      [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '第二句' }
      ],
      []
    )
    expect(prefix).toContain('[会话记忆]')
    expect(prefix!.indexOf('用户：第一句')).toBeLessThan(prefix!.indexOf('助手：第二句'))
  })

  it('与当前对话上下文去重——同一批消息不再重复注入', () => {
    // dialogStore 同时把消息写进 messages 与 sessionMemory；当前窗口里已有的不应再注入
    const prefix = buildSessionMemoryPrefix(
      [
        { role: 'user', content: '上一个问题' },
        { role: 'assistant', content: '上一个回答' }
      ],
      [
        { role: 'user', content: '上一个问题' },
        { role: 'assistant', content: '上一个回答' }
      ]
    )
    expect(prefix).toBeNull()
  })

  it('跨源重叠去重——会话记忆存全文、当前上下文存截断展示时不重复注入', () => {
    const full = 'A'.repeat(300)
    const truncated = 'A'.repeat(200) + '…'
    const prefix = buildSessionMemoryPrefix(
      [{ role: 'assistant', content: full }],
      [{ role: 'assistant', content: truncated }]
    )
    expect(prefix).toBeNull()
  })

  it('只保留最近 limit 条', () => {
    const mem = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `msg-${i}` }))
    const prefix = buildSessionMemoryPrefix(mem, [], 3)
    expect(prefix).toContain('msg-19')
    expect(prefix).toContain('msg-18')
    expect(prefix).toContain('msg-17')
    expect(prefix).not.toContain('msg-16')
  })

  it('超长单条被截断，不整段灌入', () => {
    const prefix = buildSessionMemoryPrefix([{ role: 'user', content: 'x'.repeat(1000) }], [])
    expect(prefix).toBeTruthy()
    expect(prefix!.length).toBeLessThan(1000)
    expect(prefix).toContain('…')
  })
})

// 源码级接线断言：守住「sessionMemory 真的被读进对话上下文」这条不变量，防回退为只写不读。
describe('G-16（B）接线：apiStore 主路径注入会话记忆前缀', () => {
  const src = readFileSync(join(process.cwd(), 'src/stores/apiStore.ts'), 'utf-8')

  it('chatCompletion 读取 sessionMemory.messages 并经 buildSessionMemoryPrefix 注入', () => {
    expect(src).toContain('buildSessionMemoryPrefix')
    expect(src).toContain('sessionMemory?.messages')
    expect(src).toContain('[会话记忆]')
  })

  it('门控与偏好注入同款：exam/benchmark 隔离 + 结构化输出跳过', () => {
    expect(src).toContain('isLearningIsolated')
    expect(src).toContain('只输出JSON')
  })
})

// G-16 残留（2026-09-25 修复）：memoryStore.archiveSession 此前是死函数。若会话边界不再调用它，
// 会话记忆又会退化为「只增不减、永不归档」——本条守住它被真实调用。
describe('G-16 残留：archiveSession 在会话边界被调用', () => {
  const dialog = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
  const calls = dialog.match(/useMemoryStore\(\)\.archiveSession\(\)/g) || []

  it('newSession 与 clearCurrentSession 两处会话边界都归档会话记忆', () => {
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(dialog).toContain('function clearCurrentSession')
  })
})
