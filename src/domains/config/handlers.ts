import type { HoloEventBus } from '@/kernel/bus'
import { useConfigStore } from '@/stores/configStore'
import { getAllTerms } from '@/services/terminologyMap'
import type { JobRole } from '@/models'

// 2026-09-25（机制体检）：onboardingManager 依赖的 config:* 频道此前在生产里没接线 ——
//   · 5 条写频道（config:set-job-role / set-api-configured / set-knowledge-fed /
//     mark-onboarding-complete / reset-onboarding）只被 globalBus.emit，全仓无 bus.on 监听 ⇒ 空操作；
//   · config:get-onboarding-complete 无处理器 ⇒ HoloEventBus.request 直接抛「no handler registered」；
//   · config:get 空载荷返回 store.config[undefined] ⇒ 消费方（isStepComplete / commandPaletteSearch）读字段时抛。
// HoloEventBus 语义：emit 只达 on()、request 只达 registerHandler —— 两条路都要挂。
// HMR 重挂载先释放旧订阅（registerHandler 覆盖式，on 累积，故写频道用带 disposer 的 on）。

type Disposer = (() => void) | null
let _disposeSetJobRole: Disposer = null
let _disposeSetApiConfigured: Disposer = null
let _disposeSetKnowledgeFed: Disposer = null
let _disposeMarkOnboarding: Disposer = null
let _disposeResetOnboarding: Disposer = null

export function registerConfigHandlers(bus: HoloEventBus) {
  bus.registerHandler('config:get', (payload) => {
    const store = useConfigStore()
    const key = payload?.key as keyof typeof store.config | undefined
    // 无 key ⇒ 返回完整配置快照：onboardingManager.isStepComplete 与 commandPaletteSearch
    // 都按"整份配置"使用（此前返回 store.config[undefined] = undefined，两处都会抛）。
    if (key === undefined || key === null) return { ...store.config }
    return store.config[key]
  })

  bus.registerHandler('config:set', (payload) => {
    const store = useConfigStore()
    const setter = `set${payload.key[0].toUpperCase()}${payload.key.slice(1)}` as keyof typeof store
    const fn = store[setter]
    if (typeof fn === 'function') {
      (fn as (v: unknown) => void)(payload.value)
    }
  })

  bus.registerHandler('config:get-terminology', () => {
    return getAllTerms()
  })

  // onboardingManager 读侧：shouldShowOnboarding 经 request 调用 → registerHandler
  bus.registerHandler('config:get-onboarding-complete', () => {
    return useConfigStore().config.onboardingCompleted ?? false
  })

  // onboardingManager 写侧：completeStep / resetOnboarding 经 emit 发布 → 必须 bus.on
  const setJobRoleHandler = (role: unknown) => {
    useConfigStore().setJobRole(role as JobRole)
  }
  _disposeSetJobRole?.()
  _disposeSetJobRole = bus.on('config:set-job-role', setJobRoleHandler as (payload: unknown) => unknown)

  const setApiConfiguredHandler = (value: unknown) => {
    useConfigStore().setApiConfigured(Boolean(value))
  }
  _disposeSetApiConfigured?.()
  _disposeSetApiConfigured = bus.on('config:set-api-configured', setApiConfiguredHandler as (payload: unknown) => unknown)

  const setKnowledgeFedHandler = (value: unknown) => {
    useConfigStore().setKnowledgeFed(Boolean(value))
  }
  _disposeSetKnowledgeFed?.()
  _disposeSetKnowledgeFed = bus.on('config:set-knowledge-fed', setKnowledgeFedHandler as (payload: unknown) => unknown)

  const markOnboardingHandler = () => {
    useConfigStore().markOnboardingComplete()
  }
  _disposeMarkOnboarding?.()
  _disposeMarkOnboarding = bus.on('config:mark-onboarding-complete', markOnboardingHandler)

  const resetOnboardingHandler = () => {
    useConfigStore().resetOnboarding()
  }
  _disposeResetOnboarding?.()
  _disposeResetOnboarding = bus.on('config:reset-onboarding', resetOnboardingHandler)
}
