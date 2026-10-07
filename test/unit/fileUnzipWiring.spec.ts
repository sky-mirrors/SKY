import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_NAMES, SIDE_EFFECT_TOOLS } from '@/services/toolRegistry'
import { isWriteTool, WRITE_TOOL_LABELS } from '@/services/writeGate'

/**
 * 「解压并归类」（`file_unzip`）的**登记与分发一致性**契约（2026-10-08）。
 *
 * 同 fileSortByTypeWiring.spec.ts 的由来：一个新算子要跨 6 处登记才真正可达，
 * 而其中两处（macroExecutor / dialogStore 的 dispatch）是闭包、不可直接 import ⇒
 * 沿用本项目既有约定（见 fileMoveDispatch.spec.ts）：对源码文本做契约断言；
 * 真正的行为由 CDP 端到端（临时目录里的真 zip）验证。
 */
describe('file_unzip：登记一致（防名单漂移）', () => {
  it('在可分发名单与副作用工具集内（前者=计划全原生快路径；后者=产物不得被跨执行缓存复用）', () => {
    expect(NATIVE_TOOL_NAMES.has('file_unzip')).toBe(true)
    expect(SIDE_EFFECT_TOOLS.has('file_unzip')).toBe(true)
  })

  it('属写类工具（O10 授权边界），且有确认条文案', () => {
    expect(isWriteTool('file_unzip')).toBe(true)
    expect(WRITE_TOOL_LABELS['file_unzip']).toBeTruthy()
  })

  it('刻意**不注入模型工具表**：解压往哪写由确定性 L0 计划决定，不给模型自由决定', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/nativeTools.ts'), 'utf-8')
    expect(src).not.toMatch(/NATIVE_TOOL_NAMES = \[[^\]]*'file_unzip'/)
  })
})

describe('file_unzip：两条 dispatch 分支都在（macros + mcp-direct）', () => {
  it('macroExecutor 有分支，且先展开路径模板再调用；如实把"不支持/跳过"讲出来', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_unzip'")
    expect(src).toContain('window.electronAPI.fileUnzip')
    expect(src).toMatch(/file_unzip: missing fromDir/)
    expect(src).toMatch(/只支持 \.zip/)
  })

  it('dialogStore 有分支，且先过写门 requestWriteApproval', () => {
    const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(src).toContain("fullName === 'file_unzip'")
    expect(src).toMatch(/requestWriteApproval\('file_unzip'/)
    expect(src).toContain('window.electronAPI.fileUnzip')
  })

  it('preload 暴露 + 主进程注册了 file:unzip，且两条安全约束在实现里', () => {
    const pre = readFileSync(join(process.cwd(), 'electron/preload.ts'), 'utf-8')
    expect(pre).toContain("ipcRenderer.invoke('file:unzip'")
    const ipc = readFileSync(join(process.cwd(), 'electron/ipc-handlers.ts'), 'utf-8')
    expect(ipc).toContain("ipcMain.handle('file:unzip'")
    // ① 目标子目录已存在 ⇒ 跳过（不覆盖式解压）；② 只认 zip，其它格式进 unsupported 如实上报
    expect(ipc).toMatch(/目标文件夹已存在，跳过/)
    expect(ipc).toMatch(/unsupported/)
    expect(ipc).toMatch(/\.\(rar\|7z\|tar\|gz\|bz2\|xz\)/)
  })
})
