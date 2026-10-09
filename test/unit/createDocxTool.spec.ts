import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_TOOL_DEFS, NATIVE_TOOL_NAMES, isAlwaysAvailableTool } from '@/services/nativeTools'

/**
 * 用户实测（2026-09-25）：「把桌面上 SKY\docs 文件夹下的 2026.9.24最新快照.md 转为 docx 放桌面」
 * → 模型读到文件后用 `file_convert` → 报「目标文件必须是 .pdf」。因为：
 *   - `file_convert` 出口被写死为 PDF（electron/docConvert.ts 有 `if (extOf(target) !== 'pdf') throw`）；
 *   - app **本来就会写真 docx**（主进程 `file:createDocx`，见 electron/ipc-handlers.ts:419），
 *     但它**没有工具定义**（不在 NATIVE_TOOL_DEFS）、也不在常驻工具名单里 ⇒ 模型看不见、调不到。
 * 本文件把「create_docx 必须对模型可见且可调」钉成契约。
 */
describe('create_docx 必须暴露为模型可调用的原生工具', () => {
  it('NATIVE_TOOL_DEFS 含 create_docx，参数覆盖 filePath / source / content', () => {
    const def = NATIVE_TOOL_DEFS.find(t => t.name === 'create_docx')
    expect(def, 'create_docx 缺少工具定义时，模型只能去用 file_convert（只出 PDF）或 shell（被安全闸拒）').toBeTruthy()
    const props = def!.parameters.properties as Record<string, unknown>
    expect(Object.keys(props)).toContain('filePath')
    // source：把已有文件转 docx 时由工具自读源文件（弱模型搬不动长正文）
    expect(Object.keys(props)).toContain('source')
    expect(Object.keys(props)).toContain('content')
    expect(def!.parameters.required).toContain('filePath')
    expect(def!.description.length).toBeGreaterThan(10)
  })

  it('create_docx 属常驻工具（不被计划过滤/召回环节剔除）', () => {
    expect([...NATIVE_TOOL_NAMES]).toContain('create_docx')
    expect(isAlwaysAvailableTool('create_docx')).toBe(true)
  })
})

describe('create_docx 在执行器里可分发（mcp-direct 回路）', () => {
  const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')

  it('executeToolCall 有 create_docx 分支，且先经写门 requestWriteApproval', () => {
    expect(src).toContain("fullName === 'create_docx'")
    expect(src).toMatch(/requestWriteApproval\('create_docx'/)
    expect(src).toContain('window.electronAPI.createDocx')
  })

  it('主提示词第 9 条改为用 create_docx，不再教 shell + node -e（那套会被安全闸拒）', () => {
    expect(src).toMatch(/生成 \.docx[^\n]*create_docx|create_docx[^\n]*生成/s)
    expect(src).not.toMatch(/第一步：先用 shell_exec 执行 "npm install docx"/)
  })
})
