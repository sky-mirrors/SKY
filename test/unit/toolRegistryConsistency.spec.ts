// 原生工具名单一致性守卫（防漂移）。
//
// 背景（HANDOFF 下一步 3 的 Q15 UI 验证复现）：仓库曾有**两份** NATIVE_TOOL_NAMES——
//   · src/services/nativeTools.ts  → 数组，「常驻工具」（暴露给模型的工具）
//   · src/services/toolRegistry.ts → ReadonlySet，「可原生 dispatch 的工具」（confirmPlan 的 isAllNative 快路径判定用）
// `rename_images_by_date`（Q15 确定性化引入）当时只登记在 nativeTools.ts，toolRegistry 的 Set 漏了它 ⇒
// Q15 的单步原生计划被误判为「非全原生」、不走确定性快路径，落进模型循环，弱模型**编造**重命名结果、文件未改名。
//
// **现已收敛为单一来源**：toolRegistry.NATIVE_TOOL_NAMES 从 nativeTools.NATIVE_TOOL_NAMES 派生（见其源码注释），
// 新增常驻工具自动进入 dispatch 集。本测试锁死这条派生关系与 rename_images_by_date 的登记，防再次漂移。
import { describe, it, expect } from 'vitest'
import { NATIVE_TOOL_NAMES as DISPATCH_NATIVE, SIDE_EFFECT_TOOLS } from '@/services/toolRegistry'
import { NATIVE_TOOL_NAMES as ALWAYS_AVAILABLE } from '@/services/nativeTools'

describe('原生工具名单一致性（防漂移）', () => {
  it('每个常驻工具（nativeTools）都必须是可原生 dispatch（toolRegistry）——派生关系', () => {
    const missing = [...ALWAYS_AVAILABLE].filter(name => !DISPATCH_NATIVE.has(name))
    expect(missing).toEqual([])
  })

  it('rename_images_by_date 在可 dispatch 名单里（Q15 确定性单步路径的前提）', () => {
    expect(DISPATCH_NATIVE.has('rename_images_by_date')).toBe(true)
  })

  it('rename_images_by_date 登记为副作用工具（改外部世界，结果不得跨执行复用缓存）', () => {
    expect(SIDE_EFFECT_TOOLS.has('rename_images_by_date')).toBe(true)
  })

  it('派生集 = 常驻工具 ∪ 10 个非常驻 dispatch 工具（成员集行为保持）', () => {
    for (const n of ['create_directory', 'http_request', 'llm_generate', 'knowledge_search']) {
      expect(DISPATCH_NATIVE.has(n)).toBe(true)
    }
    // 2026-09-30 L1 深化：四个 L1 能力工具（计划步骤直接挂 l1-*，经 macroExecutor 分派到
    // pipelineExecutor 的 handler）也须在可 dispatch 名单里，否则 isAllNative 快路径不认。
    for (const n of ['l1-task-translator', 'l1-result-beautifier', 'l1-workspace-memory', 'l1-pipeline-builder']) {
      expect(DISPATCH_NATIVE.has(n)).toBe(true)
    }
    // 2026-10-08：按类型分拣（批量产出多目录）。与 create_directory 同款取舍——**刻意不注入模型工具表**，
    // 但必须有 dispatch 分支（否则 L0 组合计划落进模型循环）。登记点见 fileSortByTypeWiring.spec.ts。
    expect(DISPATCH_NATIVE.has('file_sort_by_type')).toBe(true)
    // 2026-10-08：解压并归类（每个 zip 解成同名子目录），同款取舍。登记点见 fileUnzipWiring.spec.ts。
    expect(DISPATCH_NATIVE.has('file_unzip')).toBe(true)
    expect(DISPATCH_NATIVE.size).toBe(ALWAYS_AVAILABLE.length + 10)
  })

  it('file_copy / doc_extract 在常驻清单（2026-09-30 新增），file_copy 登记为副作用工具', () => {
    for (const n of ['file_copy', 'doc_extract']) {
      expect((ALWAYS_AVAILABLE as readonly string[]).includes(n)).toBe(true)
      expect(DISPATCH_NATIVE.has(n)).toBe(true)
    }
    expect(SIDE_EFFECT_TOOLS.has('file_copy')).toBe(true)
    // doc_extract 是**读**类（提取文本，不改外部世界）——不得进副作用集
    expect(SIDE_EFFECT_TOOLS.has('doc_extract')).toBe(false)
  })
})
