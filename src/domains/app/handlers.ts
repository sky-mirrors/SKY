import type { HoloEventBus } from '@/kernel/bus'
import { useSessionStore } from '@/stores/sessionStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useSkillStore } from '@/stores/skillStore'

export function registerAppHandlers(bus: HoloEventBus) {
  bus.registerHandler('session:get-active', () => {
    const store = useSessionStore()
    return store.activeSession
  })

  bus.registerHandler('notification:add', (payload) => {
    const store = useNotificationStore()
    store.addNotification(payload.type, payload.title, payload.message, payload.options)
  })

  bus.registerHandler('skill:list', () => {
    const store = useSkillStore()
    return store.installedSkills
  })
}
