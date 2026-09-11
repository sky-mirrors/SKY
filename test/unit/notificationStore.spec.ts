import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotificationStore } from '@/stores/notificationStore'
import { vault } from '@/vault'

describe('notificationStore', () => {
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

  it('has empty notifications by default', () => {
    const store = useNotificationStore()
    expect(store.notifications).toEqual([])
    expect(store.unreadCount).toBe(0)
  })

  it('has correct default settings', () => {
    const store = useNotificationStore()
    expect(store.settings.auditBlock).toBe(true)
    expect(store.settings.cacheHit).toBe(false)
    expect(store.settings.popupDuration).toBe(2000)
  })

  it('addNotification creates a notification with correct fields', () => {
    const store = useNotificationStore()
    const n = store.addNotification('audit_block', 'Shell审核阻断', 'rm -rf /tmp 被安全引擎拦截')
    expect(n).not.toBeNull()
    expect(n!.type).toBe('audit_block')
    expect(n!.priority).toBe('high')
    expect(n!.title).toBe('Shell审核阻断')
    expect(n!.read).toBe(false)
    expect(store.notifications.length).toBe(1)
    expect(store.unreadCount).toBe(1)
  })

  it('addNotification respects type settings and returns null when disabled', () => {
    const store = useNotificationStore()
    store.updateSettings({ cacheHit: false })
    const n = store.addNotification('cache_hit', '缓存命中', '语义缓存命中')
    expect(n).toBeNull()
    expect(store.notifications.length).toBe(0)
  })

  it('addNotification uses correct priority mapping', () => {
    const store = useNotificationStore()
    store.updateSettings({ cacheHit: true })
    store.addNotification('audit_block', 'T1', 'M1')
    store.addNotification('tool_complete', 'T2', 'M2')
    store.addNotification('cache_hit', 'T3', 'M3')
    expect(store.notifications.find(n => n.type === 'audit_block')!.priority).toBe('high')
    expect(store.notifications.find(n => n.type === 'tool_complete')!.priority).toBe('medium')
    expect(store.notifications.find(n => n.type === 'cache_hit')!.priority).toBe('low')
  })

  it('markRead marks a notification as read', () => {
    const store = useNotificationStore()
    const n = store.addNotification('tool_fail', 'Error', 'Something failed')
    store.markRead(n!.id)
    expect(n!.read).toBe(true)
    expect(store.unreadCount).toBe(0)
  })

  it('markAllRead marks all notifications as read', () => {
    const store = useNotificationStore()
    store.addNotification('audit_block', 'T1', 'M1')
    store.addNotification('tool_complete', 'T2', 'M2')
    expect(store.unreadCount).toBe(2)
    store.markAllRead()
    expect(store.unreadCount).toBe(0)
    expect(store.notifications.every(n => n.read)).toBe(true)
  })

  it('removeNotification removes a specific notification', () => {
    const store = useNotificationStore()
    const n1 = store.addNotification('audit_block', 'T1', 'M1')
    const n2 = store.addNotification('tool_complete', 'T2', 'M2')
    store.removeNotification(n1!.id)
    expect(store.notifications.length).toBe(1)
    expect(store.notifications[0].id).toBe(n2!.id)
  })

  it('clearAll removes all notifications', () => {
    const store = useNotificationStore()
    store.addNotification('audit_block', 'T1', 'M1')
    store.addNotification('tool_complete', 'T2', 'M2')
    store.clearAll()
    expect(store.notifications).toEqual([])
    expect(store.unreadCount).toBe(0)
  })

  it('highPriorityUnread filters correctly', () => {
    const store = useNotificationStore()
    store.addNotification('audit_block', 'T1', 'M1')
    store.addNotification('tool_complete', 'T2', 'M2')
    store.addNotification('cache_hit', 'T3', 'M3')
    expect(store.highPriorityUnread.length).toBe(1)
    expect(store.highPriorityUnread[0].type).toBe('audit_block')
  })

  it('notifications cap at MAX_NOTIFICATIONS (100)', () => {
    const store = useNotificationStore()
    store.updateSettings({ cacheHit: true })
    for (let i = 0; i < 120; i++) {
      store.addNotification('cache_hit', `T${i}`, `M${i}`)
    }
    expect(store.notifications.length).toBe(100)
  })

  it('updateSettings persists to vault cache', () => {
    const store = useNotificationStore()
    store.updateSettings({ cacheHit: true, popupDuration: 3000 })
    expect(store.settings.cacheHit).toBe(true)
    expect(store.settings.popupDuration).toBe(3000)
    const saved = JSON.parse(vault.readCache('notification', 'holo-notification-settings')!)
    expect(saved.cacheHit).toBe(true)
    expect(saved.popupDuration).toBe(3000)
  })

  it('loadFromStorage restores notifications and settings', () => {
    vault.writeCache('notification', 'holo-notifications', JSON.stringify([
      { id: 'n1', type: 'audit_block', priority: 'high', title: 'T1', message: 'M1', timestamp: 1000, read: false, actions: [], autoReadAt: null, expiresAt: null }
    ]))
    vault.writeCache('notification', 'holo-notification-settings', JSON.stringify({ auditBlock: false, apiDegrade: true, toolComplete: true, toolFail: true, cacheHit: true, knowledgeIngest: true, storageWarning: true, popupDuration: 5000 }))
    const store = useNotificationStore()
    store.loadFromStorage()
    expect(store.notifications.length).toBe(1)
    expect(store.notifications[0].title).toBe('T1')
    expect(store.settings.auditBlock).toBe(false)
    expect(store.settings.popupDuration).toBe(5000)
  })

  it('isTypeEnabled returns correct values for settings', () => {
    const store = useNotificationStore()
    expect(store.isTypeEnabled('audit_block')).toBe(true)
    expect(store.isTypeEnabled('cache_hit')).toBe(false)
    store.updateSettings({ cacheHit: true })
    expect(store.isTypeEnabled('cache_hit')).toBe(true)
  })

  it('addNotification with custom actions', () => {
    const store = useNotificationStore()
    const n = store.addNotification('tool_fail', 'Error', 'Failed', {
      actions: [{ label: 'Retry', action: 'retry', payload: { toolId: 'abc' } }]
    })
    expect(n!.actions.length).toBe(1)
    expect(n!.actions[0].label).toBe('Retry')
  })

  it('auto-expire removes expired notifications on loadFromStorage', () => {
    const expired = Date.now() - 1000
    vault.writeCache('notification', 'holo-notifications', JSON.stringify([
      { id: 'n1', type: 'cache_hit', priority: 'low', title: 'T1', message: 'M1', timestamp: 1000, read: false, actions: [], autoReadAt: null, expiresAt: expired }
    ]))
    const store = useNotificationStore()
    store.loadFromStorage()
    expect(store.notifications.length).toBe(0)
  })

  it('saveToStorage persists notifications', () => {
    const store = useNotificationStore()
    store.addNotification('audit_block', 'T1', 'M1')
    const saved = JSON.parse(vault.readCache('notification', 'holo-notifications')!)
    expect(saved.length).toBe(1)
    expect(saved[0].title).toBe('T1')
  })
})
