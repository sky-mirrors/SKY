import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { vault } from '@/vault'

describe('knowledgeStore', () => {
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

  it('starts with empty knowledgeGroups', () => {
    const store = useKnowledgeStore()
    expect(store.knowledgeGroups).toEqual([])
  })

  it('createGroup adds a new group', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('Test Group')
    expect(group).not.toBeNull()
    expect(group!.name).toBe('Test Group')
    expect(group!.id).toBeDefined()
    expect(store.knowledgeGroups.length).toBe(1)
  })

  it('createGroup creates group even with empty name', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('')
    expect(group).not.toBeNull()
    expect(group!.name).toBe('')
  })

  it('deleteGroup removes a group', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('To Delete')
    expect(store.knowledgeGroups.length).toBe(1)
    store.deleteGroup(group!.id)
    expect(store.knowledgeGroups.length).toBe(0)
  })

  it('renameGroup updates group name', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('Original')
    store.renameGroup(group!.id, 'Renamed')
    expect(store.knowledgeGroups[0].name).toBe('Renamed')
  })

  it('addSharedEntryToGroup adds entry ID', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('Group1')
    store.addSharedEntryToGroup(group!.id, 'entry-1')
    expect(store.knowledgeGroups[0].sharedEntryIds).toContain('entry-1')
  })

  it('removeSharedEntryFromGroup removes entry ID', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('Group1')
    store.addSharedEntryToGroup(group!.id, 'entry-1')
    store.addSharedEntryToGroup(group!.id, 'entry-2')
    store.removeSharedEntryFromGroup(group!.id, 'entry-1')
    expect(store.knowledgeGroups[0].sharedEntryIds).toEqual(['entry-2'])
  })

  it('saveGroupsToStorage persists to vault cache', () => {
    const store = useKnowledgeStore()
    store.createGroup('Persist Test')
    store.saveGroupsToStorage()
    const saved = JSON.parse(vault.readCache('knowledge', 'holo-knowledge-groups') || '[]')
    expect(saved.length).toBe(1)
    expect(saved[0].name).toBe('Persist Test')
  })

  it('loadFromStorage restores groups', () => {
    vault.writeCache('knowledge', 'holo-knowledge-groups', JSON.stringify([
      { id: 'g1', name: 'Restored', sharedEntryIds: [], createdAt: Date.now(), updatedAt: Date.now() }
    ]))
    const store = useKnowledgeStore()
    store.loadFromStorage()
    expect(store.knowledgeGroups.length).toBe(1)
    expect(store.knowledgeGroups[0].name).toBe('Restored')
  })

  it('getGroupProjects returns projects belonging to group', () => {
    const store = useKnowledgeStore()
    const group = store.createGroup('Group1')
    const projects = [
      { id: 'p1', name: 'P1', parentGroupId: group!.id },
      { id: 'p2', name: 'P2', parentGroupId: 'other' }
    ]
    const result = store.getGroupProjects(group!.id, projects as any)
    expect(result.length).toBe(1)
    expect(result[0].id).toBe('p1')
  })
})
