import type { RouteInput, RouteResult, KernelContext, L0DirectPlan, TaskComplexity } from '../types'
import { route as smartRoute, classifyComplexity, recordRoutingOutcome, detectOverkill, getHistoricalTokenAvg } from '@/services/smartRouter'
import { tryL0Skill, tryL05QuickMatch, checkL1Capability, classifyDomain, buildExplorePlan } from '@/services/l0SkillRouter'
import { estimateTokens } from '@/services/tokenEstimate'
import { checkBudget } from '@/services/tokenBudget'
import type { ModelTier } from '@/models'

export function route(input: RouteInput, context?: KernelContext): RouteResult {
  if (input.cacheHint?.hit) {
    return {
      tier: input.cacheHint.tier ?? 'nano',
      complexity: 'trivial',
      reason: 'cache-hit',
      confidence: 1.0,
      estimatedTokens: 0,
      estimatedCost: 0,
      budgetCapped: false,
      budgetAllowed: true,
      budgetRecommendedTier: input.cacheHint.tier ?? 'nano',
    }
  }

  const complexity = classifyComplexity({
    text: input.text,
    taskType: input.taskType,
    historicalTokenAvg: input.historicalTokenAvg ?? getHistoricalTokenAvg(input.taskType),
    domain: input.domain as any,
  })

  const routeInput = {
    text: input.text,
    taskType: input.taskType,
    callerId: input.callerId,
    historicalTokenAvg: input.historicalTokenAvg,
    domain: input.domain,
    manifestMaxTier: input.manifestMaxTier ?? context?.manifestMaxTier,
    cacheHint: input.cacheHint,
  }
  const decision = smartRoute(routeInput)

  const estimatedTokens = estimateTokens(input.text)
  const budgetResult = checkBudget(estimatedTokens, decision.tier as ModelTier)

  return {
    tier: decision.tier as ModelTier,
    complexity: complexity as TaskComplexity,
    reason: decision.reason,
    confidence: decision.confidence,
    estimatedTokens,
    estimatedCost: budgetResult.estimatedCost,
    budgetCapped: budgetResult.recommendedTier !== decision.tier,
    budgetAllowed: budgetResult.allowed,
    budgetRecommendedTier: budgetResult.recommendedTier as ModelTier,
  }
}

export async function tryDirectCommand(input: string): Promise<L0DirectPlan | null> {
  return tryL0Skill(input)
}

export function tryQuickMatch(input: string, manifests: any[]): any {
  return tryL05QuickMatch(input, manifests)
}

export function checkCapability(input: string): any {
  return checkL1Capability(input)
}

export function classifyInputDomain(input: string): string[] {
  return classifyDomain(input)
}

export function recordOutcome(tier: ModelTier, actualTokens: number, promptTokens: number, completionTokens: number, domain?: string): void {
  const overkill = detectOverkill(tier, actualTokens)
  recordRoutingOutcome({
    tier,
    complexity: 'moderate' as TaskComplexity,
    reason: 'kernel-dispatch',
    confidence: 0.9,
    actualTokens,
    promptTokens,
    completionTokens,
    overkill,
    domain,
  })
}
