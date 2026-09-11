import type { HoloEventBus } from '@/kernel/bus'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { getKnowledgeEntries } from '@/services/knowledgeBase'

export function registerKnowledgeHandlers(bus: HoloEventBus) {
  bus.registerHandler('knowledge:get-entries', () => {
    return getKnowledgeEntries()
  })

  bus.registerHandler('knowledge:get-groups', () => {
    const store = useKnowledgeStore()
    return store.knowledgeGroups
  })
}
