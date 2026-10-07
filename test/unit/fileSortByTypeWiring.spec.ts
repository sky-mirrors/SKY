import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_NAMES, SIDE_EFFECT_TOOLS } from '@/services/toolRegistry'
import { isWriteTool, WRITE_TOOL_LABELS } from '@/services/writeGate'

/**
 * 「按类型分拣」（`file_sort_by_type`）的**登记与分发一致性**契约（2026-10-08）。
 *
 * 为什么要有这份：这个算子要跨 **6 处**登记才真正可达（本项目的历史教训——「修了一侧漏另一侧」）：
 *   ① toolRegistry 的可分发名单（否则 confirmPlan 的 isAllNative 判「非全原生」，计划落进模型循环）
 *   ② toolRegistry 的副作用工具集（否则执行指纹被缓存复用，文件其实没搬）
 *   ③ writeGate 的写类边界（授权边界）
 *   ④ macroExecutor 的 dispatch（L0 计划执行路径）
 *   ⑤ dialogStore 的 executeToolCall 分支（mcp-direct 回路）
 *   ⑥ preload + 主进程 IPC handler（真正干事的地方）
 * 其中 ④⑤ 是闭包、不可直接 import，故沿用本项目对同类 dispatch 的既有约定（见 fileMoveDispatch.spec.ts）：
 * 对源码文本做契约断言；真正的行为由 CDP 端到端（临时目录）验证。
 */
describe('file_sort_by_type：四处登记一致（防名单漂移）', () => {
  it('在可分发名单与副作用工具集内（前者=计划走全原生化快路径，后者=结果不得被缓存复用）', () => {
    expect(NATIVE_TOOL_NAMES.has('file_sort_by_type')).toBe(true)
    expect(SIDE_EFFECT_TOOLS.has('file_sort_by_type')).toBe(true)
  })

  it('属写类工具（O10 授权边界），且有确认条文案', () => {
    expect(isWriteTool('file_sort_by_type')).toBe(true)
    expect(WRITE_TOOL_LABELS['file_sort_by_type']).toBeTruthy()
  })

  it('刻意**不注入模型工具表**：它是"大范围搬动用户文件"的算子，入口只给确定性 L0 计划', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/nativeTools.ts'), 'utf-8')
    expect(src).not.toMatch(/NATIVE_TOOL_NAMES = \[[^\]]*'file_sort_by_type'/)
  })
})

describe('file_sort_by_type：两条 dispatch 分支都在（macros + mcp-direct）', () => {
  it('macroExecutor 有分支，且先展开路径模板再调用', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_sort_by_type'")
    expect(src).toContain('window.electronAPI.fileSortByType')
    expect(src).toMatch(/file_sort_by_type: missing fromDir/)
  })

  it('dialogStore 有分支，且先过写门 requestWriteApproval', () => {
    const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_sort_by_type'")
    expect(src).toMatch(/requestWriteApproval\('file_sort_by_type'/)
    expect(src).toContain('window.electronAPI.fileSortByType')
  })

  it('preload 暴露 + 主进程注册了 file:sortByType', () => {
    const pre = readFileSync(join(process.cwd(), 'electron/preload.ts'), 'utf-8')
    expect(pre).toContain("ipcRenderer.invoke('file:sortByType'")
    const ipc = readFileSync(join(process.cwd(), 'electron/ipc-handlers.ts'), 'utf-8')
    expect(ipc).toContain("ipcMain.handle('file:sortByType'")
    // 两条安全约束：只搬文件不碰子目录；目标同名文件跳过（不覆盖 ⇒ 可重复执行）
    expect(ipc).toMatch(/d\.isFile\(\)/)
    expect(ipc).toMatch(/目标已存在，跳过/)
  })
})
