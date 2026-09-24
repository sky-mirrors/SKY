// G-6：双引擎审计的费效倒挂——本地低危读操作不再无差别付 5000 maxTokens 审核。
// 审核 prompt 看不到文件内容（只看意图与路径），对一次本地读近乎纯开销；
// 审核缓存 key 含 targetFile，路径一换即 miss，几乎必然重付。
// 收窄方式与 shell_exec 的 P1-19 同构：**仅当目标路径敏感时才审计**。
import { describe, it, expect } from 'vitest'
import { shouldValidate } from '@/services/dualEngineValidator'

describe('G-6：审计范围收窄（低危本地读不付审核）', () => {
  it('普通路径的 read_file 不再触发审核', () => {
    expect(shouldValidate({ tool: 'read_file', params: { path: 'C:\\Users\\Me\\Desktop\\a.txt' } })).toBe(false)
  })

  it('普通目录的 list_directory 不再触发审核（Q15/Q16 这类操作）', () => {
    expect(shouldValidate({ tool: 'list_directory', params: { path: 'C:\\Users\\Me\\Desktop\\photos' } })).toBe(false)
  })

  it('敏感路径的读仍需审核（fail-closed 不放松）', () => {
    expect(shouldValidate({ tool: 'read_file', params: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' } })).toBe(true)
    expect(shouldValidate({ tool: 'list_directory', params: { path: 'C:\\Program Files' } })).toBe(true)
    expect(shouldValidate({ tool: 'read_file', params: { path: '../../etc/passwd' } })).toBe(true)
  })

  it('参数别名同样生效（file_path / dir / dirPath）', () => {
    expect(shouldValidate({ tool: 'read_file', params: { file_path: 'C:\\Users\\Me\\a.txt' } })).toBe(false)
    expect(shouldValidate({ tool: 'list_directory', params: { dir: 'C:\\Users\\Me\\photos' } })).toBe(false)
    // 别名为敏感路径时仍要审
    expect(shouldValidate({ tool: 'read_file', params: { file_path: 'C:\\Windows\\win.ini' } })).toBe(true)
  })

  it('写类与网络类照旧审核', () => {
    expect(shouldValidate({ tool: 'file_write', params: {} })).toBe(true)
    expect(shouldValidate({ tool: 'http_request', params: {} })).toBe(true)
    expect(shouldValidate({ tool: 'create_docx', params: {} })).toBe(true)
    expect(shouldValidate({ tool: 'create_directory', params: {} })).toBe(true)
  })

  it('MCP 工具照旧审核', () => {
    expect(shouldValidate({ tool: 'srv___calc', params: {} })).toBe(true)
  })

  it('shell_exec 的三类收窄不变（写 / 危险 URL / 敏感路径）', () => {
    expect(shouldValidate({ tool: 'shell_exec', params: { command: 'ls -la' } })).toBe(false)
    expect(shouldValidate({ tool: 'shell_exec', params: { command: 'echo x > a.txt' } })).toBe(true)
    expect(shouldValidate({ tool: 'shell_exec', params: { command: 'cat /etc/passwd' } })).toBe(true)
  })
})
