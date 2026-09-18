import type { HoloEventBus } from '@/kernel/bus'
import type { SideEffectManifest } from '@/models'
import { useFeedbackStore } from '@/stores/feedbackStore'

// A2-5：add-side-effect 经 emit() 发布 → 必须 on() 桥接（HMR 重挂载先释放旧订阅）
let _disposeSideEffect: (() => void) | null = null

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

  // A2-5：执行副作用清单回流 store（undoExecution 撤销功能的数据源）；
  // payload 字段与 SideEffectManifest 对齐，内部 push 后自动持久化（saveSideEffects）
  const sideEffectHandler = (payload: unknown) => {
    const m = payload as Partial<SideEffectManifest> | null
    if (!m || typeof m.executionId !== 'string' || !Array.isArray(m.sideEffects)) return
    useFeedbackStore().addSideEffectManifest(m as SideEffectManifest)
  }
  _disposeSideEffect?.()
  _disposeSideEffect = bus.on('feedback:add-side-effect', sideEffectHandler)
}
