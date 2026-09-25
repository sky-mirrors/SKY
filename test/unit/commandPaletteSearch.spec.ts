import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from '@/stores/configStore'
import { useSkillStore } from '@/stores/skillStore'
import { search } from '@/services/commandPaletteSearch'
import { registerConfigHandlers } from '@/domains/config/handlers'
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
    // 2026-09-25：改用**生产**的 config 接线，而非自建 config:get mock。
    // 原 mock 返回 `currentJobRole`，而生产 config:get 返回 `{ ...store.config }`（字段名 `jobRole`）——
    // 两者字段名不一致 ⇒ 用假环境掩盖了「角色加权在生产恒失效」（HANDOFF 坑 13：单测恒绿、生产全断）。
    // registerConfigHandlers 让测试绑定真实快照字段，搜索若读错字段名就会当场变红。
    registerConfigHandlers(globalBus)
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
    // 两个技能基础得分**完全相同**（同名同描述），且**非角色技能排在数组前面**——
    // 未加权时稳定排序让它保持第一；只有角色加权真正生效，匹配角色的技能才会被挤到第一。
    // （旧版把角色技能排在数组前面、两项得分又不同，未加权也能"第一"，是假绿。）
    skillStore.installedSkills = [
      { id: 's-noRole', name: '季度财报', description: '季度财报', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true } as any,
      { id: 's-role', name: '季度财报', description: '季度财报', version: '1.0', nodes: [], edges: [], dependencies: [], author: 'official', createdAt: Date.now(), isInstalled: true, isFromMarket: true, jobRoles: ['finance'] } as any
    ]
    const results = search('财报')
    expect(results[0].id).toBe('s-role')
  })
})
