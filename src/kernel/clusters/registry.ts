import * as defaultRoute from './route'
import * as defaultCache from './cache'
import * as defaultSecurity from './security'
import * as defaultBudget from './budget'
import * as defaultFact from './fact'

/**
 * 规格 6.3：簇注册表——五簇委托可换
 * - register 即时替换委托（影响下一个请求，在途请求持快照，M15）
 * - unregister 回退内核默认簇实现（簇不允许空缺）
 * - Phase 1 语义：实现委托可换；簇状态仍由各服务模块单例持有（规格如实声明的限制）
 */
export type ClusterKind = 'route' | 'cache' | 'security' | 'budget' | 'fact'

export type RouteClusterModule = typeof defaultRoute
export type CacheClusterModule = typeof defaultCache
export type SecurityClusterModule = typeof defaultSecurity
export type BudgetClusterModule = typeof defaultBudget
export type FactClusterModule = typeof defaultFact

export interface ClusterImpls {
  route: RouteClusterModule
  cache: CacheClusterModule
  security: SecurityClusterModule
  budget: BudgetClusterModule
  fact: FactClusterModule
}

const DEFAULTS: ClusterImpls = {
  route: defaultRoute,
  cache: defaultCache,
  security: defaultSecurity,
  budget: defaultBudget,
  fact: defaultFact,
}

export class ClusterRegistry {
  private custom = new Map<ClusterKind, unknown>()

  register<K extends ClusterKind>(kind: K, impl: ClusterImpls[K]): void {
    this.custom.set(kind, impl)
  }

  unregister(kind: ClusterKind): void {
    this.custom.delete(kind)
  }

  get<K extends ClusterKind>(kind: K): ClusterImpls[K] {
    const impl = this.custom.get(kind)
    return (impl !== undefined ? impl : DEFAULTS[kind]) as ClusterImpls[K]
  }

  /** M15：请求级快照——dispatch 开始时捕获，请求全程使用同一组簇引用 */
  snapshot(): Readonly<ClusterImpls> {
    return {
      route: this.get('route'),
      cache: this.get('cache'),
      security: this.get('security'),
      budget: this.get('budget'),
      fact: this.get('fact'),
    }
  }

  isCustom(kind: ClusterKind): boolean {
    return this.custom.has(kind)
  }
}

export const globalClusterRegistry = new ClusterRegistry()
