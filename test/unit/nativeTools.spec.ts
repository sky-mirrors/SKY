// N1：常驻原生工具定义的单测。
// 验证 read_file/list_directory/file_write 三个原生工具被声明，且 isAlwaysAvailableTool
// 正确区分「常驻工具」与「MCP 工具」——后者会被对话路径的计划/RAG 过滤掉，前者不会。
import { describe, it, expect } from 'vitest'
import { NATIVE_TOOL_DEFS, NATIVE_TOOL_NAMES, isAlwaysAvailableTool } from '@/services/nativeTools'

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
