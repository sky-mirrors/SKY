import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { L2ToolManifest } from '@/models'

vi.mock('@/kernels/default', () => ({
  createDefaultLayers: vi.fn(() => ({
    l0: vi.fn(), l05: vi.fn(), l1: vi.fn(), l2: vi.fn(), l3: vi.fn(), l4: vi.fn()
  }))
}))
vi.mock('@/kernel/funnel', () => ({
  runFunnel: vi.fn(async () => ({ kind: 'error', error: 'mock-funnel' }))
}))

import { kernelRegistry, initKernelRuntime, DEFAULT_KERNEL_ID } from '@/host/kernelRuntime'
import { KernelRegistry } from '@/host/kernelRegistry'
import { createDefaultKernelPlugin } from '@/kernels/default/plugin'
import { runFunnel } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import type { DefaultKernelContext } from '@/kernels/default'

function makeCtx(): DefaultKernelContext {
  return {
    allL2Manifests: [] as L2ToolManifest[],
    mcpTools: [],
    visibleL2Ids: [],
    lastAssistantContent: '',
    recentUserMsg: '',
    chatCompletion: vi.fn(async () => ({ content: '' }))
  }
}

describe('P3.4：内核运行时接线（KernelRegistry 生产实例 + route 入口）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initKernelRuntime：注册并激活默认内核；幂等（重复调用不重复注册）', async () => {
    await initKernelRuntime()
    expect(kernelRegistry.getActiveId()).toBe(DEFAULT_KERNEL_ID)
    expect(kernelRegistry.getState()).toBe('active')
    const before = kernelRegistry.getActive()
    await initKernelRuntime()
    expect(kernelRegistry.getActiveId()).toBe(DEFAULT_KERNEL_ID)
    expect(kernelRegistry.getActive()).toBe(before)
  })

  it('激活内核的 route → 委托 runFunnel（input/ctx/gates 透传）', async () => {
    await initKernelRuntime()
    vi.mocked(runFunnel).mockResolvedValueOnce({
      kind: 'plan',
      plan: { intent: 'i', needs: [], steps: [] },
      macroManifestId: null,
      autoExecutable: false,
      source: 'L2'
    })
    const ctx = makeCtx()
    const outcome = await kernelRegistry.route('查合同', ctx, { gates: { l05Pass: 0.7 } })
    expect(outcome.kind).toBe('plan')
    expect(runFunnel).toHaveBeenCalledTimes(1)
    const [config, input, ctxArg] = vi.mocked(runFunnel).mock.calls[0]
    expect(input).toBe('查合同')
    expect(ctxArg).toBe(ctx)
    expect(config.gates).toEqual({ l05Pass: 0.7 })
    expect(config.layers).toBeDefined()
  })

  it('默认内核插件：mount 重建钩子表，unmount 丢弃；getHooks 始终可用', async () => {
    const plugin = createDefaultKernelPlugin()
    const hooksBefore = plugin.getHooks()
    expect(hooksBefore).toBeInstanceOf(HookRunner)
    await plugin.mount({
      bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn(), request: vi.fn(), requestAsync: vi.fn() } as never,
      config: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() } as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      validate: { validate: vi.fn(() => ({ ok: true, errors: [] })) } as never
    })
    const hooksMounted = plugin.getHooks()
    expect(hooksMounted).not.toBe(hooksBefore)
    expect(hooksMounted).toBeInstanceOf(HookRunner)
    await plugin.unmount()
    expect(plugin.getHooks()).not.toBe(hooksMounted)
  })

  it('未激活注册表：route → kernel-vacant；激活无 route 内核 → kernel-vacant', async () => {
    const reg = new KernelRegistry()
    const vacant = await reg.route('x', makeCtx())
    expect(vacant).toEqual({ kind: 'error', error: 'kernel-vacant' })

    const bareKernel = {
      ...createDefaultKernelPlugin(),
      route: undefined
    }
    expect(reg.register(bareKernel).ok).toBe(true)
    await reg.activate(bareKernel.id)
    const stillVacant = await reg.route('x', makeCtx())
    expect(stillVacant).toEqual({ kind: 'error', error: 'kernel-vacant' })
  })
})
