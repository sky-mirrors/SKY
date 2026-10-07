import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_NAMES, SIDE_EFFECT_TOOLS } from '@/services/toolRegistry'
import { isWriteTool, WRITE_TOOL_LABELS } from '@/services/writeGate'
import { resolveRenameTargetExt, resolveCollectFilter, matchCompositePlan } from '@/services/compositeIntent'

/**
 * 「批量改扩展名」（`file_rename_ext`）的**登记与分发一致性**契约（2026-10-08）。
 * 同 fileSortByTypeWiring.spec.ts / fileUnzipWiring.spec.ts 的由来：一个新算子要跨 6 处登记才可达，
 * 其中两处 dispatch 是闭包不可 import ⇒ 沿用本项目约定（见 fileMoveDispatch.spec.ts）做源码文本断言；
 * 行为由 CDP 端到端（临时目录）验证。
 */
describe('file_rename_ext：登记一致（防名单漂移）', () => {
  it('在可分发名单与副作用工具集内（后者：改名的产物不得被跨执行缓存复用）', () => {
    expect(NATIVE_TOOL_NAMES.has('file_rename_ext')).toBe(true)
    expect(SIDE_EFFECT_TOOLS.has('file_rename_ext')).toBe(true)
  })

  it('属写类工具（O10 授权边界），且有确认条文案', () => {
    expect(isWriteTool('file_rename_ext')).toBe(true)
    expect(WRITE_TOOL_LABELS['file_rename_ext']).toBeTruthy()
  })

  it('刻意**不注入模型工具表**', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/nativeTools.ts'), 'utf-8')
    expect(src).not.toMatch(/NATIVE_TOOL_NAMES = \[[^\]]*'file_rename_ext'/)
  })
})

describe('file_rename_ext：两条 dispatch 分支都在（macros + mcp-direct）', () => {
  it('macroExecutor 有分支；缺 fromExt/toExt 时抛错（不产出空扩展名的改名）', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_rename_ext'")
    expect(src).toContain('window.electronAPI.fileRenameExt')
    expect(src).toMatch(/missing fromExt\/toExt/)
  })

  it('dialogStore 有分支，且先过写门 requestWriteApproval', () => {
    const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_rename_ext'")
    expect(src).toMatch(/requestWriteApproval\('file_rename_ext'/)
    expect(src).toContain('window.electronAPI.fileRenameExt')
  })

  it('preload 暴露 + 主进程注册了 file:renameExt，且不覆盖已存在文件', () => {
    const pre = readFileSync(join(process.cwd(), 'electron/preload.ts'), 'utf-8')
    expect(pre).toContain("ipcRenderer.invoke('file:renameExt'")
    const ipc = readFileSync(join(process.cwd(), 'electron/ipc-handlers.ts'), 'utf-8')
    expect(ipc).toContain("ipcMain.handle('file:renameExt'")
    expect(ipc).toMatch(/目标已存在（/)
  })
})

describe('「改成 X 后缀」的目标扩展名解析（组合计划靠它）', () => {
  it('常见说法都能解析出目标扩展名', () => {
    expect(resolveRenameTargetExt('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')).toBe('md')
    expect(resolveRenameTargetExt('把这些 jpg 改成 png 扩展名')).toBe('png')
    expect(resolveRenameTargetExt('把 a 换为 b 格式')).toBe('b')
  })

  it('说不清要改成什么 ⇒ 空串；此时带 {toExt} 的组合**不产出**计划（fail-closed）', () => {
    expect(resolveRenameTargetExt('把桌面上的 txt 都改后缀，然后放进新建文件夹')).toBe('')
    const input = '把桌面上的 txt 都改后缀，然后放进新建文件夹'
    const plan = matchCompositePlan(input, {
      dir: 'D:\\src', target: 'D:\\src\\新', folderName: '新',
      filter: resolveCollectFilter(input), toExt: resolveRenameTargetExt(input)
    })
    // 不得出现 file_rename_ext（那会渲染出空扩展名的必失败计划）
    expect((plan?.steps || []).some(s => s.tool === 'file_rename_ext')).toBe(false)
  })
})
