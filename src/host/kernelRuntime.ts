import { KernelRegistry } from './kernelRegistry'
import { createDefaultKernelPlugin } from '@/kernels/default/plugin'

/**
 * 内核运行时（Phase 3 灰度接线）：
 * 生产唯一 KernelRegistry 实例 + 默认内核插件的注册与激活。
 * App 挂载时调 initKernelRuntime()（幂等）；换内核经 registry.activate(M4 状态机)。
 */

export const kernelRegistry = new KernelRegistry()

export const DEFAULT_KERNEL_ID = 'kernel-default'

let initPromise: Promise<void> | null = null

export function initKernelRuntime(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const plugin = createDefaultKernelPlugin()
      const reg = kernelRegistry.register(plugin)
      if (!reg.ok) {
        throw new Error(`kernel register failed: ${reg.reason}`)
      }
      const act = await kernelRegistry.activate(plugin.id)
      if (!act.ok) {
        throw new Error(`kernel activate failed: ${act.reason}`)
      }
    })().catch(err => {
      // 失败允许重试（下次调用重新初始化）
      initPromise = null
      throw err
    })
  }
  return initPromise
}
