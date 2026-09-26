import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { UserConfig, JobRole, RecentSkillEntry } from '@/models'
import { vault } from '@/vault'

export const useConfigStore = defineStore('config', () => {
  const config = ref<UserConfig>({
    jobRole: JobRole.General,
    selectedL2Ids: [],
    firstLaunchDone: false,
    apiConfig: {
      baseUrl: '',
      models: [],
      activeModel: '',
      providers: [],
      activeProviderId: '',
      isReachable: false,
      lastCheckedAt: 0
    },
    onboardingCompleted: false,
    apiConfigured: false,
    knowledgeFed: false,
    terminologyStyle: 'plain',
    animationEnabled: true,
    dialogPanelWidth: 460,
    favoriteSkills: [],
    recentSkills: [],
    llmTimeoutScale: 1,
    restoreSessionMemoryOnStartup: false
  })
  const theme = ref<'dark' | 'light' | 'green'>('dark')

  const isFirstLaunch = computed(() => !config.value.firstLaunchDone)
  const currentJobRole = computed(() => config.value.jobRole)
  const isLightTheme = computed(() => theme.value === 'light' || theme.value === 'green')
  const isOnboardingComplete = computed(() => config.value.onboardingCompleted ?? false)
  const terminologyStyle = computed(() => config.value.terminologyStyle ?? 'plain')
  const animationEnabled = computed(() => config.value.animationEnabled ?? true)
  const viewMode = computed(() => config.value.viewMode ?? 'starmap')

  function setJobRole(role: JobRole) {
    config.value.jobRole = role
    saveToStorage()
  }

  function addSelectedL2(toolId: string) {
    if (!config.value.selectedL2Ids.includes(toolId)) {
      config.value.selectedL2Ids.push(toolId)
      saveToStorage()
    }
  }

  function removeSelectedL2(toolId: string) {
    config.value.selectedL2Ids = config.value.selectedL2Ids.filter(id => id !== toolId)
    saveToStorage()
  }

  function markFirstLaunchDone() {
    config.value.firstLaunchDone = true
    saveToStorage()
  }

  function setTheme(next: 'light' | 'green' | 'dark') {
    // D-12：主题下拉框需要按选定值直达——toggleTheme 是循环切换，
    // dark 状态下选 green 实际会得到 light
    theme.value = next
    document.documentElement.setAttribute('data-theme', theme.value)
    saveToStorage()
  }

  function toggleTheme() {
    const cycle: Record<string, 'light' | 'green' | 'dark'> = { dark: 'light', light: 'green', green: 'dark' }
    setTheme(cycle[theme.value] ?? 'dark')
  }

  function markOnboardingComplete() {
    config.value.onboardingCompleted = true
    saveToStorage()
  }

  function resetOnboarding() {
    config.value.onboardingCompleted = false
    config.value.apiConfigured = false
    config.value.knowledgeFed = false
    saveToStorage()
  }

  function setApiConfigured(value: boolean) {
    config.value.apiConfigured = value
    saveToStorage()
  }

  function setKnowledgeFed(value: boolean) {
    config.value.knowledgeFed = value
    saveToStorage()
  }

  function setTerminologyStyle(style: 'technical' | 'plain') {
    config.value.terminologyStyle = style
    saveToStorage()
  }

  function setAnimationEnabled(enabled: boolean) {
    config.value.animationEnabled = enabled
    saveToStorage()
  }

  function setViewMode(mode: 'starmap' | 'preview') {
    config.value.viewMode = mode
    saveToStorage()
  }

  function setDialogPanelWidth(width: number) {
    config.value.dialogPanelWidth = Math.max(300, Math.min(600, width))
    saveToStorage()
  }

  // P0-B4：LLM 超时缩放系数（0.5~5 钳制；非法/越界回退 1）
  function setLlmTimeoutScale(scale: number) {
    const clamped = Number.isFinite(scale) ? Math.max(0.5, Math.min(5, scale)) : 1
    config.value.llmTimeoutScale = clamped
    saveToStorage()
  }

  // HANDOFF 下一步 4 续：会话记忆跨重启策略开关（设置 → 记忆）
  function setRestoreSessionMemoryOnStartup(enabled: boolean) {
    config.value.restoreSessionMemoryOnStartup = enabled
    saveToStorage()
  }

  function addFavoriteSkill(skillId: string) {
    if (!config.value.favoriteSkills) config.value.favoriteSkills = []
    if (!config.value.favoriteSkills.includes(skillId)) {
      config.value.favoriteSkills.push(skillId)
      saveToStorage()
    }
  }

  function removeFavoriteSkill(skillId: string) {
    config.value.favoriteSkills = (config.value.favoriteSkills ?? []).filter(id => id !== skillId)
    saveToStorage()
  }

  function addRecentSkill(entry: RecentSkillEntry) {
    if (!config.value.recentSkills) config.value.recentSkills = []
    config.value.recentSkills = config.value.recentSkills.filter(s => s.id !== entry.id)
    config.value.recentSkills.unshift(entry)
    if (config.value.recentSkills.length > 10) {
      config.value.recentSkills = config.value.recentSkills.slice(0, 10)
    }
    saveToStorage()
  }

  function clearRecentSkills() {
    config.value.recentSkills = []
    saveToStorage()
  }

  function loadFromStorage() {
    const saved = vault.readCache('config', 'holo-user-config')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<UserConfig> & { theme?: string }
        if (parsed.jobRole) config.value.jobRole = parsed.jobRole as JobRole
        if (parsed.selectedL2Ids) config.value.selectedL2Ids = parsed.selectedL2Ids
        if (parsed.firstLaunchDone) config.value.firstLaunchDone = parsed.firstLaunchDone
        if (parsed.onboardingCompleted !== undefined) config.value.onboardingCompleted = parsed.onboardingCompleted
        if (parsed.apiConfigured !== undefined) config.value.apiConfigured = parsed.apiConfigured
        if (parsed.knowledgeFed !== undefined) config.value.knowledgeFed = parsed.knowledgeFed
        if (parsed.terminologyStyle) config.value.terminologyStyle = parsed.terminologyStyle
        if (parsed.animationEnabled !== undefined) config.value.animationEnabled = parsed.animationEnabled
        // C-29：加载时同样做范围钳制——持久化的越界值（旧版本写入/手改文件）
        // 会绕过 setDialogPanelWidth 的 300~600 约束
        if (parsed.dialogPanelWidth !== undefined) setDialogPanelWidth(parsed.dialogPanelWidth)
        if (parsed.favoriteSkills) config.value.favoriteSkills = parsed.favoriteSkills
        if (parsed.recentSkills) config.value.recentSkills = parsed.recentSkills
        if (parsed.llmTimeoutScale !== undefined) setLlmTimeoutScale(parsed.llmTimeoutScale)
        if (parsed.viewMode) config.value.viewMode = parsed.viewMode
        if (parsed.restoreSessionMemoryOnStartup !== undefined) config.value.restoreSessionMemoryOnStartup = parsed.restoreSessionMemoryOnStartup
        if (parsed.theme) {
          theme.value = parsed.theme as 'dark' | 'light' | 'green'
          document.documentElement.setAttribute('data-theme', theme.value)
        }
      } catch { /* ignore */ }
    }
  }

  function saveToStorage() {
    vault.writeThrough('config', 'holo-user-config', JSON.stringify({ ...config.value, theme: theme.value }))
  }

  return {
    config,
    theme,
    isFirstLaunch,
    currentJobRole,
    isLightTheme,
    isOnboardingComplete,
    terminologyStyle,
    animationEnabled,
    viewMode,
    setJobRole,
    addSelectedL2,
    removeSelectedL2,
    markFirstLaunchDone,
    toggleTheme,
    setTheme,
    markOnboardingComplete,
    resetOnboarding,
    setApiConfigured,
    setKnowledgeFed,
    setTerminologyStyle,
    setAnimationEnabled,
    setViewMode,
    setDialogPanelWidth,
    setLlmTimeoutScale,
    setRestoreSessionMemoryOnStartup,
    addFavoriteSkill,
    removeFavoriteSkill,
    addRecentSkill,
    clearRecentSkills,
    loadFromStorage,
    saveToStorage
  }
})
