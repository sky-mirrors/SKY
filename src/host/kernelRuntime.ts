import { KernelRegistry } from './kernelRegistry'
import { createDefaultKernelPlugin } from '@/kernels/default/plugin'
import { createLiteKernelPlugin } from '@/kernels/lite/plugin'

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
      // 2026-10-01（用户裁定）：池中再入一个「直通内核」，让「换内核」有得换。
      // 注册失败只告警不阻断——默认内核仍是唯一保底，热插拔是增量能力（fail-visible 不 fail-fatal）。
      const liteReg = kernelRegistry.register(createLiteKernelPlugin())
      if (!liteReg.ok) {
        console.warn(`[kernel-runtime] 直通内核注册失败：${liteReg.reason}（不影响默认内核）`)
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
