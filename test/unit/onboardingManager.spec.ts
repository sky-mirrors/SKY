import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'
import { completeStep, isStepComplete, shouldShowOnboarding, resetOnboarding } from '@/services/onboardingManager'

describe('onboardingManager', () => {
  let configState: Record<string, unknown>

  beforeEach(() => {
    configState = {
      jobRole: undefined,
      apiConfigured: false,
      knowledgeFed: false,
      onboardingCompleted: false
    }
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })

    globalBus.registerHandler('config:get', (data: any) => configState)
    globalBus.registerHandler('config:get-onboarding-complete', (data: any) => !!configState.onboardingCompleted)
    globalBus.on('config:set-job-role', (role: any) => { configState.jobRole = role })
    globalBus.on('config:set-api-configured', (val: any) => { configState.apiConfigured = val })
    globalBus.on('config:set-knowledge-fed', (val: any) => { configState.knowledgeFed = val })
    globalBus.on('config:mark-onboarding-complete', () => { configState.onboardingCompleted = true })
    globalBus.on('config:reset-onboarding', () => {
      configState.onboardingCompleted = false
      configState.apiConfigured = false
      configState.knowledgeFed = false
      configState.jobRole = undefined
    })
  })

  afterEach(() => {
    globalBus.clear()
    vi.unstubAllGlobals()
  })

  it('shouldShowOnboarding is true by default', () => {
    expect(shouldShowOnboarding()).toBe(true)
  })

  it('isStepComplete returns false for steps 2-5 initially', () => {
    expect(isStepComplete(1)).toBe(true)
    expect(isStepComplete(2)).toBe(false)
    expect(isStepComplete(3)).toBe(false)
    expect(isStepComplete(4)).toBe(false)
    expect(isStepComplete(5)).toBe(false)
  })

  it('completeStep 2 sets jobRole', () => {
    completeStep(2, { jobRole: 'finance' })
    expect(configState.jobRole).toBe('finance')
  })

  it('completeStep 3 sets apiConfigured', () => {
    completeStep(3, { apiConfigured: true })
    expect(configState.apiConfigured).toBe(true)
    expect(isStepComplete(3)).toBe(true)
  })

  it('completeStep 4 sets knowledgeFed', () => {
    completeStep(4, { knowledgeFed: true })
    expect(configState.knowledgeFed).toBe(true)
    expect(isStepComplete(4)).toBe(true)
  })

  it('completeStep 5 marks onboarding complete', () => {
    completeStep(5)
    expect(shouldShowOnboarding()).toBe(false)
    expect(isStepComplete(5)).toBe(true)
  })

  it('resetOnboarding clears all flags', () => {
    completeStep(3, { apiConfigured: true })
    completeStep(5)
    expect(shouldShowOnboarding()).toBe(false)
    resetOnboarding()
    expect(shouldShowOnboarding()).toBe(true)
    expect(isStepComplete(3)).toBe(false)
  })

  it('isStepComplete returns false for invalid step', () => {
    expect(isStepComplete(99)).toBe(false)
  })
})
