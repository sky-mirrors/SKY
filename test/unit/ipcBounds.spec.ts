import { describe, it, expect, vi } from 'vitest'
import { readBodyCapped, readCapped, readJsonCapped, safeSendTo } from '@electron/ipcBounds'

/**
 * 主进程有界性（快照 §十一 P1/P2 第 2 条 E-5 / E-6 / E-7）。
 *
 * 这三项原本散在 `electron/ipc-handlers.ts`（依赖 electron，无法单测）。本模块把其中
 * **纯逻辑**抽成叶子实现，使「体积上限」与「发送前判存活」可被断言钉住。
 */

function respOf(text: string): Response {
  return new Response(text)
}

describe('ipcBounds —— 主进程有界性叶子实现', () => {
  it('readCapped 超上限时返回 truncated=true 并截到上限', async () => {
    const r = await readCapped(respOf('abcdefghij'), 4)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('abcd')
  })

  it('readCapped 未超上限时不标记截断', async () => {
    const r = await readCapped(respOf('abc'), 16)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('abc')
  })

  it('readBodyCapped 保持原语义：截断即返回部分内容', async () => {
    expect(await readBodyCapped(respOf('abcdefghij'), 4)).toBe('abcd')
    expect(await readBodyCapped(respOf('abc'), 16)).toBe('abc')
  })

  it('E-6｜readJsonCapped 正常解析上限内的 JSON', async () => {
    const v = await readJsonCapped<{ a: number }>(respOf('{"a":1}'), 1024)
    expect(v.a).toBe(1)
  })

  it('E-6｜readJsonCapped 超上限即抛错，不把截断文本喂给 JSON.parse', async () => {
    const big = `{"a":"${'x'.repeat(200)}"}`
    await expect(readJsonCapped(respOf(big), 16)).rejects.toThrow(/上限/)
  })

  it('E-7｜safeSendTo 在 sender 已销毁时不发送、返回 false', () => {
    const sender = { isDestroyed: () => true, send: vi.fn() }
    expect(safeSendTo(sender, 'ch', { x: 1 })).toBe(false)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('E-7｜safeSendTo 在 sender 存活时投递并返回 true', () => {
    const sender = { isDestroyed: () => false, send: vi.fn() }
    expect(safeSendTo(sender, 'ch', { x: 1 })).toBe(true)
    expect(sender.send).toHaveBeenCalledWith('ch', { x: 1 })
  })

  it('E-7｜safeSendTo 吞掉 send 抛错并返回 false（保证其后的控制器清理可达）', () => {
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(() => { throw new Error('[Object has been destroyed]') })
    }
    expect(safeSendTo(sender, 'ch', {})).toBe(false)
  })
})
