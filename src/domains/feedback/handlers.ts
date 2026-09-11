import type { HoloEventBus } from '@/kernel/bus'
import { useFeedbackStore } from '@/stores/feedbackStore'

export function registerFeedbackHandlers(bus: HoloEventBus) {
  bus.registerHandler('feedback:get-weight', (payload) => {
    const store = useFeedbackStore()
    return store.getWeightModifier(payload.skillId)
  })

  bus.registerHandler('feedback:get-weights', () => {
    const store = useFeedbackStore()
    return store.weights
  })

  bus.registerHandler('feedback:record-outcome', (payload) => {
    const store = useFeedbackStore()
    store.recordFeedback(
      payload.queryFingerprint,
      payload.matchedSkillId,
      payload.action,
      payload.contextFiles,
      payload.sessionId,
      payload.decisionContext
    )
  })
}
