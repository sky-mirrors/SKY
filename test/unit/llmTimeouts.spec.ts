// P0-B（A3 修复批）：LLM 超时统一阶梯回归测试。
// 背景：首考执行类失败 7/18 题，根因之一为 15s/45s/75s/120s 旧阶梯在 CPU 后端
// （~10 tok/s）结构性不可行；本 spec 锁定新阶梯 CPU 校准值与绝对上限。
import { describe, it, expect, vi } from 'vitest'
import { tierTimeoutFor, timeoutSignalWithReason, LLM_TIMEOUT_ABSOLUTE_CAP_MS } from '@/services/llmTimeouts'

describe('llmTimeouts (P0-B)', () => {
  describe('tierTimeoutFor', () => {
    it('≤512 档 → 60s（nano/micro 调用，512 满额 ~51s + 余量）', () => {
      expect(tierTimeoutFor(128)).toBe(60000)
      expect(tierTimeoutFor(512)).toBe(60000)
    })

    it('≤4096 档 → 150s', () => {
      expect(tierTimeoutFor(513)).toBe(150000)
      expect(tierTimeoutFor(2048)).toBe(150000)
      expect(tierTimeoutFor(4096)).toBe(150000)
    })

    it('≤8192 档 → 240s', () => {
      expect(tierTimeoutFor(4097)).toBe(240000)
      expect(tierTimeoutFor(8192)).toBe(240000)
    })

    it('>8192 档 → 300s 兜底', () => {
      expect(tierTimeoutFor(8193)).toBe(300000)
      expect(tierTimeoutFor(32768)).toBe(300000)
    })

    it('scale 整体缩放各档', () => {
      expect(tierTimeoutFor(512, 2)).toBe(120000)
      expect(tierTimeoutFor(4096, 0.5)).toBe(75000)
      expect(tierTimeoutFor(16384, 3)).toBe(600000) // 300s×3=900s → 钳到绝对上限 600s
    })

    it('scale 放大不超过绝对上限 600s', () => {
      expect(tierTimeoutFor(512, 10)).toBe(LLM_TIMEOUT_ABSOLUTE_CAP_MS)
      expect(tierTimeoutFor(16384, 5)).toBe(LLM_TIMEOUT_ABSOLUTE_CAP_MS)
      expect(LLM_TIMEOUT_ABSOLUTE_CAP_MS).toBe(600000)
    })

    it('非法 scale（NaN/0/负数）回退 1', () => {
      expect(tierTimeoutFor(512, Number('x'))).toBe(60000)
      expect(tierTimeoutFor(512, 0)).toBe(60000)
      expect(tierTimeoutFor(512, -2)).toBe(60000)
    })

    it('默认 scale=1', () => {
      expect(tierTimeoutFor(512)).toBe(60000)
    })
  })

  describe('timeoutSignalWithReason', () => {
    it('超时触发 abort 且 reason 为 TimeoutError DOMException，带 label 文案', async () => {
      const handle = timeoutSignalWithReason(20, 'LLM stream (maxTok=512)')
      const promise = new Promise<DOMException>((resolve) => {
        handle.signal.addEventListener('abort', () => {
          resolve(handle.signal.reason as DOMException)
        })
      })
      const reason = await promise
      expect(reason).toBeInstanceOf(DOMException)
      expect(reason.name).toBe('TimeoutError')
      expect(reason.message).toContain('LLM stream (maxTok=512) timeout after 20ms')
    })

    it('dispose 清理计时器，信号不再落地', async () => {
      const handle = timeoutSignalWithReason(20, 'test')
      handle.dispose()
      await new Promise((r) => setTimeout(r, 60))
      expect(handle.signal.aborted).toBe(false)
    })

    it('dispose 幂等且未 dispose 前信号未触发', () => {
      const handle = timeoutSignalWithReason(5000, 'test')
      expect(handle.signal.aborted).toBe(false)
      handle.dispose()
      handle.dispose()
    })

    it('abort reason 消息可被 errorClassifier timeout 关键词命中', async () => {
      const handle = timeoutSignalWithReason(10, 'LLM non-stream')
      const promise = new Promise<DOMException>((resolve) => {
        handle.signal.addEventListener('abort', () => resolve(handle.signal.reason as DOMException))
      })
      const reason = await promise
      const lowered = reason.message.toLowerCase()
      expect(lowered).toContain('timeout')
      expect(reason.name.toLowerCase()).toBe('timeouterror')
    })
  })

  describe('macroExecutor stepTimeout 语义（B2 锁定）', () => {
    it('无显式 override 时不应存在 8s/15s 本地默认计时（STEP_TIMEOUT_MS 已删除）', async () => {
      // 直接读源码锁定：STEP_TIMEOUT_MS 常量不再存在，防止回归复活旧阶梯
      const fs = await import('fs')
      const path = await import('path')
      const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/services/macroExecutor.ts'),
        'utf-8'
      )
      expect(src).not.toContain('const STEP_TIMEOUT_MS')
      expect(src).toContain('const stepTimeout = timeoutMs || null')
      // 本地计时器 abort 必须带 TimeoutError 理由（B3 确定性归类依赖）
      expect(src).toContain("'TimeoutError')")
    })
  })
})
