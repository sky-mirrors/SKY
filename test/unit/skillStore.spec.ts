import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSkillStore } from '@/stores/skillStore'

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

describe('skillStore', () => {
  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with empty installedSkills', () => {
    const store = useSkillStore()
    expect(store.installedSkills).toEqual([])
  })

  it('installSkill adds skill with dependency check', () => {
    const store = useSkillStore()
    const skill = {
      id: 'skill-1', name: 'Test Skill', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: [], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: false
    }
    const result = store.installSkill(skill)
    expect(result.success).toBe(true)
    expect(result.missing).toEqual([])
    expect(store.installedSkills.length).toBe(1)
  })

  it('installSkill reports missing dependencies for non-l0/l1 deps', () => {
    const store = useSkillStore()
    const skill = {
      id: 'skill-1', name: 'Dep Skill', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: ['missing-dep'], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: false
    }
    const result = store.installSkill(skill)
    expect(result.success).toBe(false)
    expect(result.missing).toContain('missing-dep')
  })

  it('l0- and l1- prefixed dependencies are always met', () => {
    const store = useSkillStore()
    const skill = {
      id: 'skill-1', name: 'Core Dep', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: ['l0-core', 'l1-analyzer'], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: false
    }
    const result = store.installSkill(skill)
    expect(result.success).toBe(true)
  })

  it('uninstallSkill removes skill by id', () => {
    const store = useSkillStore()
    const skill = {
      id: 'skill-1', name: 'Test', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: [], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: false
    }
    store.installSkill(skill)
    expect(store.installedSkills.length).toBe(1)
    store.uninstallSkill('skill-1')
    expect(store.installedSkills.length).toBe(0)
  })

  it('isCatalogItemInstalled checks installed skills', () => {
    const store = useSkillStore()
    expect(store.isCatalogItemInstalled('cat-1')).toBe(false)
    const skill = {
      id: 's1', name: 'Test', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: [], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: true, catalogId: 'cat-1'
    }
    store.installSkill(skill)
    expect(store.isCatalogItemInstalled('cat-1')).toBe(true)
  })

  it('exportSkill returns JSON string', () => {
    const store = useSkillStore()
    const skill = {
      id: 'skill-1', name: 'Exportable', description: 'desc', version: '1.0',
      nodes: [], edges: [], dependencies: [], author: 'test',
      createdAt: Date.now(), isInstalled: true, isFromMarket: false
    }
    store.installSkill(skill)
    const json = store.exportSkill('skill-1')
    expect(json).not.toBeNull()
    const parsed = JSON.parse(json!)
    expect(parsed.name).toBe('Exportable')
  })

  it('exportSkill returns null for nonexistent skill', () => {
    const store = useSkillStore()
    expect(store.exportSkill('nonexistent')).toBeNull()
  })

  it('importSkill parses and installs from JSON', () => {
    const store = useSkillStore()
    const json = JSON.stringify({
      id: 'imported-1', name: 'Imported', description: 'imported skill',
      version: '1.0', nodes: [], edges: [], dependencies: [],
      author: 'external', isInstalled: true, isFromMarket: true
    })
    const result = store.importSkill(json)
    expect(result.success).toBe(true)
    expect(store.installedSkills.length).toBe(1)
  })

  it('importSkill handles invalid JSON', () => {
    const store = useSkillStore()
    const result = store.importSkill('not-json')
    expect(result.success).toBe(false)
  })

  it('isDependencyMet is internal - not exposed on store', () => {
    const store = useSkillStore()
    expect((store as any).isDependencyMet).toBeUndefined()
  })

  it('createSkillFromWorkflow creates a skill', () => {
    const store = useSkillStore()
    const skill = store.createSkillFromWorkflow(
      'Workflow Skill', 'Created from workflow',
      [{ toolId: 'tool-1', params: { input: '{{text}}' }, position: { x: 0, y: 0 } }],
      [{ from: 'tool-1', to: 'tool-2', type: 'data' as const }],
      ['dep-1']
    )
    expect(skill.name).toBe('Workflow Skill')
    expect(skill.id).toBeDefined()
  })
})
