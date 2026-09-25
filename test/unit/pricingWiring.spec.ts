import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { vault } from '@/vault'
import { getUserPricing, setUserPricing, resetUserPricing, initPricingFromVault, calculateCost } from '@/services/tokenPricing'
import { DEFAULT_USER_PRICING } from '@/models'

/**
 * 机制体检（2026-09-25）：tokenPricing 的**用户计价层**（getUserPricing / setUserPricing /
 * loadPricingFromStorage / initPricingFromVault）全仓零消费者，且无计价 UI。
 * setUserPricing 会落盘，但**没有任何 load 被调用** ⇒ 即便有写入方，重启也丢（写而不读）。
 * 「接」= ① 启动时把持久化读回来（initPricingFromVault）；② 设置页给出可读可写的计价面。
 * 本文件把这两条接线钉成契约，并验证读回后 calculateCost 真的用新单价。
 */
vi.mock('@/vault', () => ({
  vault: {
    list: vi.fn(async () => []),
    read: vi.fn(async () => null),
    readCache: vi.fn(() => null),
    writeThrough: vi.fn()
  }
}))

describe('用户计价层：持久化读回（写而不读 → 真读）', () => {
  beforeEach(() => {
    resetUserPricing()
    vi.mocked(vault.read).mockReset()
    vi.mocked(vault.read).mockResolvedValue(null as unknown as string)
  })

  it('initPricingFromVault 读回持久化单价，calculateCost 随即使用', async () => {
    vi.mocked(vault.read).mockResolvedValue(
      JSON.stringify({ inputPricePer1k: 0.02, outputPricePer1k: 0.06, cacheHitDiscount: 0.5 }) as unknown as string
    )
    await initPricingFromVault()
    expect(getUserPricing().inputPricePer1k).toBe(0.02)
    // 1k 输入 + 1k 输出 = 0.02 + 0.06
    expect(calculateCost(1000, 1000, 0).totalCost).toBeCloseTo(0.08)
  })

  it('无持久化时回退默认单价', async () => {
    vi.mocked(vault.read).mockResolvedValue(null as unknown as string)
    await initPricingFromVault()
    expect(getUserPricing().inputPricePer1k).toBe(DEFAULT_USER_PRICING.inputPricePer1k)
  })

  it('setUserPricing 后落盘、resetUserPricing 回默认', () => {
    setUserPricing({ inputPricePer1k: 0.1 })
    expect(getUserPricing().inputPricePer1k).toBe(0.1)
    expect(vault.writeThrough).toHaveBeenCalled()
    resetUserPricing()
    expect(getUserPricing().inputPricePer1k).toBe(DEFAULT_USER_PRICING.inputPricePer1k)
  })
})

describe('计价层接线（启动读回 + 设置页可读写）', () => {
  it('App.vue 启动时调用 initPricingFromVault', () => {
    const src = readFileSync(join(process.cwd(), 'src/App.vue'), 'utf-8')
    expect(src, '不调用 initPricingFromVault 时，setUserPricing 落盘的值重启即丢（写而不读）').toContain('initPricingFromVault')
  })

  it('SettingsPage 提供计价面（读 getUserPricing / 写 setUserPricing）', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/SettingsPage.vue'), 'utf-8')
    expect(src).toContain('getUserPricing')
    expect(src).toContain('setUserPricing')
  })
})
