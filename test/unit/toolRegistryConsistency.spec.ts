// 原生工具名单一致性守卫（防漂移）。
//
// 背景（HANDOFF 下一步 3 的 Q15 UI 验证复现）：仓库里有**两份** NATIVE_TOOL_NAMES——
//   · src/services/nativeTools.ts  → 数组，「常驻工具」（供 filterToolsByPlan/activeTools 保留、既有测试守住）
//   · src/services/toolRegistry.ts → ReadonlySet，「可原生 dispatch 的工具」（confirmPlan 的 isAllNative 快路径判定用）
// `rename_images_by_date`（2026-09-25 Q15 确定性化引入）当时只登记在 nativeTools.ts，toolRegistry 的 Set 漏了它 ⇒
// Q15 的单步原生计划被误判为「非全原生」、不走确定性快路径，落进模型循环，弱模型**编造**重命名结果、文件未改名。
// 本测试锁死「常驻工具 ⊆ 可 dispatch 工具」，此类漂移再次出现即当场变红。
import { describe, it, expect } from 'vitest'
import { NATIVE_TOOL_NAMES as DISPATCH_NATIVE, SIDE_EFFECT_TOOLS } from '@/services/toolRegistry'
import { NATIVE_TOOL_NAMES as ALWAYS_AVAILABLE } from '@/services/nativeTools'

describe('原生工具名单一致性（防漂移）', () => {
  it('每个常驻工具（nativeTools）都必须登记为可原生 dispatch（toolRegistry）', () => {
    const missing = [...ALWAYS_AVAILABLE].filter(name => !DISPATCH_NATIVE.has(name))
    expect(missing).toEqual([])
  })

  it('rename_images_by_date 在可 dispatch 名单里（Q15 确定性单步路径的前提）', () => {
    expect(DISPATCH_NATIVE.has('rename_images_by_date')).toBe(true)
  })

  it('rename_images_by_date 登记为副作用工具（改外部世界，结果不得跨执行复用缓存）', () => {
    expect(SIDE_EFFECT_TOOLS.has('rename_images_by_date')).toBe(true)
  })
})
