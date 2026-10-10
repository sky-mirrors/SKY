import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSkillStore, resolveMcpInstallItem } from '@/stores/skillStore'
import type { SkillCatalogItem, McpCatalogItem } from '@/models'

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

// 卡点 5：技能声明的 MCP 若不在商店，旧实现静默跳过（装了技能但依赖没装上，
// 用户无从察觉）。技能引用 21 个 MCP，商店只收录 5 个，缺口是常态而非边缘。
describe('resolveMcpInstallItem', () => {
  const mkSkill = (over: Partial<SkillCatalogItem> = {}): SkillCatalogItem => ({
    id: 'skill-x', name: '示例技能', description: '', category: '测试',
    version: '1.0.0', author: 'a', nodes: [], edges: [], dependencies: [], tags: [],
    ...over
  })
  const mkCatalogItem = (id: string): McpCatalogItem => ({
    id, name: id, description: '', category: 'c', command: 'npx',
    args: ['-y', id], envKeys: [], homepage: '', source: 'official', tags: []
  })

  it('技能未声明 MCP 依赖时返回 null', () => {
    expect(resolveMcpInstallItem(mkSkill(), [])).toBeNull()
  })

  it('仅有 mcpServerId 而缺 mcpCommand 时返回 null（不合成残缺条目）', () => {
    expect(resolveMcpInstallItem(mkSkill({ mcpServerId: 'mcp-x' }), [])).toBeNull()
  })

  it('商店已收录时返回商店条目（保留更完整元数据）', () => {
    const fromCatalog = mkCatalogItem('mcp-git')
    const got = resolveMcpInstallItem(
      mkSkill({ mcpServerId: 'mcp-git', mcpCommand: 'npx', mcpArgs: ['-y', 'self'] }),
      [fromCatalog]
    )
    expect(got).toBe(fromCatalog) // 同一引用，未被合成条目覆盖
  })

  it('商店未收录时据技能自带字段合成条目（不再静默跳过）', () => {
    const got = resolveMcpInstallItem(
      mkSkill({
        name: '网页研究',
        category: '研究',
        mcpServerId: 'mcp-exa',
        mcpCommand: 'npx',
        mcpArgs: ['-y', '@exa/mcp'],
        mcpEnvKeys: ['EXA_API_KEY'],
        homepage: 'https://exa.ai'
      }),
      [] // 商店为空
    )
    expect(got).not.toBeNull()
    expect(got!.id).toBe('mcp-exa')
    expect(got!.command).toBe('npx')
    expect(got!.args).toEqual(['-y', '@exa/mcp'])
    expect(got!.envKeys).toEqual(['EXA_API_KEY'])
    expect(got!.homepage).toBe('https://exa.ai')
    expect(got!.name).toContain('网页研究')
  })

  it('缺省 mcpArgs/mcpEnvKeys 时回退为空数组（不产生 undefined）', () => {
    const got = resolveMcpInstallItem(
      mkSkill({ mcpServerId: 'mcp-bare', mcpCommand: 'uvx' }),
      []
    )
    expect(got!.args).toEqual([])
    expect(got!.envKeys).toEqual([])
  })
})
