import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { Notification, NotificationType, NotificationPriority, NotificationSettings, NotificationAction } from '@/models'
import { vault } from '@/vault'

const NOTIFICATIONS_KEY = 'holo-notifications'
const SETTINGS_KEY = 'holo-notification-settings'
const MAX_NOTIFICATIONS = 100

const DEFAULT_SETTINGS: NotificationSettings = {
  auditBlock: true,
  apiDegrade: true,
  toolComplete: true,
  toolFail: true,
  cacheHit: false,
  knowledgeIngest: true,
  storageWarning: true,
  popupDuration: 2000
}

const PRIORITY_MAP: Record<NotificationType, NotificationPriority> = {
  audit_block: 'high',
  api_degrade: 'high',
  circuit_breaker: 'high',
  tool_fail: 'high',
  storage_warning: 'high',
  tool_complete: 'medium',
  knowledge_ingest: 'medium',
  cache_hit: 'low',
  skill_install: 'low'
}

const AUTO_EXPIRE_MS: Record<NotificationPriority, number | null> = {
  high: null,
  medium: 7 * 24 * 60 * 60 * 1000,
  low: 24 * 60 * 60 * 1000
}

const AUTO_READ_MS: Record<NotificationPriority, number | null> = {
  high: null,
  medium: null,
  low: 5 * 60 * 1000
}

export const useNotificationStore = defineStore('notification', () => {
  const notifications = ref<Notification[]>([])
  const settings = ref<NotificationSettings>({ ...DEFAULT_SETTINGS })

  const unreadCount = computed(() => notifications.value.filter(n => !n.read).length)
  const highPriorityUnread = computed(() => notifications.value.filter(n => !n.read && n.priority === 'high'))
  const activeNotifications = computed(() => {
    const now = Date.now()
    return notifications.value.filter(n => n.expiresAt === null || n.expiresAt > now)
  })

  function isTypeEnabled(type: NotificationType): boolean {
    switch (type) {
      case 'audit_block': return settings.value.auditBlock
      case 'api_degrade':
      case 'circuit_breaker': return settings.value.apiDegrade
      case 'tool_complete': return settings.value.toolComplete
      case 'tool_fail': return settings.value.toolFail
      case 'cache_hit': return settings.value.cacheHit
      case 'knowledge_ingest': return settings.value.knowledgeIngest
      case 'storage_warning': return settings.value.storageWarning
      case 'skill_install': return true
      default: return true
    }
  }

  function addNotification(
    type: NotificationType,
    title: string,
    message: string,
    options?: Partial<{ actions: NotificationAction[]; priority: NotificationPriority }>
  ): Notification | null {
    if (!isTypeEnabled(type)) return null

    const priority = options?.priority ?? PRIORITY_MAP[type]
    const now = Date.now()
    const expiresAt = AUTO_EXPIRE_MS[priority] ? now + AUTO_EXPIRE_MS[priority]! : null
    const autoReadAt = AUTO_READ_MS[priority] ? now + AUTO_READ_MS[priority]! : null

    const n: Notification = {
      id: `notif-${now}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      priority,
      title,
      message,
      timestamp: now,
      read: false,
      actions: options?.actions ?? [],
      autoReadAt,
      expiresAt
    }

    notifications.value.unshift(n)

    if (notifications.value.length > MAX_NOTIFICATIONS) {
      notifications.value = notifications.value
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_NOTIFICATIONS)
    }

    saveToStorage()
    return n
  }

  function markRead(id: string) {
    const n = notifications.value.find(item => item.id === id)
    if (n) { n.read = true; saveToStorage() }
  }

  function markAllRead() {
    notifications.value.forEach(n => { n.read = true })
    saveToStorage()
  }

  function removeNotification(id: string) {
    notifications.value = notifications.value.filter(n => n.id !== id)
    saveToStorage()
  }

  function clearAll() {
    notifications.value = []
    saveToStorage()
  }

  function processAutoRead() {
    const now = Date.now()
    let changed = false
    notifications.value.forEach(n => {
      if (!n.read && n.autoReadAt !== null && now >= n.autoReadAt) {
        n.read = true
        changed = true
      }
    })
    if (changed) saveToStorage()
  }

  function expireOld() {
    const now = Date.now()
    const before = notifications.value.length
    notifications.value = notifications.value.filter(n => n.expiresAt === null || n.expiresAt > now)
    if (notifications.value.length !== before) saveToStorage()
  }

  function updateSettings(partial: Partial<NotificationSettings>) {
    Object.assign(settings.value, partial)
    saveSettingsToStorage()
  }

  function loadFromStorage() {
    const raw = vault.readCache('notification', NOTIFICATIONS_KEY)
    if (raw) {
      try { notifications.value = JSON.parse(raw) as Notification[] } catch { /* ignore */ }
    }
    const rawSettings = vault.readCache('notification', SETTINGS_KEY)
    if (rawSettings) {
      try { Object.assign(settings.value, JSON.parse(rawSettings) as Partial<NotificationSettings>) } catch { /* ignore */ }
    }
    expireOld()
    processAutoRead()
  }

  function saveToStorage() {
    vault.writeThrough('notification', NOTIFICATIONS_KEY, JSON.stringify(notifications.value))
  }

  function saveSettingsToStorage() {
    vault.writeThrough('notification', SETTINGS_KEY, JSON.stringify(settings.value))
  }

  return {
    notifications,
    settings,
    unreadCount,
    highPriorityUnread,
    activeNotifications,
    addNotification,
    markRead,
    markAllRead,
    removeNotification,
    clearAll,
    processAutoRead,
    expireOld,
    updateSettings,
    isTypeEnabled,
    loadFromStorage,
    saveToStorage
  }
})
