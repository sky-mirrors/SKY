import type {
  KernelContext, KernelResult, DispatchOptions,
  RouteInput, RouteResult,
  CacheLookupResult, CacheStoreInput,
  SecurityCheckInput, SecurityCheckResult,
  BudgetCheckInput, BudgetCheckResult, BudgetRecordInput,
  FactCheckInput, FactCheckResult,
  LLMPort, PersistencePort, IOPort, ModelTier,
} from './types'
import { localStoragePersistence, createNamespacedPersistence } from './facades/persistence'
import { electronIOPort } from './facades/io'
import * as routeCluster from './clusters/route'
import * as cacheCluster from './clusters/cache'
import * as securityCluster from './clusters/security'
import * as budgetCluster from './clusters/budget'
import * as factCluster from './clusters/fact'
import { registerLLM, getLLM, unregisterLLM } from './plugins/llm'
import { HoloEventBus, globalBus } from './bus'

export interface HoloKernel {
  dispatch(input: string, options: DispatchOptions, context?: KernelContext): Promise<KernelResult>
  route: typeof routeCluster
  cache: typeof cacheCluster
  security: typeof securityCluster
  budget: typeof budgetCluster
  fact: typeof factCluster
  registerLLM(port: LLMPort): void
  persistence: PersistencePort
  io: IOPort
  bus: HoloEventBus
  destroy(): void
}

