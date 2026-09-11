import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from '@/stores/configStore'
import { useSkillStore } from '@/stores/skillStore'
import { search } from '@/services/commandPaletteSearch'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

describe('commandPaletteSearch', () => {
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

    const configStore = useConfigStore()
    globalBus.registerHandler('config:get', () => ({
      currentJobRole: configStore.currentJobRole,
      recentSkills: []
    }))
    globalBus.registerHandler('skill:list', () => {
      const skillStore = useSkillStore()
      return skillStore.installedSkills
    })
  })

  afterEach(() => {
    globalBus.clear()
    vi.unstubAllGlobals()
  })

  it('returns empty for empty query', () => {
    const results = search('')
    expect(results).toEqual([])
  })

  it('returns empty for whitespace-only query', () => {
    const results = search('   ')
    expect(results).toEqual([])
  })

  it('finds skills by name', () => {
    const skillStore = useSkillStore()
    skillStore.installedSkills = [
      { id: 'skill-1', name: '合同风险审查', description: '审查合同中的风险点', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true, catalogId: 'cat-1' } as any
    ]
    const results = search('合同')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('skill')
    expect(results[0].label).toContain('合同')
  })

  it('finds settings by name', () => {
    const results = search('API')
    expect(results.some(r => r.type === 'setting' && r.id === 'setting-api')).toBe(true)
  })

  it('finds actions by name', () => {
    const results = search('切换')
    expect(results.some(r => r.type === 'action')).toBe(true)
  })

  it('respects scope filter', () => {
    const results = search('设置', 'skills')
    expect(results.every(r => r.type === 'skill')).toBe(true)
  })

  it('limits results to 20', () => {
    const skillStore = useSkillStore()
    skillStore.installedSkills = Array.from({ length: 30 }, (_, i) => ({
      id: `skill-${i}`, name: `技能${i}`, description: `描述${i}`, version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true
    })) as any
    const results = search('技能')
    expect(results.length).toBeLessThanOrEqual(20)
  })

  it('prefix matches rank higher than contains matches', () => {
    const skillStore = useSkillStore()
    skillStore.installedSkills = [
      { id: 's1', name: '合同审查', description: '审查合同', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true } as any,
      { id: 's2', name: '法律合同模板', description: '生成合同模板', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true } as any
    ]
    const results = search('合同')
    expect(results[0].id).toBe('s1')
  })

  it('boosts results matching current job role', () => {
    const configStore = useConfigStore()
    configStore.setJobRole('finance')
    const skillStore = useSkillStore()
    skillStore.installedSkills = [
      { id: 's1', name: '财报分析', description: '分析财报', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true, jobRoles: ['finance'] } as any,
      { id: 's2', name: '财报总结', description: '总结财报', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true } as any
    ]
    const results = search('财报')
    expect(results[0].id).toBe('s1')
  })
})
