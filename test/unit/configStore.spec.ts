import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from '@/stores/configStore'
import { vault } from '@/vault'

describe('configStore', () => {
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

  it('has correct default state', () => {
    const store = useConfigStore()
    expect(store.config.jobRole).toBe('general')
    expect(store.config.selectedL2Ids).toEqual([])
    expect(store.config.firstLaunchDone).toBe(false)
    expect(store.theme).toBe('dark')
  })

  it('isFirstLaunch returns true when firstLaunchDone is false', () => {
    const store = useConfigStore()
    expect(store.isFirstLaunch).toBe(true)
  })

  it('isFirstLaunch returns false after markFirstLaunchDone', () => {
    const store = useConfigStore()
    store.markFirstLaunchDone()
    expect(store.isFirstLaunch).toBe(false)
    expect(store.config.firstLaunchDone).toBe(true)
  })

  it('setJobRole updates currentJobRole', () => {
    const store = useConfigStore()
    store.setJobRole('finance')
    expect(store.currentJobRole).toBe('finance')
    expect(store.config.jobRole).toBe('finance')
  })

  it('addSelectedL2 and removeSelectedL2 manage selected tools', () => {
    const store = useConfigStore()
    store.addSelectedL2('tool-a')
    expect(store.config.selectedL2Ids).toContain('tool-a')
    store.addSelectedL2('tool-b')
    expect(store.config.selectedL2Ids).toEqual(['tool-a', 'tool-b'])
    store.removeSelectedL2('tool-a')
    expect(store.config.selectedL2Ids).toEqual(['tool-b'])
  })

  it('toggleTheme cycles through dark -> light -> green -> dark', () => {
    const store = useConfigStore()
    vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn() } })
    expect(store.theme).toBe('dark')
    expect(store.isLightTheme).toBe(false)
    store.toggleTheme()
    expect(store.theme).toBe('light')
    expect(store.isLightTheme).toBe(true)
    store.toggleTheme()
    expect(store.theme).toBe('green')
    expect(store.isLightTheme).toBe(true)
    // 2026-10-07（第四版）：主题收敛为三档二次元少女风（dark 哥特御姐 / light 少女萝莉 / green 生命力），
    // 原先临时加的 kawaii 档已并入 light
    store.toggleTheme()
    expect(store.theme).toBe('dark')
    expect(store.isLightTheme).toBe(false)
  })

  it('saveToStorage persists config', () => {
    const store = useConfigStore()
    store.setJobRole('legal')
    store.saveToStorage()
    const saved = JSON.parse(vault.readCache('config', 'holo-user-config')!)
    expect(saved.jobRole).toBe('legal')
  })

  it('loadFromStorage restores config', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({
      jobRole: 'finance',
      selectedL2Ids: ['tool-x'],
      firstLaunchDone: true,
      apiConfig: { baseUrl: '', models: [], activeModel: '', isReachable: false, lastCheckedAt: 0 }
    }))
    const store = useConfigStore()
    store.loadFromStorage()
    expect(store.config.jobRole).toBe('finance')
    expect(store.config.selectedL2Ids).toEqual(['tool-x'])
    expect(store.config.firstLaunchDone).toBe(true)
  })

  it('loadFromStorage handles missing data gracefully', () => {
    const store = useConfigStore()
    store.loadFromStorage()
    expect(store.config.jobRole).toBe('general')
  })

  it('has correct default new fields', () => {
    const store = useConfigStore()
    expect(store.isOnboardingComplete).toBe(false)
    expect(store.terminologyStyle).toBe('plain')
    expect(store.animationEnabled).toBe(true)
    expect(store.config.dialogPanelWidth).toBe(460)
    expect(store.config.favoriteSkills).toEqual([])
    expect(store.config.recentSkills).toEqual([])
  })

  it('markOnboardingComplete sets onboardingCompleted', () => {
    const store = useConfigStore()
    expect(store.isOnboardingComplete).toBe(false)
    store.markOnboardingComplete()
    expect(store.isOnboardingComplete).toBe(true)
    expect(store.config.onboardingCompleted).toBe(true)
  })

  it('resetOnboarding clears onboarding/api/knowledge flags', () => {
    const store = useConfigStore()
    store.markOnboardingComplete()
    store.setApiConfigured(true)
    store.setKnowledgeFed(true)
    store.resetOnboarding()
    expect(store.isOnboardingComplete).toBe(false)
    expect(store.config.apiConfigured).toBe(false)
    expect(store.config.knowledgeFed).toBe(false)
  })

  it('setTerminologyStyle updates terminologyStyle', () => {
    const store = useConfigStore()
    store.setTerminologyStyle('technical')
    expect(store.terminologyStyle).toBe('technical')
  })

  it('setAnimationEnabled toggles animation', () => {
    const store = useConfigStore()
    expect(store.animationEnabled).toBe(true)
    store.setAnimationEnabled(false)
    expect(store.animationEnabled).toBe(false)
  })

  it('setDialogPanelWidth clamps between 300-600', () => {
    const store = useConfigStore()
    store.setDialogPanelWidth(200)
    expect(store.config.dialogPanelWidth).toBe(300)
    store.setDialogPanelWidth(800)
    expect(store.config.dialogPanelWidth).toBe(600)
    store.setDialogPanelWidth(500)
    expect(store.config.dialogPanelWidth).toBe(500)
  })

  it('addFavoriteSkill and removeFavoriteSkill manage favorites', () => {
    const store = useConfigStore()
    store.addFavoriteSkill('skill-1')
    store.addFavoriteSkill('skill-2')
    expect(store.config.favoriteSkills).toEqual(['skill-1', 'skill-2'])
    store.addFavoriteSkill('skill-1')
    expect(store.config.favoriteSkills).toEqual(['skill-1', 'skill-2'])
    store.removeFavoriteSkill('skill-1')
    expect(store.config.favoriteSkills).toEqual(['skill-2'])
  })

  it('addRecentSkill maintains most recent at top, caps at 10', () => {
    const store = useConfigStore()
    for (let i = 0; i < 12; i++) {
      store.addRecentSkill({ id: `skill-${i}`, name: `Skill ${i}`, lastUsed: Date.now() + i })
    }
    expect(store.config.recentSkills!.length).toBe(10)
    expect(store.config.recentSkills![0].id).toBe('skill-11')
  })

  it('addRecentSkill deduplicates by moving to top', () => {
    const store = useConfigStore()
    store.addRecentSkill({ id: 's1', name: 'Skill 1', lastUsed: 1000 })
    store.addRecentSkill({ id: 's2', name: 'Skill 2', lastUsed: 2000 })
    store.addRecentSkill({ id: 's1', name: 'Skill 1 Updated', lastUsed: 3000 })
    expect(store.config.recentSkills!.length).toBe(2)
    expect(store.config.recentSkills![0].id).toBe('s1')
    expect(store.config.recentSkills![0].name).toBe('Skill 1 Updated')
  })

  it('clearRecentSkills empties the list', () => {
    const store = useConfigStore()
    store.addRecentSkill({ id: 's1', name: 'Skill 1', lastUsed: 1000 })
    store.clearRecentSkills()
    expect(store.config.recentSkills).toEqual([])
  })

  it('loadFromStorage restores new fields', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({
      jobRole: 'legal',
      selectedL2Ids: [],
      firstLaunchDone: true,
      apiConfig: { baseUrl: '', models: [], activeModel: '', isReachable: false, lastCheckedAt: 0 },
      onboardingCompleted: true,
      apiConfigured: true,
      knowledgeFed: true,
      terminologyStyle: 'technical',
      animationEnabled: false,
      dialogPanelWidth: 500,
      favoriteSkills: ['s1'],
      recentSkills: [{ id: 's2', name: 'Skill 2', lastUsed: 1000 }]
    }))
    const store = useConfigStore()
    store.loadFromStorage()
    expect(store.isOnboardingComplete).toBe(true)
    expect(store.terminologyStyle).toBe('technical')
    expect(store.animationEnabled).toBe(false)
    expect(store.config.dialogPanelWidth).toBe(500)
    expect(store.config.favoriteSkills).toEqual(['s1'])
    expect(store.config.recentSkills!.length).toBe(1)
  })

  it('saveToStorage persists new fields', () => {
    const store = useConfigStore()
    store.setTerminologyStyle('technical')
    store.saveToStorage()
    const saved = JSON.parse(vault.readCache('config', 'holo-user-config')!)
    expect(saved.terminologyStyle).toBe('technical')
  })

  it('setLlmTimeoutScale clamps between 0.5-5 and falls back on NaN', () => {
    const store = useConfigStore()
    expect(store.config.llmTimeoutScale).toBe(1)
    store.setLlmTimeoutScale(0.1)
    expect(store.config.llmTimeoutScale).toBe(0.5)
    store.setLlmTimeoutScale(99)
    expect(store.config.llmTimeoutScale).toBe(5)
    store.setLlmTimeoutScale(2)
    expect(store.config.llmTimeoutScale).toBe(2)
    store.setLlmTimeoutScale(Number('not-a-number'))
    expect(store.config.llmTimeoutScale).toBe(1)
  })

  it('loadFromStorage restores llmTimeoutScale with clamping', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({
      jobRole: 'finance',
      llmTimeoutScale: 3
    }))
    const store = useConfigStore()
    store.loadFromStorage()
    expect(store.config.llmTimeoutScale).toBe(3)
  })

  it('saveToStorage persists llmTimeoutScale', () => {
    const store = useConfigStore()
    store.setLlmTimeoutScale(2)
    const saved = JSON.parse(vault.readCache('config', 'holo-user-config')!)
    expect(saved.llmTimeoutScale).toBe(2)
  })

  // HANDOFF 下一步 4 续：会话记忆跨重启策略开关
  it('setRestoreSessionMemoryOnStartup 默认关、可持久化并 loadFromStorage 恢复', () => {
    const store = useConfigStore()
    expect(store.config.restoreSessionMemoryOnStartup).toBe(false)
    store.setRestoreSessionMemoryOnStartup(true)
    expect(store.config.restoreSessionMemoryOnStartup).toBe(true)
    const saved = JSON.parse(vault.readCache('config', 'holo-user-config')!)
    expect(saved.restoreSessionMemoryOnStartup).toBe(true)

    setActivePinia(createPinia())
    vault.writeCache('config', 'holo-user-config', JSON.stringify({ jobRole: 'finance', restoreSessionMemoryOnStartup: true }))
    const store2 = useConfigStore()
    store2.loadFromStorage()
    expect(store2.config.restoreSessionMemoryOnStartup).toBe(true)
  })

  // 星图删除（2026-09-26）：125 节点 3D 星图视图整条移除——持久化里的旧模式字段
  // 不得复活任何模式开关（否则老用户 vault 里残留的 uiMode:'starmap' 会指向一个
  // 已被删除的视图 ⇒ 启动白屏）。
  it('旧配置里的 uiMode/starmapNodeDensity 不得复活星图模式', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({
      jobRole: 'finance',
      uiMode: 'starmap',
      starmapNodeDensity: 'full'
    }))
    const store = useConfigStore()
    store.loadFromStorage()
    const s = store as unknown as Record<string, unknown>
    expect(s.uiMode).toBeUndefined()
    expect(s.setUiMode).toBeUndefined()
    expect(s.toggleUiMode).toBeUndefined()
    expect(s.setStarmapNodeDensity).toBeUndefined()
    expect((store.config as unknown as Record<string, unknown>).uiMode).toBeUndefined()
    expect((store.config as unknown as Record<string, unknown>).starmapNodeDensity).toBeUndefined()
    // 其余字段照常恢复——不能因为删模式字段而砸掉整个加载
    expect(store.config.jobRole).toBe('finance')
  })
})
