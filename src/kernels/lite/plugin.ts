import type { KernelPlugin } from '@/host/kernelRegistry'
import type { TaskPlan } from '@/models'

/**
 * 2026-10-01（用户裁定）：第二个内核 —— 「直通内核」。
 *
 * 用途：让「热插拔换内核」真的有得换，且换完**行为可见地不同**。
 * 语义：跳过 L0.5–L4 的全部编排（工具匹配、知识检索、候选消歧、DAG 规划），
 * 直接产出一个单步 `llm_generate` 计划 ⇒ 同一个输入，默认内核会去查工具/建 DAG，
 * 直通内核只会让模型直接作答。
 *
 * 与默认内核的关系：**不是替代**。默认内核（六层漏斗）的全部功能原样保留，
 * 本内核只是内核池里的另一个可选项，可随时切回（`kernelRegistry.activate('kernel-default')`）。
 *
 * 契约提醒：这里**不实现** `getHooks` / `runPreOutputGate`（默认内核特有方法）。
 * 适配层对缺失方法是判空放行的（见 DefaultKernelPlugin 注释「无此方法的内核由适配层判空直接放行」），
 * 故直通内核天然不参与 pre-output 否决门 —— 这是有意的：它不做编排，也就没有可否决的编排产物。
 */
export function createLiteKernelPlugin(): KernelPlugin {
  return {
    id: 'kernel-lite',
    version: '1.0.0',
    kind: 'kernel',
    manifest: {
      id: 'kernel-lite',
      version: '1.0.0',
      kind: 'kernel',
      display: {
        name: '直通内核（无编排）',
        description: '跳过 L1–L4：不做工具匹配 / 知识检索 / 候选消歧，直接单步 LLM 生成'
      }
    },
    async mount(context) {
      context.logger.info('kernel-lite mounted（直通模式：单步 LLM 生成，无编排）')
    },
    async unmount() {
      // 无内部状态（不持有 HookRunner / 缓存 / 在途登记），无需清理
    },
    async route(input, _ctx, _options) {
      const plan: TaskPlan = {
        intent: input,
        needs: [],
        steps: [
          {
            step: 1,
            description: '直接生成回复（直通内核：不做工具匹配 / DAG 编排）',
            tool: 'llm_generate',
            depends_on: [],
            params: { prompt: input },
            expectedOutput: '对用户输入的回复'
          }
        ]
      }
      return { kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' }
    }
  }
}
