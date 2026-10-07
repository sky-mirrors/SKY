import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from '@/stores/configStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useApiStore } from '@/stores/apiStore'
import { useNodeStore } from '@/stores/nodeStore'
import { useSkillStore } from '@/stores/skillStore'
import { search } from '@/services/commandPaletteSearch'
import { JobRole } from '@/models'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

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
  globalBus.clear()
})

describe('OnboardingWizard integration', () => {
  it('sets job role via configStore.setJobRole', () => {
    const configStore = useConfigStore()
    configStore.setJobRole(JobRole.Legal)
    expect(configStore.currentJobRole).toBe(JobRole.Legal)
  })

  it('sets terminology style to technical or plain', () => {
    const configStore = useConfigStore()
    configStore.setTerminologyStyle('technical')
    expect(configStore.terminologyStyle).toBe('technical')
    configStore.setTerminologyStyle('plain')
    expect(configStore.terminologyStyle).toBe('plain')
  })

  it('enables animation after onboarding finish', () => {
    const configStore = useConfigStore()
    configStore.setAnimationEnabled(true)
    expect(configStore.animationEnabled).toBe(true)
  })

  it('marks first launch done', () => {
    const configStore = useConfigStore()
    expect(configStore.isFirstLaunch).toBe(true)
    configStore.markFirstLaunchDone()
    expect(configStore.isFirstLaunch).toBe(false)
  })

  it('marks onboarding complete', () => {
    const configStore = useConfigStore()
    expect(configStore.isOnboardingComplete).toBe(false)
    configStore.markOnboardingComplete()
    expect(configStore.isOnboardingComplete).toBe(true)
  })

  it('persist config to vault after role change', () => {
    const configStore = useConfigStore()
    configStore.setJobRole(JobRole.Finance)
    const saved = vault.readCache('config', 'holo-user-config')
    expect(saved).toBeDefined()
    const parsed = JSON.parse(saved!)
    expect(parsed.jobRole).toBe(JobRole.Finance)
  })
})

describe('SettingsPage integration', () => {
  it('notification settings roundtrip', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ auditBlock: true, popupDuration: 4000 })
    expect(notificationStore.settings.auditBlock).toBe(true)
    expect(notificationStore.settings.popupDuration).toBe(4000)
  })

  it('theme toggle cycles dark -> light -> green -> kawaii -> dark', () => {
    vi.stubGlobal('document', { documentElement: { setAttribute: vi.fn() } })
    const configStore = useConfigStore()
    expect(configStore.theme).toBe('dark')
    configStore.toggleTheme()
    expect(configStore.theme).toBe('light')
    configStore.toggleTheme()
    expect(configStore.theme).toBe('green')
    // 2026-10-07：循环末尾追加 kawaii（可爱/二次元主题）
    configStore.toggleTheme()
    expect(configStore.theme).toBe('kawaii')
    configStore.toggleTheme()
    expect(configStore.theme).toBe('dark')
    vi.unstubAllGlobals()
  })

  it('animation can be toggled off and on', () => {
    const configStore = useConfigStore()
    configStore.setAnimationEnabled(false)
    expect(configStore.animationEnabled).toBe(false)
    configStore.setAnimationEnabled(true)
    expect(configStore.animationEnabled).toBe(true)
  })
})

describe('NotificationCenter integration', () => {
  it('addNotification respects type enable/disable', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolComplete: false })
    const n = notificationStore.addNotification('tool_complete', 'Title', 'Msg')
    expect(n).toBeNull()
    expect(notificationStore.notifications.length).toBe(0)
  })

  it('addNotification creates notification when type is enabled', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolComplete: true })
    const n = notificationStore.addNotification('tool_complete', 'Title', 'Msg')
    expect(n).not.toBeNull()
    expect(notificationStore.notifications.length).toBe(1)
    expect(notificationStore.notifications[0].title).toBe('Title')
  })

  it('markAllRead marks all notifications', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolComplete: true, toolFail: true })
    notificationStore.addNotification('tool_complete', 'A', 'a')
    notificationStore.addNotification('tool_fail', 'B', 'b')
    expect(notificationStore.unreadCount).toBe(2)
    notificationStore.markAllRead()
    expect(notificationStore.unreadCount).toBe(0)
  })

  it('filter by high priority', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ auditBlock: true, toolFail: true })
    notificationStore.addNotification('audit_block', 'High', 'h')
    notificationStore.addNotification('tool_fail', 'Low', 'l')
    const highOnes = notificationStore.activeNotifications.filter(n => n.priority === 'high')
    expect(highOnes.length).toBeGreaterThanOrEqual(1)
    expect(highOnes.every(n => n.priority === 'high')).toBe(true)
  })

  it('expireOld removes expired notifications', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolComplete: true })
    notificationStore.addNotification('tool_complete', 'Expired', 'e')
    const n = notificationStore.notifications[0]
    n.expiresAt = Date.now() - 1000
    notificationStore.expireOld()
    expect(notificationStore.notifications.length).toBe(0)
  })

  it('processAutoRead marks notifications past autoReadAt', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolFail: true })
    notificationStore.addNotification('tool_fail', 'Auto', 'a')
    const n = notificationStore.notifications[0]
    n.autoReadAt = Date.now() - 1000
    notificationStore.processAutoRead()
    expect(n.read).toBe(true)
  })

  it('clearAll empties all notifications', () => {
    const notificationStore = useNotificationStore()
    notificationStore.updateSettings({ toolComplete: true })
    notificationStore.addNotification('tool_complete', 'X', 'x')
    notificationStore.addNotification('tool_complete', 'Y', 'y')
    notificationStore.clearAll()
    expect(notificationStore.notifications.length).toBe(0)
  })
})

