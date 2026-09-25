// N1：常驻原生工具定义的单测。
// 验证 read_file/list_directory/file_write 三个原生工具被声明，且 isAlwaysAvailableTool
// 正确区分「常驻工具」与「MCP 工具」——后者会被对话路径的计划/RAG 过滤掉，前者不会。
import { describe, it, expect } from 'vitest'
import { NATIVE_TOOL_DEFS, NATIVE_TOOL_NAMES, isAlwaysAvailableTool, looksLikeRenameCommand, looksLikeWhitelistRejection, shellFailureMessage } from '@/services/nativeTools'

describe('N1：常驻原生工具定义', () => {
  it('包含 read_file/list_directory/file_write 三个工具', () => {
    const names = NATIVE_TOOL_DEFS.map(t => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('list_directory')
    expect(names).toContain('file_write')
  })

  it('每个工具都有非空描述与合法 object 参数 schema', () => {
    for (const t of NATIVE_TOOL_DEFS) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.parameters.type).toBe('object')
      expect(t.parameters.properties).toBeTruthy()
      expect(Array.isArray(t.parameters.required)).toBe(true)
    }
  })

  it('isAlwaysAvailableTool：常驻工具为真、MCP 工具为假', () => {
    expect(isAlwaysAvailableTool('shell_exec')).toBe(true)
    expect(isAlwaysAvailableTool('read_file')).toBe(true)
    expect(isAlwaysAvailableTool('list_directory')).toBe(true)
    expect(isAlwaysAvailableTool('file_write')).toBe(true)
    // MCP 工具名形如 {safeId}___{tool}，不是常驻工具
    expect(isAlwaysAvailableTool('mcp-filesystem___read_file')).toBe(false)
    expect(isAlwaysAvailableTool('some_random_tool')).toBe(false)
  })

  it('NATIVE_TOOL_NAMES = NATIVE_TOOL_DEFS 的工具名 + shell_exec（无重复）', () => {
    const defNames = NATIVE_TOOL_DEFS.map(t => t.name)
    expect([...NATIVE_TOOL_NAMES].sort()).toEqual([...defNames, 'shell_exec'].sort())
    expect(new Set(NATIVE_TOOL_NAMES).size).toBe(NATIVE_TOOL_NAMES.length)
    // 三个原生工具名不含 MCP 分隔符，避免与 {mcpId}___{tool} 混淆
    for (const n of defNames) expect(n.includes('___')).toBe(false)
  })
})

// Q15 真缺陷（2026-09-25）：shell 白名单不含 ren/move/Move-Item，重命名类命令必被拒。
// 失败信息必须指向 file_move，好让工具回路自纠正（纯提示词对弱模型不可靠）。
describe('shell 失败信息的重命名提示', () => {
  it('识别常见重命名/移动写法', () => {
    for (const cmd of [
      'ren img0.jpg 20260924-01.jpg',
      'rename a.jpg b.jpg',
      'move /Y a.jpg b.jpg',
      'Move-Item a.jpg b.jpg',
      'Rename-Item -Path a.jpg -NewName b.jpg',
      'mv a.jpg b.jpg',
      'powershell -c "[System.IO.File]::Move(\'a\',\'b\')"'
    ]) {
      expect(looksLikeRenameCommand(cmd)).toBe(true)
    }
  })

  it('不误伤普通命令（remove 里含 move 不算）', () => {
    for (const cmd of ['node -e "console.log(1)"', 'npm run build', 'remove-item x', 'git commit -m "x"']) {
      expect(looksLikeRenameCommand(cmd)).toBe(false)
    }
  })

  it('重命名类失败 → 明确指向 file_move（带 from/to 用法）', () => {
    const msg = shellFailureMessage('ren a.jpg b.jpg', -1)
    expect(msg).toContain('命令执行失败（退出码-1）')
    expect(msg).toContain('file_move')
    expect(msg).toContain('from')
    expect(msg).toContain('to')
  })

  it('白名单拒绝（stderr 判定，覆盖任意写法）→ 列出原生替代工具', () => {
    const msg = shellFailureMessage('powershell -c "Get-ChildItem | ForEach-Object { $_.Name }"', -1, '命令被安全策略拒绝: 不在白名单')
    expect(msg).toContain('file_move')
    expect(msg).toContain('file_write')
    expect(msg).toContain('file_convert')
    expect(msg).toContain('不要用 shell 做文件操作')
  })

  it('looksLikeWhitelistRejection 只认安全策略措辞', () => {
    expect(looksLikeWhitelistRejection('命令被安全策略拒绝: 不在白名单')).toBe(true)
    expect(looksLikeWhitelistRejection('命令超时(60000ms)，已发送终止信号')).toBe(false)
    expect(looksLikeWhitelistRejection(undefined)).toBe(false)
  })

  it('普通命令失败 → 保持原样，不误导', () => {
    expect(shellFailureMessage('node -e "1"', 1)).toBe('命令执行失败（退出码1）')
  })
})
