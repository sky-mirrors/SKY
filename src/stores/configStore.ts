import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { UserConfig, JobRole } from '@/models'

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
    }
  })
  const theme = ref<'dark' | 'light' | 'green'>('dark')

  const isFirstLaunch = computed(() => !config.value.firstLaunchDone)
  const currentJobRole = computed(() => config.value.jobRole)
  const isLightTheme = computed(() => theme.value === 'light' || theme.value === 'green')

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

  function loadFromStorage() {
    try {
      const saved = localStorage.getItem('holo-user-config')
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<UserConfig> & { theme?: string }
        if (parsed.jobRole) config.value.jobRole = parsed.jobRole as JobRole
        if (parsed.selectedL2Ids) config.value.selectedL2Ids = parsed.selectedL2Ids
        if (parsed.firstLaunchDone) config.value.firstLaunchDone = parsed.firstLaunchDone
        if (parsed.theme) {
          theme.value = parsed.theme as 'dark' | 'light' | 'green'
          document.documentElement.setAttribute('data-theme', theme.value)
        }
      }
    } catch { /* ignore */ }
  }

  function saveToStorage() {
    localStorage.setItem('holo-user-config', JSON.stringify({ ...config.value, theme: theme.value }))
  }

  return {
    config,
    theme,
    isFirstLaunch,
    currentJobRole,
    isLightTheme,
    setJobRole,
    addSelectedL2,
    removeSelectedL2,
    markFirstLaunchDone,
    toggleTheme,
    loadFromStorage,
    saveToStorage
  }
})
