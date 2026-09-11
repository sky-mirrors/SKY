import type { BudgetCheckInput, BudgetCheckResult, BudgetRecordInput, KernelContext } from '../types'
import { checkBudget, recordLlmCost, getBudgetMode, getBudgetStatus, getSessionSpent } from '@/services/tokenBudget'
import { estimateTokens, estimateMessagesTokens } from '@/services/tokenEstimate'
import { calculateCost, estimateStepCost } from '@/services/tokenPricing'
import type { ModelTier } from '@/models'

export function check(input: BudgetCheckInput, context?: KernelContext): BudgetCheckResult {
  const result = checkBudget(input.estimatedTokens, input.requestedTier)
  return {
    allowed: result.allowed,
    recommendedTier: result.recommendedTier as ModelTier,
    reason: result.reason,
    estimatedCost: result.estimatedCost,
  }
}

export function record(input: BudgetRecordInput, context?: KernelContext): void {
  recordLlmCost(
    input.tier,
    input.promptTokens,
    input.completionTokens,
    input.cacheHitTokens ?? 0,
    input.category ?? 'general',
  )
}

export function estimateTokenCount(text: string): number {
  return estimateTokens(text)
}

export function estimateCost(tier: ModelTier, estimatedInputTokens: number): number {
  return estimateStepCost(tier, estimatedInputTokens)
}

export function status(): any {
  return getBudgetStatus()
}

export function getMode(): string {
  return getBudgetMode()
}
