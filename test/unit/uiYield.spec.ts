// 确诊根因回归测试：yieldToUI 不得依赖 requestAnimationFrame 单独完成——
// 窗口隐藏/遮挡时 rAF 不触发（document.hidden === true），若只等 rAF 则整个管线永久挂起。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { yieldToUI } from '@/services/uiYield'

describe('yieldToUI：rAF 不触发时仍须有界返回', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('rAF 永不回调（模拟 document.hidden）时 yieldToUI 仍有界 resolve', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0) // 永不回调
    const t0 = Date.now()
    await yieldToUI()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('rAF 正常时也在短时间内 resolve', async () => {
    let n = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { n++; setTimeout(() => cb(0), 0); return n })
    const t0 = Date.now()
    await yieldToUI()
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
