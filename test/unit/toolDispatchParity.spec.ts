import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_NAMES } from '@/services/nativeTools'

/**
 * 两条 renderer 工具分发器的一致性（防「单侧漏」）
 *
 * 背景（2026-10-07）：原生工具的执行分派在**两处各写一份**——
 *   A. `src/services/macroExecutor.ts` 的 `callToolDirectWithTier`（主路径 + 工具回路）
 *   B. `src/stores/dialogStore.ts` 的 `executeToolCall`（mcp-direct 回路的第二分发器）
 * B 处函数尾对未命中者抛「无效工具名」。历史上 B 处曾漏 `file_move`（见 dialogStore.ts:695-698
 * 注释：Q15 因此长期失败）；本轮又实测漏 `file_copy` / `doc_extract`。
 *
 * 不变量：**任何 `NATIVE_TOOL_NAMES`（常驻原生工具）都必须在 A、B 两处都有分支**——
 * 否则该工具经对应回路调用时静默失败。本测试用源码级断言守住它（同 macroOutputDiscipline.spec.ts 的守法）。
 */
describe('工具分发器一致性：NATIVE_TOOL_NAMES 必须在两条 renderer 分发器都有分支', () => {
  const root = process.cwd()
  const macroSrc = readFileSync(join(root, 'src/services/macroExecutor.ts'), 'utf-8')
  const storeSrc = readFileSync(join(root, 'src/stores/dialogStore.ts'), 'utf-8')

  it('每个常驻原生工具在 macroExecutor 与 dialogStore 两处都能找到 fullName === 分支', () => {
    const missing: string[] = []
    for (const name of NATIVE_TOOL_NAMES) {
      const needle = `fullName === '${name}'`
      if (!macroSrc.includes(needle)) missing.push(`macroExecutor（A）缺分支: ${name}`)
      if (!storeSrc.includes(needle)) missing.push(`dialogStore.executeToolCall（B）缺分支: ${name}`)
    }
    expect(missing).toEqual([])
  })

  it('完整性自检：NATIVE_TOOL_NAMES 非空且含已知的 file_copy / doc_extract', () => {
    expect(NATIVE_TOOL_NAMES.length).toBeGreaterThan(0)
    expect(NATIVE_TOOL_NAMES).toContain('file_copy')
    expect(NATIVE_TOOL_NAMES).toContain('doc_extract')
  })
})
