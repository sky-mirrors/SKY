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
      isReachable: false,
      lastCheckedAt: 0
    },
    uiMode: 'workbench',
    onboardingCompleted: false,
    apiConfigured: false,
    knowledgeFed: false,
    terminologyStyle: 'plain',
    animationEnabled: true,
    starmapNodeDensity: 'standard',
    dialogPanelWidth: 460,
    favoriteSkills: [],
    recentSkills: []
  })
  const theme = ref<'dark' | 'light' | 'green'>('dark')

  const isFirstLaunch = computed(() => !config.value.firstLaunchDone)
  const currentJobRole = computed(() => config.value.jobRole)
  const isLightTheme = computed(() => theme.value === 'light' || theme.value === 'green')
  const uiMode = computed(() => config.value.uiMode ?? 'workbench')
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

  function toggleTheme() {
    const cycle: Record<string, 'light' | 'green' | 'dark'> = { dark: 'light', light: 'green', green: 'dark' }
    theme.value = cycle[theme.value] ?? 'dark'
    document.documentElement.setAttribute('data-theme', theme.value)
    saveToStorage()
  }

  function setUiMode(mode: 'workbench' | 'starmap') {
    config.value.uiMode = mode
    saveToStorage()
  }

  function toggleUiMode() {
    config.value.uiMode = config.value.uiMode === 'workbench' ? 'starmap' : 'workbench'
    saveToStorage()
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

  function setStarmapNodeDensity(density: 'core' | 'standard' | 'full') {
    config.value.starmapNodeDensity = density
    saveToStorage()
  }

  function setDialogPanelWidth(width: number) {
    config.value.dialogPanelWidth = Math.max(300, Math.min(600, width))
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
        if (parsed.uiMode) config.value.uiMode = parsed.uiMode
        if (parsed.onboardingCompleted !== undefined) config.value.onboardingCompleted = parsed.onboardingCompleted
        if (parsed.apiConfigured !== undefined) config.value.apiConfigured = parsed.apiConfigured
        if (parsed.knowledgeFed !== undefined) config.value.knowledgeFed = parsed.knowledgeFed
        if (parsed.terminologyStyle) config.value.terminologyStyle = parsed.terminologyStyle
        if (parsed.animationEnabled !== undefined) config.value.animationEnabled = parsed.animationEnabled
        if (parsed.starmapNodeDensity) config.value.starmapNodeDensity = parsed.starmapNodeDensity
        if (parsed.dialogPanelWidth !== undefined) config.value.dialogPanelWidth = parsed.dialogPanelWidth
        if (parsed.favoriteSkills) config.value.favoriteSkills = parsed.favoriteSkills
        if (parsed.recentSkills) config.value.recentSkills = parsed.recentSkills
        if (parsed.viewMode) config.value.viewMode = parsed.viewMode
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
    uiMode,
    isOnboardingComplete,
    terminologyStyle,
    animationEnabled,
    viewMode,
    setJobRole,
    addSelectedL2,
    removeSelectedL2,
    markFirstLaunchDone,
    toggleTheme,
    setUiMode,
    toggleUiMode,
    markOnboardingComplete,
    resetOnboarding,
    setApiConfigured,
    setKnowledgeFed,
    setTerminologyStyle,
    setAnimationEnabled,
    setViewMode,
    setStarmapNodeDensity,
    setDialogPanelWidth,
    addFavoriteSkill,
    removeFavoriteSkill,
    addRecentSkill,
    clearRecentSkills,
    loadFromStorage,
    saveToStorage
  }
})
