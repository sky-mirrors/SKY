import { describe, it, expect, vi, afterEach } from 'vitest'

// 与 packLoader.spec 相同的无头环境铺垫：vault IPC 走 mock
;(globalThis as any).window = {
  electronAPI: {
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
}

import { kernelRegistry, initKernelRuntime, DEFAULT_KERNEL_ID } from '@/host/kernelRuntime'
import { packLoader, initPackRuntime } from '@/host/packRuntime'
import type { KernelPlugin } from '@/host/kernelRegistry'
import type { DefaultKernelPlugin } from '@/kernels/default/plugin'
import type { DefaultKernelContext } from '@/kernels/default'
import type { FunnelOutcome } from '@/kernel/funnel'
import { getExternalConstraintIds, runConstraints } from '@/services/domainConstraints'
import { globalBus } from '@/kernel/bus'

/**
 * P3.6 全量验收：热插拔三项 dev 演练（规格 11.2 Phase 3 验收行）。
 * 与手动 dev 控制台操作等价，但固化在生产单例（kernelRegistry / packLoader）上可重复回归：
 *   一、换内核切换（M4 状态机 + kernel:switched 事件 + M15 钩子表重建）
 *   二、pack 热重载（M19 reloadPack 完整卸载-重挂循环 + 卸载即收缩）
 *   三、override 回退演示（M7 槽竞争 + M5.4 抛错/超时回退默认实现 + 释放恢复）
 *
 * 真实六层（不 mock 层服务）：ctx.isEmptyInput=true 跳过 L0-L3 直达 L4，
 * 全程零 LLM 调用（chatCompletion 断言未被调用）。
 */

const NEUTRAL_INPUT = '探索一下量子计算的基础概念'

function makeCtx(): DefaultKernelContext {
  return {
    allL2Manifests: [],
    mcpTools: [],
    visibleL2Ids: [],
    lastAssistantContent: '',
    recentUserMsg: '',
    isEmptyInput: true,
    chatCompletion: vi.fn(async () => ({ content: '' }))
  }
}

function makeDemoKernel(): KernelPlugin {
  return {
    id: 'kernel-demo-lite',
    version: '1.0.0',
    kind: 'kernel',
    manifest: {
      id: 'kernel-demo-lite',
      version: '1.0.0',
      kind: 'kernel',
      display: { name: '演示内核（固定路由）', description: 'P3.6 换内核演练用：route 恒返固定计划' }
    },
    async mount() { /* 演示内核无装配 */ },
    async unmount() { /* 演示内核无清理 */ },
    async route(): Promise<FunnelOutcome> {
      return {
        kind: 'plan',
        plan: { intent: 'demo-kernel-marker', needs: [], steps: [] },
        macroManifestId: null,
        autoExecutable: false,
        source: 'L4'
      }
    }
  }
}

describe('P3.6 验收一：换内核切换（M4 状态机）', () => {
  it('default → demo-lite → default：切换事件、旧内核卸载、路由换源、钩子表重建', async () => {
    await initKernelRuntime()
    expect(kernelRegistry.getActiveId()).toBe(DEFAULT_KERNEL_ID)
    expect(kernelRegistry.getState()).toBe('active')

    const defaultPlugin = kernelRegistry.getActive() as DefaultKernelPlugin
    const hooksBefore = defaultPlugin.getHooks()
    const unmountSpy = vi.spyOn(defaultPlugin, 'unmount')

    const switched: Array<{ from?: string; to?: string }> = []
    const off = globalBus.on('kernel:switched', (p: any) => switched.push(p))

    const demo = makeDemoKernel()
    expect(kernelRegistry.register(demo).ok).toBe(true)

    // 切到演示内核
    const toDemo = await kernelRegistry.activate(demo.id)
    expect(toDemo.ok).toBe(true)
    expect(kernelRegistry.getState()).toBe('active')
    expect(kernelRegistry.getActiveId()).toBe('kernel-demo-lite')
    expect(unmountSpy).toHaveBeenCalledTimes(1)

    // 路由由新内核服务
    const viaDemo = await kernelRegistry.route('任意输入', makeCtx())
    expect(viaDemo.kind).toBe('plan')
    if (viaDemo.kind === 'plan') expect(viaDemo.plan.intent).toBe('demo-kernel-marker')

    // 切回默认内核：真实六层（空输入 → L4 探索计划），零 LLM
    const ctx = makeCtx()
    const back = await kernelRegistry.activate(DEFAULT_KERNEL_ID)
    expect(back.ok).toBe(true)
    expect(kernelRegistry.getActiveId()).toBe(DEFAULT_KERNEL_ID)

    const viaDefault = await kernelRegistry.route(NEUTRAL_INPUT, ctx)
    expect(viaDefault.kind).toBe('plan')
    if (viaDefault.kind === 'plan') {
      expect(viaDefault.source).toBe('L4')
      expect(viaDefault.plan.intent).not.toBe('demo-kernel-marker')
    }
    expect(ctx.chatCompletion).not.toHaveBeenCalled()

    // kernel:switched 事件序列
    expect(switched).toEqual([
      { from: 'kernel-default', to: 'kernel-demo-lite' },
      { from: 'kernel-demo-lite', to: 'kernel-default' }
    ])

    // M15：换内核重挂后钩子表重建（旧 override/advisory 全部丢弃）
    expect(defaultPlugin.getHooks()).not.toBe(hooksBefore)

    off()
    unmountSpy.mockRestore()
  })
})

describe('P3.6 验收二：pack 热重载（M19）与卸载即收缩', () => {
  it('启动挂载 62 条 → reloadPack(legal) 完整卸载-重挂 → 行为保持', async () => {
    await initPackRuntime()
    // 2026-10-01：原为 toEqual(['finance','hr','legal']) —— 但本用例的意图是验证 legal 的
    // 卸载-重挂，不该顺带锁死"内置 pack 全集"（包会随扩展增加，demopack 即为一例）。
    expect(packLoader.listMounted().map(m => m.id).sort()).toEqual(expect.arrayContaining(['finance', 'hr', 'legal']))
    expect(getExternalConstraintIds()).toHaveLength(62)

    const fires = () => runConstraints({
      entities: [],
      sourceText: '员工张三于2024年1月1日入职，至今未签订劳动合同',
      outputText: '',
      stepResults: {},
      manifestRoles: ['legal']
    })
    expect(fires().some(r => r.constraintId === 'legal-labor-contract-written')).toBe(true)

    const lifecycle: string[] = []
    const offs = ['pack:mounted', 'pack:unmounted', 'pack:reloaded']
      .map(ch => globalBus.on(ch, (p: any) => lifecycle.push(p?.packId ? `${ch}:${p.packId}` : ch)))

    const reload = await packLoader.reloadPack('legal')
    expect(reload.ok).toBe(true)
    expect(typeof reload.durationMs).toBe('number')
    expect(lifecycle).toEqual(['pack:unmounted:legal', 'pack:mounted:legal', 'pack:reloaded:legal'])

    // 重载后行为保持：仍 62 条、原约束仍触发
    expect(getExternalConstraintIds()).toHaveLength(62)
    expect(fires().some(r => r.constraintId === 'legal-labor-contract-written')).toBe(true)
    offs.forEach(off => off())
  })

  it('卸载即收缩：unmountPack(legal) → 约束摘至 12 条；重新挂载恢复 62 条', async () => {
    await initPackRuntime()
    const unmount = await packLoader.unmountPack('legal')
    expect(unmount.ok).toBe(true)
    expect(unmount.removedConstraints).toBe(50)
    expect(getExternalConstraintIds()).toHaveLength(12)

    const remount = await packLoader.mountPack('legal')
    expect(remount.ok).toBe(true)
    expect(getExternalConstraintIds()).toHaveLength(62)
  })
})

describe('P3.6 验收三：override 回退演示（M7/M5.4）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('命中接管 → 抛错回退默认 → 超时回退默认 → 低优先级竞争被拒 → 释放恢复', async () => {
    await initKernelRuntime()
    const plugin = kernelRegistry.getActive() as DefaultKernelPlugin
    const hooks = plugin.getHooks()
    const warned = () => warnSpy.mock.calls.map(c => c.join(' ')).join('\n')

    // 1. override 命中：接管 L4，产出自定义计划
    const hitReg = hooks.registerOverride({
      pluginId: 'demo-pack', layer: 'L4', priority: 10,
      impl: () => ({ kind: 'plan', plan: { intent: 'override-hit-marker', needs: [], steps: [] }, macroManifestId: null })
    })
    expect(hitReg.ok).toBe(true)

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hit = await kernelRegistry.route(NEUTRAL_INPUT, makeCtx())
    expect(hit.kind).toBe('plan')
    if (hit.kind === 'plan') {
      expect(hit.source).toBe('L4')
      expect(hit.plan.intent).toBe('override-hit-marker')
      expect(hit.autoExecutable).toBe(true) // 无 shell → 自动执行
    }

    // 2. 高优先级替换入槽（M7 displaced），impl 抛错 → 回退默认 L4 + 审计
    const throwReg = hooks.registerOverride({
      pluginId: 'demo-pack', layer: 'L4', priority: 20,
      impl: () => { throw new Error('override-boom') }
    })
    expect(throwReg.ok).toBe(true)

    const fb = await kernelRegistry.route(NEUTRAL_INPUT, makeCtx())
    expect(fb.kind).toBe('plan')
    if (fb.kind === 'plan') expect(fb.plan.intent).not.toBe('override-hit-marker')
    expect(warned()).toContain('override:fallback')
    expect(warned()).toContain('override-boom')

    // 3. 超时回退：慢 impl + overrideTimeoutMs=30 → 默认实现 + timeout 审计
    const slowReg = hooks.registerOverride({
      pluginId: 'demo-pack', layer: 'L4', priority: 30,
      impl: async () => { await new Promise(r => setTimeout(r, 150)); return { kind: 'miss' } }
    })
    expect(slowReg.ok).toBe(true)

    const slow = await kernelRegistry.route(NEUTRAL_INPUT, makeCtx(), { overrideTimeoutMs: 30 })
    expect(slow.kind).toBe('plan')
    if (slow.kind === 'plan') expect(slow.plan.intent).not.toBe('override-hit-marker')
    expect(warned()).toContain('timeout after 30ms')

    // 4. M7 槽竞争：低优先级挑战者被拒
    const challenger = hooks.registerOverride({
      pluginId: 'demo-pack-low', layer: 'L4', priority: 5,
      impl: () => ({ kind: 'miss' })
    })
    expect(challenger.ok).toBe(false)

    // 5. 释放恢复：unregisterPlugin → 槽空、路由回默认实现
    hooks.unregisterPlugin('demo-pack')
    expect(hooks.getOverrideOccupant('L4')).toBeUndefined()
    const restored = await kernelRegistry.route(NEUTRAL_INPUT, makeCtx())
    expect(restored.kind).toBe('plan')
    if (restored.kind === 'plan') expect(restored.plan.intent).not.toBe('override-hit-marker')
  })
})
