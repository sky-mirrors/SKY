import { globalBus } from '@/kernel/bus'
import type { JobRole } from '@/models'

export interface OnboardingStepData {
  jobRole?: JobRole
  apiConfigured?: boolean
  knowledgeFed?: boolean
}

export function completeStep(step: number, data?: OnboardingStepData): void {
  switch (step) {
    case 1:
      break
    case 2:
      if (data?.jobRole) globalBus.emit('config:set-job-role', data.jobRole)
      break
    case 3:
      if (data?.apiConfigured) globalBus.emit('config:set-api-configured', true)
      break
    case 4:
      if (data?.knowledgeFed) globalBus.emit('config:set-knowledge-fed', true)
      break
    case 5:
      globalBus.emit('config:mark-onboarding-complete', {})
      break
  }
}

export function isStepComplete(step: number): boolean {
  const config = globalBus.request<{ jobRole?: string; apiConfigured?: boolean; knowledgeFed?: boolean; onboardingCompleted?: boolean }>('config:get', {})

  switch (step) {
    case 1: return true
    case 2: return config.jobRole !== undefined && config.jobRole !== null
    case 3: return config.apiConfigured ?? false
    case 4: return config.knowledgeFed ?? false
    case 5: return config.onboardingCompleted ?? false
    default: return false
  }
}

export function resetOnboarding(): void {
  globalBus.emit('config:reset-onboarding', {})
}

export function shouldShowOnboarding(): boolean {
  return !globalBus.request<boolean>('config:get-onboarding-complete', {})
}
