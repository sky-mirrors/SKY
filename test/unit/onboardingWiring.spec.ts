import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { globalBus } from '@/kernel/bus'
import { registerConfigHandlers } from '@/domains/config/handlers'
import { useConfigStore } from '@/stores/configStore'
import { completeStep, isStepComplete, shouldShowOnboarding, resetOnboarding } from '@/services/onboardingManager'
import { JobRole } from '@/models'

/**
 * 机制体检（2026-09-25）：「onboardingManager 整模块零消费者」的真根因不是"没人调用"，
 * 而是**它依赖的 6 条 config:* 频道在生产里根本没接线**：
 *   - 5 条写频道（config:set-job-role / set-api-configured / set-knowledge-fed /
 *     mark-onboarding-complete / reset-onboarding）只被 emit，全仓无 bus.on 监听 → 空操作；
 *   - config:get-onboarding-complete 无处理器 → HoloEventBus.request 直接抛
 *     「no handler registered」；
 *   - config:get 空载荷在生产返回 store.config[undefined] = undefined，isStepComplete 读 .jobRole 抛。
 * 而 test/unit/onboardingManager.spec.ts **自建了这些监听/处理器**（beforeEach 手工注册），
 * 所以单测绿、生产死人——测试掩盖缺陷。
 *
 * 本文件反过来：只调 registerConfigHandlers（生产路径）+ 真实 configStore，验证模块真的能用。
 */
vi.mock('@/vault', () => ({
  vault: {
    list: vi.fn(async () => []),
    read: vi.fn(async () => null),
    readCache: vi.fn(() => null),
    writeThrough: vi.fn()
  }
}))

describe('onboardingManager 生产接线（真实 configStore，不自建 stub）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerConfigHandlers(globalBus)
  })

  afterEach(() => {
    globalBus.clear()
  })

  it('shouldShowOnboarding 不再抛（config:get-onboarding-complete 有处理器）', () => {
    expect(() => shouldShowOnboarding()).not.toThrow()
    expect(shouldShowOnboarding()).toBe(true)
  })

  it('completeStep(2) 真的把 jobRole 写进 configStore（写频道有监听）', () => {
    const store = useConfigStore()
    expect(store.currentJobRole).toBe(JobRole.General) // 默认值
    completeStep(2, { jobRole: JobRole.Legal })
    expect(store.currentJobRole).toBe(JobRole.Legal)
  })

  it('isStepComplete 反映真实状态（config:get 空载荷不再抛）', () => {
    expect(() => isStepComplete(3)).not.toThrow()
    expect(isStepComplete(3)).toBe(false)
    completeStep(3, { apiConfigured: true })
    expect(isStepComplete(3)).toBe(true)
  })

  it('走完收尾步后 shouldShowOnboarding 为 false', () => {
    completeStep(2, { jobRole: JobRole.Finance })
    completeStep(3, { apiConfigured: true })
    completeStep(5)
    expect(shouldShowOnboarding()).toBe(false)
    expect(isStepComplete(5)).toBe(true)
  })

  it('resetOnboarding 清空标志', () => {
    completeStep(3, { apiConfigured: true })
    completeStep(5)
    expect(shouldShowOnboarding()).toBe(false)
    resetOnboarding()
    expect(shouldShowOnboarding()).toBe(true)
    expect(isStepComplete(3)).toBe(false)
  })
})
