import { defineStore } from 'pinia'
import { ref } from 'vue'
import { KnowledgeGroup, ProjectMemory } from '@/models'
import { vault } from '@/vault'
import { useMemoryStore } from '@/stores/memoryStore'

const GROUPS_KEY = 'holo-knowledge-groups'

export const useKnowledgeStore = defineStore('knowledge', () => {
  const knowledgeGroups = ref<KnowledgeGroup[]>([])
  const storageMode = ref<'local' | 'file'>('local')
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
      id: `group-${Date.now()}`,
      name,
      sharedEntryIds: [],
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
    createGroup,
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
