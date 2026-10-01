import { describe, it, expect } from 'vitest'
import { createLiteKernelPlugin } from '@/kernels/lite/plugin'
import { createDefaultKernelPlugin } from '@/kernels/default/plugin'
import { KernelRegistry } from '@/host/kernelRegistry'

/**
 * 2026-10-01（用户裁定：第二个内核 = 直通内核）：让「换内核」有得换。
 * 锁定不变量：① 元数据可辨识；② route 直返**单步** llm_generate 计划（不做 L1–L4 编排）；
 * ③ 不实现默认内核特有方法（getHooks/runPreOutputGate）——不参与 pre-output 否决门；
 * ④ 与默认内核可共存于同一池（这才是「热插拔有得换」的前提）。
 */
describe('kernel-lite（直通内核）', () => {
  it('元数据：id / kind / display 可辨识', () => {
    const p = createLiteKernelPlugin()
    expect(p.id).toBe('kernel-lite')
    expect(p.kind).toBe('kernel')
    expect(p.manifest.display?.name).toContain('直通')
  })

  it('route 直接产出单步 llm_generate 计划（跳过工具匹配 / DAG 编排）', async () => {
    const p = createLiteKernelPlugin()
    const outcome = await p.route!('帮我查一下北京的天气', {} as never, undefined)
    expect(outcome.kind).toBe('plan')
    if (outcome.kind !== 'plan') throw new Error('unreachable')
    expect(outcome.plan.steps).toHaveLength(1)
    expect(outcome.plan.steps[0].tool).toBe('llm_generate')
    expect(outcome.plan.steps[0].depends_on).toEqual([])
    expect(outcome.plan.intent).toBe('帮我查一下北京的天气')
    expect(outcome.autoExecutable).toBe(true)
    expect(outcome.macroManifestId).toBeNull()
  })

  it('不实现 getHooks / runPreOutputGate（适配层判空放行，天然不参与否决门）', () => {
    const p = createLiteKernelPlugin() as unknown as Record<string, unknown>
    expect(p.getHooks).toBeUndefined()
    expect(p.runPreOutputGate).toBeUndefined()
  })

  it('与默认内核可共存于同一内核池 —— 热插拔「有得换」的前提', () => {
    const reg = new KernelRegistry()
    expect(reg.register(createDefaultKernelPlugin()).ok).toBe(true)
    expect(reg.register(createLiteKernelPlugin()).ok).toBe(true)
    expect(reg.listKernelIds().sort()).toEqual(['kernel-default', 'kernel-lite'])
  })
})
