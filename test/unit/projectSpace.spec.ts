import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useSessionStore } from '@/stores/sessionStore'
import { createProjectSpace } from '@/services/projectSpace'

/**
 * 2026-10-01 用户诉求：「新建项目空间可以把多个会话和多个知识库合为一个知识库和多个会话，
 * 但原知识库应该保持不变」。
 * 不变量：① 新分组 sharedEntryIds = 所选各库并集（去重）；② 原分组一字不变；
 * ③ 所选会话改指新分组；④ 项目空间记录 sessionIds；⑤ 项目名去重；⑥ 空选择不报错。
 */
const originalWindow = globalThis.window

beforeEach(() => {
  vault.clearCache()
  ;(globalThis as any).window = {
    electronAPI: {
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([])
    }
  }
  setActivePinia(createPinia())
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('createProjectSpace —— 合并式新建项目空间', () => {
  it('新分组的 sharedEntryIds = 所选各库并集（去重）', () => {
    const ks = useKnowledgeStore()
    const g1 = ks.createGroup('库一')!
    const g2 = ks.createGroup('库二')!
    ks.addSharedEntryToGroup(g1.id, 'e1')
    ks.addSharedEntryToGroup(g1.id, 'e2')
    ks.addSharedEntryToGroup(g2.id, 'e2') // 与 g1 有交集
    ks.addSharedEntryToGroup(g2.id, 'e3')

    const r = createProjectSpace({ name: '合并空间', sessionIds: [], groupIds: [g1.id, g2.id] })
    expect(r).not.toBeNull()
    expect([...r!.group.sharedEntryIds].sort()).toEqual(['e1', 'e2', 'e3'])
  })

  it('原知识库保持不变（不改动任何一个原分组）', () => {
    const ks = useKnowledgeStore()
    const g1 = ks.createGroup('库一')!
    const g2 = ks.createGroup('库二')!
    ks.addSharedEntryToGroup(g1.id, 'e1')
    ks.addSharedEntryToGroup(g2.id, 'e2')

    createProjectSpace({ name: '空间', sessionIds: [], groupIds: [g1.id, g2.id] })

    const after1 = ks.knowledgeGroups.find(g => g.id === g1.id)!
    const after2 = ks.knowledgeGroups.find(g => g.id === g2.id)!
    expect(after1.sharedEntryIds).toEqual(['e1'])
    expect(after2.sharedEntryIds).toEqual(['e2'])
    expect(ks.knowledgeGroups.length).toBe(3) // 原两库 + 新库
  })

  it('所选会话的 knowledgeGroupId 改指新分组', () => {
    const ss = useSessionStore()
    const s1 = ss.createSession('会话一')
    const s2 = ss.createSession('会话二')
    const ks = useKnowledgeStore()
    const g = ks.createGroup('库')!

    const r = createProjectSpace({ name: '空间', sessionIds: [s1.id, s2.id], groupIds: [g.id] })

    expect(ss.sessions.find(s => s.id === s1.id)!.knowledgeGroupId).toBe(r!.group.id)
    expect(ss.sessions.find(s => s.id === s2.id)!.knowledgeGroupId).toBe(r!.group.id)
  })

  it('项目空间记录 sessionIds 与 parentGroupId', () => {
    const ss = useSessionStore()
    const s1 = ss.createSession('会话一')
    const r = createProjectSpace({ name: '空间', sessionIds: [s1.id], groupIds: [] })
    expect(r!.project.sessionIds).toEqual([s1.id])
    expect(r!.project.parentGroupId).toBe(r!.group.id)
  })

  it('项目名重复时返回 null 且不新增分组/项目', () => {
    const ms = useMemoryStore()
    ms.addProjectMemory('已存在')
    const ks = useKnowledgeStore()
    const before = ks.knowledgeGroups.length

    expect(createProjectSpace({ name: '已存在', sessionIds: [], groupIds: [] })).toBeNull()
    expect(ks.knowledgeGroups.length).toBe(before)
    expect(ms.projectMemories.length).toBe(1)
  })

  it('未选任何知识库时新分组为空且不报错', () => {
    const r = createProjectSpace({ name: '空空间', sessionIds: [], groupIds: [] })
    expect(r).not.toBeNull()
    expect(r!.group.sharedEntryIds).toEqual([])
  })

  it('传入不存在的 groupId 时跳过（不抛错）', () => {
    const r = createProjectSpace({ name: '空间', sessionIds: [], groupIds: ['group-not-exist'] })
    expect(r).not.toBeNull()
    expect(r!.group.sharedEntryIds).toEqual([])
  })
})
