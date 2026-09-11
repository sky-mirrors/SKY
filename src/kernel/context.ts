import type { KernelResult, RoutingDecisionResult, BudgetCheckResult, SecurityCheckResult, FactCheckResult, CacheLookupResult } from './types'

export interface ReadOnlyKernelContext {
  readonly routingResult?: Readonly<RoutingDecisionResult>
  readonly cacheResult?: Readonly<CacheLookupResult>
  readonly budgetStatus?: Readonly<BudgetCheckResult>
  readonly securityResult?: Readonly<SecurityCheckResult>
  readonly factResult?: Readonly<FactCheckResult>
  readonly domain?: string
  readonly sessionId?: string
  readonly taskType?: string
}

export function createReadOnlyContext(result: KernelResult, domain?: string, sessionId?: string, taskType?: string): ReadOnlyKernelContext {
  return Object.freeze({
    routingResult: result.routingDecision ? Object.freeze({ ...result.routingDecision }) : undefined,
    cacheResult: result.cacheHit ? Object.freeze({ ...result.cacheHit }) : undefined,
    budgetStatus: result.budgetCheck ? Object.freeze({ ...result.budgetCheck }) : undefined,
    securityResult: result.securityResult ? Object.freeze({ ...result.securityResult }) : undefined,
    factResult: result.factResult ? Object.freeze({ ...result.factResult }) : undefined,
    domain,
    sessionId,
    taskType,
  })
}
