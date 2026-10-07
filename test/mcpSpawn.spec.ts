import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 对账 §4 #7 / #8（docs/archive/AUDIT-RECONCILIATION-2026-09.md）：
//  - #7 MCP spawn 原先无条件把 command/args 追加到「用户桌面\mcp-spawn-debug.log」，
//       args 常带 --api-key/--token 之类凭据 → 每次 spawn 都在桌面留一份明文副本
//  - #8 shell:true 通道的元字符拦截漏了 cmd 的 %（shell-security.ts 的
//       findShellMetacharacter 已把 % 列为拒绝项，两处口径不一致 → 旁路）

const hoisted = vi.hoisted(() => ({ appendFileSync: vi.fn() }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, appendFileSync: hoisted.appendFileSync }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/holo-home' }
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 4242,
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn()
  }))
}))

/** 模块级 `const DEBUG = process.env.HOLO_DEBUG === '1'` 在 import 时求值 → 每次重载模块 */
async function loadMcpManager(holoDebug: string) {
  vi.resetModules()
  vi.stubEnv('HOLO_DEBUG', holoDebug)
  return await import('@electron/mcp-manager')
}

describe('MCP spawn 桌面日志门控（对账 §4 #7）', () => {
  beforeEach(() => {
    hoisted.appendFileSync.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('未开 HOLO_DEBUG → 不向用户桌面写 mcp-spawn-debug.log', async () => {
    const { startMcpProcess } = await loadMcpManager('')
    const r = startMcpProcess('t-off', 'npx', ['@modelcontextprotocol/server-filesystem', '/tmp'], {}, null)
    expect(r.success).toBe(true)
    expect(hoisted.appendFileSync).not.toHaveBeenCalled()
  })

  it('HOLO_DEBUG=1 → 仍写桌面日志（调试用途保留）', async () => {
    const { startMcpProcess } = await loadMcpManager('1')
    const r = startMcpProcess('t-on', 'npx', ['@modelcontextprotocol/server-filesystem', '/tmp'], {}, null)
    expect(r.success).toBe(true)
    expect(hoisted.appendFileSync).toHaveBeenCalledTimes(1)
    const [logPath, line] = hoisted.appendFileSync.mock.calls[0]
    expect(String(logPath)).toContain('Desktop')
    expect(String(line)).toContain('id=t-on')
  })
})

describe('MCP shell 通道参数准入（对账 §4 #8）', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('常规参数放行（含空格参数由调用方加引号包裹）', async () => {
    const { validateShellArgs } = await import('@electron/mcp-manager')
    expect(validateShellArgs(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Desktop']).allowed).toBe(true)
    expect(validateShellArgs(['--dir', 'C:\\Program Files\\x']).allowed).toBe(true)
  })

  it('cmd 变量展开符 % 被拒绝（与 shell-security 同口径）', async () => {
    const { validateShellArgs } = await import('@electron/mcp-manager')
    const r = validateShellArgs(['%USERPROFILE%\\Desktop'])
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('%')
  })

  it('命令分隔/重定向/换行/双引号/非字符串一律拒绝', async () => {
    const { validateShellArgs } = await import('@electron/mcp-manager')
    const bad: unknown[][] = [['a&calc'], ['a|b'], ['a>b'], ['a^b'], ['a\nb'], ['a"b'], [42]]
    for (const args of bad) {
      expect(validateShellArgs(args).allowed, JSON.stringify(args)).toBe(false)
    }
  })

  // shell:true 只在 Windows 的 npx/npm/pnpm/yarn/bunx 上启用（.cmd shim）
  it.skipIf(process.platform !== 'win32')('startMcpProcess 经 shell 通道拒绝 % 参数', async () => {
    const { startMcpProcess } = await loadMcpManager('')
    const r = startMcpProcess('t-bad', 'npx', ['-y', '%USERPROFILE%\\x'], {}, null)
    expect(r.success).toBe(false)
    expect(r.error).toContain('%')
  })
})
