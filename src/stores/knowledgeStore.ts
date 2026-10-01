import { defineStore } from 'pinia'
import { ref } from 'vue'
import { KnowledgeGroup, ProjectMemory } from '@/models'
import { vault } from '@/vault'
import { useMemoryStore } from '@/stores/memoryStore'

const GROUPS_KEY = 'holo-knowledge-groups'

export const useKnowledgeStore = defineStore('knowledge', () => {
  const knowledgeGroups = ref<KnowledgeGroup[]>([])
  const storageMode = ref<'local' | 'file'>('local')
  /**
   * 2026-10-01（用户反馈：知识库窗口看不到别处新增的文件，需改用响应式）：
   * 知识条目本身存在 knowledgeBase 的模块级数组里、**不经过 store**，因此主窗增删条目时
   * 独立窗口无从知晓。这里引入一个单调递增的「变更信号」：knowledgeBase 在增删后 emit 事件
   * → 本 store 自增 → 经既有跨窗口 store 镜像同步到知识库窗口 → 该窗口 watch 它重新拉取列表。
   * 选版本号而非把条目搬进 store：改动面最小，且不触碰既有的条目存储与检索路径。
   */
  const entriesVersion = ref(0)
  function bumpEntriesVersion() { entriesVersion.value++ }
  function saveGroupsToStorage() {
    vault.writeThrough('knowledge', GROUPS_KEY, JSON.stringify(knowledgeGroups.value))
  }

  function loadFromStorage() {
    const raw = vault.readCache('knowledge', GROUPS_KEY)
    if (raw) {
      try { knowledgeGroups.value = JSON.parse(raw) as KnowledgeGroup[] } catch { /* ignore */ }
    }
  }

  function createGroup(name: string): KnowledgeGroup | null {
    if (knowledgeGroups.value.find(g => g.name === name)) return null
    const g: KnowledgeGroup = {
      // 2026-10-01：补随机后缀——原先 `group-${Date.now()}` 在同一毫秒内建两个组会撞 id
      // （被 projectSpace.spec 的原库不变断言暴露：两组被当成同一组）
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      sharedEntryIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    knowledgeGroups.value.push(g)
    saveGroupsToStorage()
    return g
  }

  /**
   * 2026-10-01（用户裁定）：合并式新建知识库——用给定条目集合建一个**新**分组（自动去重）。
   * 与 createGroup 的差异：取唯一名（重名自动加后缀）且直接填充 sharedEntryIds。
   * 供「新建项目空间」把多个知识库合并为一个新库用；调用方保证**不改动任何原分组**。
   */
  function createGroupWithEntries(name: string, entryIds: string[]): KnowledgeGroup {
    let finalName = name
    let suffix = 2
    while (knowledgeGroups.value.find(g => g.name === finalName)) {
      finalName = `${name} (${suffix++})`
    }
    const g: KnowledgeGroup = {
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: finalName,
      sharedEntryIds: Array.from(new Set(entryIds)),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    knowledgeGroups.value.push(g)
    saveGroupsToStorage()
    return g
  }

  function deleteGroup(groupId: string, projectMemories?: ProjectMemory[]) {
    knowledgeGroups.value = knowledgeGroups.value.filter(g => g.id !== groupId)
    let touchedProjects = false
    if (projectMemories) {
      for (const pm of projectMemories) {
        if (pm.parentGroupId === groupId) {
          pm.parentGroupId = undefined
          pm.updatedAt = Date.now()
          touchedProjects = true
        }
      }
    }
    saveGroupsToStorage()
    // C-20：清理 parentGroupId 后必须持久化项目列表——否则重启后项目"复活"
    // 挂回已删除的分组
    if (touchedProjects) {
      try { useMemoryStore().saveProjectsToStorage() } catch { /* store 未就绪 */ }
    }
  }

  function renameGroup(groupId: string, name: string) {
    const g = knowledgeGroups.value.find(g => g.id === groupId)
    if (g) { g.name = name; g.updatedAt = Date.now(); saveGroupsToStorage() }
  }

  function addSharedEntryToGroup(groupId: string, entryId: string) {
    const g = knowledgeGroups.value.find(g => g.id === groupId)
    if (g && !g.sharedEntryIds.includes(entryId)) {
      g.sharedEntryIds.push(entryId)
      g.updatedAt = Date.now()
      saveGroupsToStorage()
    }
  }

  function removeSharedEntryFromGroup(groupId: string, entryId: string) {
    const g = knowledgeGroups.value.find(g => g.id === groupId)
    if (g) {
      g.sharedEntryIds = g.sharedEntryIds.filter(id => id !== entryId)
      g.updatedAt = Date.now()
      saveGroupsToStorage()
    }
  }

  // C-16：条目删除时清除所有分组对它的悬空共享引用
  function removeSharedEntryEverywhere(entryId: string) {
    let changed = false
    for (const g of knowledgeGroups.value) {
      if (g.sharedEntryIds.includes(entryId)) {
        g.sharedEntryIds = g.sharedEntryIds.filter(id => id !== entryId)
        g.updatedAt = Date.now()
        changed = true
      }
    }
    if (changed) saveGroupsToStorage()
  }

  function getGroupProjects(groupId: string, projectMemories: ProjectMemory[]): ProjectMemory[] {
    return projectMemories.filter(p => p.parentGroupId === groupId)
  }

  return {
    knowledgeGroups,
    storageMode,
    entriesVersion,
    bumpEntriesVersion,
    createGroup,
    createGroupWithEntries,
    deleteGroup,
    renameGroup,
    addSharedEntryToGroup,
    removeSharedEntryFromGroup,
    removeSharedEntryEverywhere,
    getGroupProjects,
    saveGroupsToStorage,
    loadFromStorage
  }
})