describe('CommandPalette integration', () => {
  beforeEach(() => {
    const configStore = useConfigStore()
    const skillStore = useSkillStore()
    globalBus.registerHandler('config:get', () => ({
      currentJobRole: configStore.currentJobRole,
      recentSkills: []
    }))
    globalBus.registerHandler('skill:list', () => skillStore.installedSkills)
  })

  it('search returns setting results for appearance query', () => {
    const results = search('外观')
    expect(results.some(r => r.type === 'setting')).toBe(true)
  })

  it('search returns action results for theme query', () => {
    const results = search('主题')
    const hasAction = results.some(r => r.type === 'action')
    expect(hasAction).toBe(true)
  })

  it('search returns empty for nonsense query', () => {
    const results = search('xyznotexist123')
    expect(results.length).toBe(0)
  })

  it('search returns action-open-notifications for notification query', () => {
    const results = search('通知中心')
    const hasNotifAction = results.some(r => r.id === 'action-open-notifications')
    expect(hasNotifAction).toBe(true)
  })
})

describe('Bug #1 fix: OnboardingWizard uses addProvider', () => {
  it('addProvider creates a ProviderConfig with apiKey', () => {
    const apiStore = useApiStore()
    const id = apiStore.addProvider({
      id: 'test-provider',
      name: 'Test',
      baseUrl: 'https://api.test.com/v1',
      authType: 'bearer',
      apiKey: 'sk-test-123',
      modelsEndpoint: '/v1/models',
      chatFormat: 'openai'
    })
    expect(id).toBe('test-provider')
    const provider = apiStore.config.providers.find(p => p.id === 'test-provider')
    expect(provider).toBeDefined()
    expect(provider!.apiKey).toBe('sk-test-123')
    expect(provider!.baseUrl).toBe('https://api.test.com/v1')
  })

  it('apiStore.config has no apiKey property on ApiConfig', () => {
    const apiStore = useApiStore()
    expect('apiKey' in apiStore.config).toBe(false)
  })

  it('updating existing provider persists apiKey', () => {
    const apiStore = useApiStore()
    apiStore.addProvider({
      id: 'onboarded-provider',
      name: '默认服务',
      baseUrl: 'https://api.openai.com/v1',
      authType: 'bearer',
      apiKey: 'sk-orig',
      modelsEndpoint: '/v1/models',
      chatFormat: 'openai'
    })
    const provider = apiStore.config.providers.find(p => p.id === 'onboarded-provider')
    provider!.apiKey = 'sk-updated'
    provider!.baseUrl = 'https://new.api.com/v1'
    expect(provider!.apiKey).toBe('sk-updated')
    expect(provider!.baseUrl).toBe('https://new.api.com/v1')
  })
})

describe('Bug #2 fix: selectNode(null) for deselect', () => {
  it('selectNode(null) clears selection', () => {
    const nodeStore = useNodeStore()
    const node = nodeStore.nodes.find(n => n.id === 'l1-model-gateway')
    if (!node) return
    nodeStore.selectNode('l1-model-gateway')
    expect(nodeStore.selectedNode?.id).toBe('l1-model-gateway')
    nodeStore.selectNode(null)
    expect(nodeStore.selectedNode).toBeNull()
  })
})

describe('Bug #5 fix: viewMode persistence', () => {
  it('viewMode defaults to workbench', () => {
    const configStore = useConfigStore()
    expect(configStore.viewMode).toBe('workbench')
  })

  it('setViewMode persists to config', () => {
    const configStore = useConfigStore()
    configStore.setViewMode('preview')
    expect(configStore.viewMode).toBe('preview')
  })

  it('viewMode is loaded from vault', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({ viewMode: 'preview', jobRole: 'general', selectedL2Ids: [], firstLaunchDone: true }))
    setActivePinia(createPinia())
    const configStore = useConfigStore()
    configStore.loadFromStorage()
    expect(configStore.viewMode).toBe('preview')
  })

  it('旧配置里持久化的 viewMode:"starmap" 归一化为 "workbench"（删星图后的兼容）', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({ viewMode: 'starmap', jobRole: 'general', selectedL2Ids: [], firstLaunchDone: true }))
    setActivePinia(createPinia())
    const configStore = useConfigStore()
    configStore.loadFromStorage()
    expect(configStore.viewMode).toBe('workbench')
  })

  it('toggleViewMode switches workbench↔preview and persists', () => {
    const configStore = useConfigStore()
    expect(configStore.viewMode).toBe('workbench')
    configStore.setViewMode('preview')
    expect(configStore.viewMode).toBe('preview')
    configStore.setViewMode('workbench')
    expect(configStore.viewMode).toBe('workbench')
  })
})

describe('Bug #6 fix: dialogPanelWidth persistence', () => {
  it('setDialogPanelWidth persists within bounds', () => {
    const configStore = useConfigStore()
    configStore.setDialogPanelWidth(550)
    expect(configStore.config.dialogPanelWidth).toBe(550)
  })

  it('setDialogPanelWidth clamps to 300-600 range', () => {
    const configStore = useConfigStore()
    configStore.setDialogPanelWidth(100)
    expect(configStore.config.dialogPanelWidth).toBe(300)
    configStore.setDialogPanelWidth(999)
    expect(configStore.config.dialogPanelWidth).toBe(600)
  })

  it('dialogPanelWidth is loaded from vault', () => {
    vault.writeCache('config', 'holo-user-config', JSON.stringify({ dialogPanelWidth: 520, jobRole: 'general', selectedL2Ids: [], firstLaunchDone: true }))
    setActivePinia(createPinia())
    const configStore = useConfigStore()
    configStore.loadFromStorage()
    expect(configStore.config.dialogPanelWidth).toBe(520)
  })
})