export function createKernel(options?: {
  persistence?: PersistencePort
  io?: IOPort
  namespace?: string
}): HoloKernel {
  const persistence = options?.namespace
    ? createNamespacedPersistence(options.namespace, options?.persistence ?? localStoragePersistence)
    : (options?.persistence ?? localStoragePersistence)
  const io = options?.io ?? electronIOPort
  const bus = globalBus

  const kernel: HoloKernel = {
    async dispatch(input: string, options: DispatchOptions, context?: KernelContext): Promise<KernelResult> {
      const effectiveContext: KernelContext = { ...context, persistence, io }

      let cacheHit: CacheLookupResult | null = null
      if (!options.stream) {
        cacheHit = await cacheCluster.lookup(input, context?.domain, effectiveContext)
        if (cacheHit.hit && cacheHit.responseText) {
          return {
            success: true,
            tier: cacheHit.tier ?? 'nano',
            responseText: cacheHit.responseText,
            fromCache: true,
            routingDecision: {
              tier: cacheHit.tier ?? 'nano',
              complexity: 'trivial',
              reason: 'cache-hit',
              confidence: 1.0,
              budgetCapped: false,
            },
            cacheHit,
            costRecord: {
              tier: cacheHit.tier ?? 'nano',
              promptTokens: cacheHit.promptTokens ?? 0,
              completionTokens: cacheHit.completionTokens ?? 0,
              cost: 0,
            },
          }
        }
      }

      const routeInput: RouteInput = {
        text: input,
        taskType: context?.taskType,
        callerId: context?.callerId,
        domain: context?.domain,
        manifestMaxTier: context?.manifestMaxTier,
        cacheHint: cacheHit?.hit ? { hit: true, tier: cacheHit.tier } : undefined,
      }
      const routeResult = routeCluster.route(routeInput, effectiveContext)

      const budgetResult = budgetCluster.check({
        estimatedTokens: routeResult.estimatedTokens,
        requestedTier: routeResult.tier,
      }, effectiveContext)

      if (!budgetResult.allowed) {
        return {
          success: false,
          tier: budgetResult.recommendedTier,
          fromCache: false,
          routingDecision: {
            tier: routeResult.tier,
            complexity: routeResult.complexity,
            reason: routeResult.reason,
            confidence: routeResult.confidence,
            budgetCapped: true,
          },
          budgetCheck: budgetResult,
          error: `budget-exceeded: ${budgetResult.reason}`,
        }
      }

      const effectiveTier = budgetResult.recommendedTier
      const budgetCapped = budgetResult.recommendedTier !== routeResult.tier

      let securityResult: SecurityCheckResult | undefined
      if (!options.skipSecurity && options.messages === undefined) {
        securityResult = await securityCluster.check({
          action: 'llm_generate',
          userInput: input,
        }, effectiveContext)
        if (!securityResult.safe) {
          return {
            success: false,
            tier: effectiveTier,
            fromCache: false,
            routingDecision: {
              tier: routeResult.tier,
              complexity: routeResult.complexity,
              reason: routeResult.reason,
              confidence: routeResult.confidence,
              budgetCapped,
            },
            budgetCheck: budgetResult,
            securityResult,
            error: `security-blocked: ${securityResult.reason}`,
          }
        }
      }

      if (!options.routeOnly && options.messages) {
        try {
          const llm = getLLM()
          let responseText: string | undefined
          let responseStream: AsyncIterable<string> | undefined
          let promptTokens = routeResult.estimatedTokens
          let completionTokens = 0

          if (options.stream) {
            responseStream = await llm.chatCompletionStream(options.messages, {
              tier: effectiveTier,
              taskType: context?.taskType,
              callerId: context?.callerId,
              domain: context?.domain,
              stream: true,
            })
          } else {
            const response = await llm.chatCompletion(options.messages, {
              tier: effectiveTier,
              taskType: context?.taskType,
              callerId: context?.callerId,
              domain: context?.domain,
            })
            responseText = response.content
            promptTokens = response.promptTokens
            completionTokens = response.completionTokens

            await cacheCluster.store({
              queryText: input,
              responseText: responseText,
              tier: effectiveTier,
              promptTokens,
              completionTokens,
              domain: context?.domain,
            }, effectiveContext)
          }

          const cost = budgetCluster.estimateCost(effectiveTier, promptTokens)
          budgetCluster.record({
            tier: effectiveTier,
            promptTokens,
            completionTokens,
            cost,
            category: context?.taskType ?? 'general',
          }, effectiveContext)

          let factResult: FactCheckResult | undefined
          if (!options.skipFactCheck && options.manifestRoles && responseText) {
            const sourceEntities = factCluster.extractEntitiesFromText(input)
            factResult = factCluster.check({
              llmOutput: responseText,
              sourceEntities,
              manifestRoles: options.manifestRoles,
              documents: options.documents,
            }, effectiveContext)
          }

          return {
            success: true,
            tier: effectiveTier,
            responseText,
            responseStream,
            fromCache: false,
            routingDecision: {
              tier: routeResult.tier,
              complexity: routeResult.complexity,
              reason: routeResult.reason,
              confidence: routeResult.confidence,
              budgetCapped,
            },
            budgetCheck: budgetResult,
            securityResult,
            factResult,
            costRecord: { tier: effectiveTier, promptTokens, completionTokens, cost },
          }
        } catch (err: any) {
          return {
            success: false,
            tier: effectiveTier,
            fromCache: false,
            routingDecision: {
              tier: routeResult.tier,
              complexity: routeResult.complexity,
              reason: routeResult.reason,
              confidence: routeResult.confidence,
              budgetCapped,
            },
            budgetCheck: budgetResult,
            error: err?.message ?? String(err),
          }
        }
      }

      return {
        success: true,
        tier: effectiveTier,
        fromCache: false,
        routingDecision: {
          tier: routeResult.tier,
          complexity: routeResult.complexity,
          reason: routeResult.reason,
          confidence: routeResult.confidence,
          budgetCapped,
        },
        budgetCheck: budgetResult,
        securityResult,
      }
    },

    route: routeCluster,
    cache: cacheCluster,
    security: securityCluster,
    budget: budgetCluster,
    fact: factCluster,

    registerLLM(port: LLMPort): void {
      registerLLM(port)
    },

    persistence,
    io,
    bus,

    destroy(): void {
      unregisterLLM()
    },
  }

  return kernel
}

export type { HoloKernel, KernelContext, KernelResult, DispatchOptions } from './types'
export { createNamespacedPersistence } from './facades/persistence'
export { registerLLM, getLLM } from './plugins/llm'
export { HoloEventBus, globalBus } from './bus'
export { createReadOnlyContext } from './context'
export type { ReadOnlyKernelContext } from './context'
export { getZOLState, resetZOL, DOMAIN_REWRITE_OFFSETS, DOMAIN_DISAMBIG_OFFSETS } from '@/services/strategySelector'
export { getRoutingZOLState, DOMAIN_ROUTING_TIER_BIAS, initSmartRouter } from '@/services/smartRouter'
export { getBudgetMode, setBudgetMode, getSessionSpent } from '@/services/tokenBudget'
export { initSemanticCache } from '@/services/semanticCache'
