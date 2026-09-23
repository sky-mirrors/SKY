/**
 * 双模型并存（用户 2026-09-23 需求）：把「档位」绑定到具体的 provider + model。
 *
 * 背景：`apiStore` 的请求组装原先只读单一 `activeModel` / `activeProviderId`
 * （`ipcArgs` 处），且 `MODEL_TIER_CONFIG` 只调 maxTokens/temperature、**从不切换真实模型**
 * （项目文档记为 G-7）。本模块提供纯解析：有绑定时按档位选模型，无绑定则完全回退单值配置
 * （向后兼容，老配置零迁移）。
 */
export type BindableTier = 'nano' | 'mini' | 'standard' | 'pro'

export interface TierModelBinding {
  providerId: string
  model: string
}

/** 解析所需的最小配置形状（避免与 store 的类型循环依赖） */
export interface TierBindingConfig {
  activeProviderId: string
  activeModel: string
  providers: { id: string; models: { id: string }[] }[]
  tierModels?: Partial<Record<BindableTier, TierModelBinding>> | null
}

export interface TierTarget {
  providerId: string
  model: string
}

/**
 * 依据档位解析实际要用的 provider+model。
 * 三种情形：
 * 1) 该档位有绑定且 provider/model 在已配置列表中存在 → 用绑定；
 * 2) 有绑定但 provider 或 model 已不存在（配置被删/改名） → 回退单值（不抛错，保证可用性）；
 * 3) 无绑定 → 回退单值。
 */
export function resolveTierTarget(config: TierBindingConfig, tier: string): TierTarget {
  const fallback: TierTarget = { providerId: config.activeProviderId, model: config.activeModel }
  const bind = config.tierModels ? config.tierModels[tier as BindableTier] : undefined
  if (!bind || !bind.providerId || !bind.model) return fallback
  const provider = config.providers.find(p => p.id === bind.providerId)
  if (!provider || !provider.models.some(m => m.id === bind.model)) return fallback
  return { providerId: bind.providerId, model: bind.model }
}
