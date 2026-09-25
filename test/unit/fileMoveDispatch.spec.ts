import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_DEFS, NATIVE_TOOL_NAMES, isAlwaysAvailableTool } from '@/services/nativeTools'
import { isWriteTool } from '@/services/writeGate'

/**
 * HANDOFF 卡点 3（2026-09-25，已 grep 坐实）：
 * `file_move` 在 `NATIVE_TOOL_NAMES` / `NATIVE_TOOL_DEFS` / `WRITE_TOOLS` / `toolRegistry`
 * 四处都登记了，但 `dialogStore.executeToolCall` 的原生分支只有
 * shell_exec / read_file / list_directory / file_write / file_convert / create_docx /
 * image_process / media_process —— **独缺 file_move**。
 * 于是一旦模型在 mcp-direct 回路里调 file_move，`fullName.indexOf('___') < 0`
 * → `throw new Error('无效工具名: file_move')`。
 * 而 Q15「图片按日期重命名」恰好走 mcp-direct 回路 ⇒ 该题长期失败（唯一失败题）。
 *
 * 本文件把「file_move 在执行器里必须有 dispatch 分支、且必须先过写门」钉成契约。
 * 说明：executeToolCall 是 dialogStore 内部闭包（不可直接 import），故沿用本项目
 * 对同类 dispatch 分支的既有测试约定（见 createDocxTool.spec.ts / debugHandlers.spec.ts）
 * —— 对源码文本做契约断言；真正的端到端行为验证归考试复跑（HANDOFF 下一步 6）。
 */
describe('file_move 必须在 executeToolCall 里可分发（mcp-direct 回路）', () => {
  const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')

  it('executeToolCall 有 file_move 分支，且先经写门 requestWriteApproval', () => {
    expect(src, '缺少 file_move 分支时，模型调它会拿到「无效工具名: file_move」').toContain("fullName === 'file_move'")
    expect(src).toMatch(/requestWriteApproval\('file_move'/)
    expect(src).toContain('window.electronAPI.fileMove')
  })

  it('分支返回 from → to（源/目标参数键覆盖 from/to 与别名）', () => {
    // 参数键须与 nativeTools 的 file_move 定义（from/to）及 macroExecutor 的别名口径一致
    expect(src).toMatch(/args\.from\s*\|\|/)
    expect(src).toMatch(/args\.to\s*\|\|/)
    // 返回值带上 from→to，便于上游如实报告「改成了什么名字」
    expect(src).toMatch(/已重命名\/移动/)
  })
})

describe('file_move 的工具登记一致（防两处名单漂移）', () => {
  it('常驻原生工具名单含 file_move，且常量定义里也有它', () => {
    expect([...NATIVE_TOOL_NAMES]).toContain('file_move')
    expect(NATIVE_TOOL_DEFS.some(t => t.name === 'file_move')).toBe(true)
    expect(isAlwaysAvailableTool('file_move')).toBe(true)
  })

  it('file_move 属写类工具（写门约束下）', () => {
    expect(isWriteTool('file_move')).toBe(true)
  })
})
