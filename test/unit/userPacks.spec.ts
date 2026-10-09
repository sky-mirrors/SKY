import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 用户领域包写入通道（electron\userPacks.ts）的路径守卫。
 *
 * 为什么单独钉这一份：这是「领域包编辑器」里唯一一条能写 `{userData}` 的 IPC 通道——
 * 其余 `file:write` 被 pathValidator 限制在 Desktop / Documents / Downloads。守卫一旦破口，
 * renderer 就能写进应用数据目录的任意位置（含覆写别的包）。模块自述是 fail-closed，须以测试兑现。
 *
 * 手法：mock electron（app.getPath 指向临时目录，并捕获 ipcMain.handle 注册的 handler），
 * 用「恶意入参」直接调 handler 断言拒绝；正向路径走真实 fs 验证确实落盘。
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  userData: { path: '' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData.path },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn)
    }
  }
}))

import { setupUserPackIpc, userPacksRoot } from '@electron/userPacks'

function call<T = unknown>(channel: string, ...args: unknown[]): T {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`IPC handler 未注册：${channel}`)
  return fn(null, ...args) as T
}

let userDataDir = ''

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'sky-userpacks-'))
  h.userData.path = userDataDir
  setupUserPackIpc()
})

afterAll(() => {
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('packId 白名单', () => {
  const badIds = [
    '../evil', '..', '.', 'a/b', 'a\\b', 'a b', '', '-lead', '_lead', '/abs', 'C:\\x', 'x'.repeat(65)
  ]

  for (const id of badIds) {
    it(`拒绝 packId ${JSON.stringify(id)}`, () => {
      expect(call('pack:user:write', id, 'pack.json', '{}')).toMatchObject({ success: false })
      expect(call('pack:user:read', id, 'pack.json')).toMatchObject({ success: false })
      expect(call('pack:user:deletePack', id)).toMatchObject({ success: false })
    })
  }

  it('放行合法 packId', () => {
    for (const id of ['a', 'my-pack', 'My_Pack1', 'a-1_b']) {
      expect(call('pack:user:write', id, 'pack.json', '{"ok":1}')).toMatchObject({ success: true })
    }
  })
})

describe('relPath 越界守卫（必须留在包目录内）', () => {
  const escapes = [
    '..',
    '../x',
    '../other-pack/boundary/constraints.json',
    '../../outside.txt',
    '..\\..\\outside.txt',
    '/etc/passwd',
    'C:\\Windows\\x.txt'
  ]

  for (const rel of escapes) {
    it(`write 拒绝逃逸 relPath ${JSON.stringify(rel)}`, () => {
      expect(call('pack:user:write', 'demo', rel, 'BAD')).toMatchObject({ success: false })
    })
  }

  it('read / deleteFile 与 write 同口径', () => {
    for (const rel of escapes) {
      expect(call('pack:user:read', 'demo', rel)).toMatchObject({ success: false })
      expect(call('pack:user:deleteFile', 'demo', rel)).toMatchObject({ success: false })
    }
  })

  it('越界 write 不留副作用（root 外与 root 层都不落盘）', () => {
    call('pack:user:write', 'demo', '../stray.json', 'BAD')
    expect(existsSync(join(userDataDir, 'holostarmap-packs', 'stray.json'))).toBe(false)
    expect(existsSync(join(userDataDir, 'stray.json'))).toBe(false)
  })
})

describe('正向路径（真实磁盘）', () => {
  it('userPacksRoot 指向 {userData}/holostarmap-packs', () => {
    expect(userPacksRoot()).toBe(join(userDataDir, 'holostarmap-packs'))
  })

  it('写入 pack.json 并读回', () => {
    expect(call('pack:user:write', 'demo-a', 'pack.json', '{"id":"demo-a"}')).toMatchObject({ success: true })
    expect(existsSync(join(userPacksRoot(), 'demo-a', 'pack.json'))).toBe(true)
    expect(call('pack:user:read', 'demo-a', 'pack.json')).toMatchObject({ success: true, content: '{"id":"demo-a"}' })
  })

  it('可写子目录（自动建目录）', () => {
    expect(call('pack:user:write', 'demo-a', 'knowledge/terms.json', '{"a":1}')).toMatchObject({ success: true })
    expect(readFileSync(join(userPacksRoot(), 'demo-a', 'knowledge', 'terms.json'), 'utf8')).toBe('{"a":1}')
  })

  it('list 列出包与文件', () => {
    call('pack:user:write', 'demo-list', 'boundary/constraints.json', '[]')
    const res = call<{ success: boolean; packs: Array<{ id: string; files: string[] }> }>('pack:user:list')
    expect(res.success).toBe(true)
    expect(res.packs.find(p => p.id === 'demo-list')?.files).toContain('boundary/constraints.json')
  })

  it('deletePack 移除整个包目录', () => {
    call('pack:user:write', 'demo-del', 'pack.json', '{}')
    expect(existsSync(join(userPacksRoot(), 'demo-del'))).toBe(true)
    expect(call('pack:user:deletePack', 'demo-del')).toMatchObject({ success: true })
    expect(existsSync(join(userPacksRoot(), 'demo-del'))).toBe(false)
  })
})
