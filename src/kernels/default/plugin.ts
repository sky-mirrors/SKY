import type { KernelPlugin } from '@/host/kernelRegistry'
import type { FunnelBaseContext, FunnelGates, FunnelOutcome, LayerResult } from '@/kernel/funnel'
import { runFunnel } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import { createDefaultLayers, type DefaultKernelContext } from './index'

/**
 * 默认内核插件（id: kernel-default）。
 *
 * 灰度策略（规格 M16 / Phase 3）：本插件激活后仅提供 funnel 路由入口（route），
 * 与 dialogStore 旧六层内联实现并行运行做 shadow 对照（vault 配置 `config:holo-funnel-shadow` = '1'）；
 * 主路径切换后 route 成为 dispatch 的六层编排入口。
 *
 * 钩子（advisory/veto/override）由领域 pack 在内核激活后经 getHooks() 注册；
 * 每次内核重新 mount 重建 HookRunner（换内核 = 换整套钩子表，M4/M15）。
 */

export interface FunnelRouteOptions {
  gates?: Partial<FunnelGates>
  overrideTimeoutMs?: number
}

export interface DefaultKernelPlugin extends KernelPlugin {
  /** 六层路由入口：ctx 由适配层注入完整 DefaultKernelContext */
  route(input: string, ctx: FunnelBaseContext, options?: FunnelRouteOptions): Promise<FunnelOutcome>
  /** 领域 pack 钩子注册表（unmount 后丢弃） */
  getHooks(): HookRunner<LayerResult>
}

export function createDefaultKernelPlugin(): DefaultKernelPlugin {
  let hooks = new HookRunner<LayerResult>()

  const plugin: DefaultKernelPlugin = {
    id: 'kernel-default',
    version: '1.0.0',
    kind: 'kernel',
    manifest: {
      id: 'kernel-default',
      version: '1.0.0',
      kind: 'kernel',
      display: { name: '默认内核（六层漏斗）', description: 'L0-L4 六层任务编排路由，行为等价 dialogStore 旧六层内联实现' }
    },
    async mount(context) {
      hooks = new HookRunner<LayerResult>()
      context.logger.info('kernel-default mounted（六层漏斗路由就绪）')
    },
    async unmount() {
      // HookRunner 随实例丢弃；在途请求持 M15 快照跑完，不受影响
      hooks = new HookRunner<LayerResult>()
    },
    getHooks() {
      return hooks
    },
    route(input, ctx, options) {
      // 适配层契约：ctx 运行时为完整 DefaultKernelContext（此处类型收窄由调用方保证）
      const kernelCtx = ctx as DefaultKernelContext
      return runFunnel(
        {
          layers: createDefaultLayers(),
          hooks,
          gates: options?.gates,
          overrideTimeoutMs: options?.overrideTimeoutMs
        },
        input,
        kernelCtx
      )
    }
  }
  return plugin
}
