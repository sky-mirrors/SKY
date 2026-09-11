import { UserPricing, ModelTier, DEFAULT_USER_PRICING } from '@/models'
import { vault } from '@/vault'

let userPricing: UserPricing = { ...DEFAULT_USER_PRICING }

const TIER_PRICING_MAP: Record<ModelTier, { inputPricePer1k: number; outputPricePer1k: number }> = {
  nano: { inputPricePer1k: 0.0005, outputPricePer1k: 0.0015 },
  mini: { inputPricePer1k: 0.0015, outputPricePer1k: 0.006 },
  standard: { inputPricePer1k: 0.005, outputPricePer1k: 0.015 },
  pro: { inputPricePer1k: 0.0175, outputPricePer1k: 0.07 }
}

export function getUserPricing(): UserPricing {
  return { ...userPricing }
}

export function setUserPricing(pricing: Partial<UserPricing>): void {
  userPricing = { ...userPricing, ...pricing }
  savePricingToStorage()
}

export function resetUserPricing(): void {
  userPricing = { ...DEFAULT_USER_PRICING }
  savePricingToStorage()
}

export function getPricingForTier(tier: ModelTier): { inputPricePer1k: number; outputPricePer1k: number } {
  return TIER_PRICING_MAP[tier]
}

export interface CostCalculation {
  inputCost: number
  outputCost: number
  cacheSaving: number
  totalCost: number
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens: number = 0
): CostCalculation {
  const inputCost = (inputTokens / 1000) * userPricing.inputPricePer1k
  const outputCost = (outputTokens / 1000) * userPricing.outputPricePer1k
  const cacheSaving = (cacheHitTokens / 1000) * userPricing.inputPricePer1k * (1 - userPricing.cacheHitDiscount)
  const totalCost = inputCost + outputCost - cacheSaving
  return { inputCost, outputCost, cacheSaving, totalCost: Math.max(0, totalCost) }
}

export function calculateCostByTier(
  inputTokens: number,
  outputTokens: number,
  tier: ModelTier
): CostCalculation {
  const pricing = getPricingForTier(tier)
  const inputCost = (inputTokens / 1000) * pricing.inputPricePer1k
  const outputCost = (outputTokens / 1000) * pricing.outputPricePer1k
  return { inputCost, outputCost, cacheSaving: 0, totalCost: inputCost + outputCost }
}

export function estimateStepCost(tier: ModelTier, estimatedInputTokens: number): number {
  const pricing = getPricingForTier(tier)
  const estimatedOutputTokens = Math.min(estimatedInputTokens * 0.5, tier === 'nano' ? 512 : tier === 'mini' ? 1024 : tier === 'standard' ? 4096 : 8192)
  const inputCost = (estimatedInputTokens / 1000) * pricing.inputPricePer1k
  const outputCost = (estimatedOutputTokens / 1000) * pricing.outputPricePer1k
  return inputCost + outputCost
}

const PRICING_STORAGE_KEY = 'holo-user-pricing'

function savePricingToStorage(): void {
  try {
    vault.writeThrough('pricing', PRICING_STORAGE_KEY, JSON.stringify(userPricing))
  } catch { /* non-critical */ }
}

export function loadPricingFromStorage(): void {
  try {
    const raw = vault.readCache('pricing', PRICING_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UserPricing>
      userPricing = { ...DEFAULT_USER_PRICING, ...parsed }
    }
  } catch { /* non-critical */ }
}

export async function initPricingFromVault(): Promise<void> {
  const raw = await vault.read('pricing', PRICING_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<UserPricing>
      userPricing = { ...DEFAULT_USER_PRICING, ...parsed }
    } catch { /* non-critical */ }
  }
}
