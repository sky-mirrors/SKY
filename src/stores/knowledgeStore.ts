import { defineStore } from 'pinia'
import { ref } from 'vue'
import { KnowledgeGroup, ProjectMemory } from '@/models'

const GROUPS_KEY = 'holo-knowledge-groups'

export const useKnowledgeStore = defineStore('knowledge', () => {
  const knowledgeGroups = ref<KnowledgeGroup[]>([])

  function saveGroupsToStorage() {
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(knowledgeGroups.value)) } catch { /* ignore */ }
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(GROUPS_KEY)
      if (raw) knowledgeGroups.value = JSON.parse(raw) as KnowledgeGroup[]
    } catch { /* ignore */ }
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
    if (projectMemories) {
      for (const pm of projectMemories) {
        if (pm.parentGroupId === groupId) pm.parentGroupId = undefined
      }
    }
    saveGroupsToStorage()
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

  function getGroupProjects(groupId: string, projectMemories: ProjectMemory[]): ProjectMemory[] {
    return projectMemories.filter(p => p.parentGroupId === groupId)
  }

  return {
    knowledgeGroups,
    createGroup,
    deleteGroup,
    renameGroup,
    addSharedEntryToGroup,
    removeSharedEntryFromGroup,
    getGroupProjects,
    saveGroupsToStorage,
    loadFromStorage
  }
})
