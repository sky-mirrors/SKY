import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * IPC 契约对账（静态源码断言）。
 *
 * 动机：本仓的 IPC 契约散在三处、**没有任何编译期交叉校验**——
 *   ① `electron\preload.ts` 实际暴露的键与通道；
 *   ② `src\env.d.ts` 给渲染层看的 `ElectronAPI` 类型（手写，不参与 ① 的编译）；
 *   ③ `electron\**` 里 `ipcMain.handle/on` 的注册与 `webContents.send` 的发出。
 * 三者可以各自漂移而不报错：preload 暴露了但主进程没注册 → invoke 永不 resolve；
 * 主进程注册了但 preload 没暴露 → 通道悬空（真实案例：`packs:window:*` 三通道，
 * 领域包编辑器窗口是无边框窗，却没有任何窗口控制入口，只能 Alt+F4）。
 *
 * 本组把三处对齐变成可回归的断言，任一侧再漂移即红。
 */

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', '.git', '.rivet', 'out', 'dist', '.vite'])

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p)
  }
  return out
}

interface PreloadBlock {
  key: string
  line: number
  /** renderer → main（invoke / send，主进程必须有 handle/on 注册） */
  toMain: string[]
  /** main → renderer（on，主进程必须真的 send 过） */
  fromMain: string[]
  /** 模板字符串拼出的动态通道（如 llm 流的 per-request 通道），单独记账 */
  dynamic: string[]
}

function parsePreload(): PreloadBlock[] {
  const text = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8')
  const lines = text.split(/\r?\n/)
  const blocks: PreloadBlock[] = []
  let cur: PreloadBlock | null = null
  for (let i = 0; i < lines.length; i++) {
    const km = lines[i].match(/^ {2}([A-Za-z_$][\w$]*)\s*:/)
    if (km) {
      cur = { key: km[1], line: i + 1, toMain: [], fromMain: [], dynamic: [] }
      blocks.push(cur)
    }
    if (cur === null) continue
    for (const m of lines[i].matchAll(/ipcRenderer\.(invoke|send|on)\(\s*([^,)]+)/g)) {
      const lit = m[2].trim().match(/^['"]([^'"]+)['"]$/)
      if (lit === null) {
        cur.dynamic.push(`${m[1]}(${m[2].trim()})`)
      } else if (m[1] === 'on') {
        cur.fromMain.push(lit[1])
      } else {
        cur.toMain.push(lit[1])
      }
    }
  }
  return blocks
}

function parseDeclaredKeys(): string[] {
  const text = readFileSync(join(ROOT, 'src', 'env.d.ts'), 'utf8')
  const keys: string[] = []
  let inside = false
  for (const ln of text.split(/\r?\n/)) {
    if (/^interface ElectronAPI \{/.test(ln)) { inside = true; continue }
    if (inside && /^\}/.test(ln)) { inside = false; continue }
    if (!inside) continue
    const m = ln.match(/^ {2}([A-Za-z_$][\w$]*)\s*[:(]/)
    if (m !== null) keys.push(m[1])
  }
  return keys
}

function parseMain(): { registered: Set<string>; sent: Set<string> } {
  const registered = new Set<string>()
  const sent = new Set<string>()
  for (const f of walk(join(ROOT, 'electron'), ['.ts'])) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/ipcMain\.(?:handle|handleOnce|on)\(\s*['"]([^'"]+)['"]/g)) registered.add(m[1])
    for (const m of text.matchAll(/\.send\(\s*['"]([^'"]+)['"]/g)) sent.add(m[1])
  }
  return { registered, sent }
}

const blocks = parsePreload()
const declaredKeys = parseDeclaredKeys()
const { registered, sent } = parseMain()
const exposedKeys = blocks.map((b) => b.key)
const exposedChannels = new Set(blocks.flatMap((b) => [...b.toMain, ...b.fromMain]))

describe('IPC 契约 —— preload ↔ 主进程', () => {
  it('preload 的每个 renderer→main 通道，主进程都有 ipcMain 注册', () => {
    const missing = blocks.flatMap((b) =>
      b.toMain.filter((ch) => !registered.has(ch)).map((ch) => `${b.key}('${ch}') @preload.ts:${b.line}`)
    )
    expect(missing).toEqual([])
  })

  it('preload 的每个 main→renderer 事件，主进程都真的 send 过', () => {
    const missing = blocks.flatMap((b) =>
      b.fromMain.filter((ch) => !sent.has(ch)).map((ch) => `${b.key}('${ch}') @preload.ts:${b.line}`)
    )
    expect(missing).toEqual([])
  })

  it('主进程注册的通道没有悬空（都能被 preload 暴露出去）', () => {
    const orphan = [...registered].filter((ch) => !exposedChannels.has(ch))
    expect(orphan).toEqual([])
  })
})

describe('IPC 契约 —— preload ↔ 渲染层类型声明', () => {
  it('preload 暴露的键与 env.d.ts 声明一一对应（双向无差集）', () => {
    expect(exposedKeys.filter((k) => !declaredKeys.includes(k))).toEqual([])
    expect(declaredKeys.filter((k) => !exposedKeys.includes(k))).toEqual([])
  })
})

describe('IPC 契约 —— 副窗窗口控制', () => {
  // 七个副窗入口（packs.html / pipeline.html / … + 各自 *-main.ts）都是无边框窗，
  // 必须各自有 min/max/close 三件套，否则窗内没有关闭入口。
  const PREFIXES = ['packs', 'pipeline', 'debug', 'dev', 'knowledge', 'benchmark', 'ruleReview']

  it.each(PREFIXES)('%s 窗有 min/max/close 三键，且各自有主进程注册', (prefix) => {
    for (const suffix of ['Minimize', 'Maximize', 'Close']) {
      const key = `${prefix}Window${suffix}`
      expect(exposedKeys).toContain(key)
      expect(declaredKeys).toContain(key)
    }
    const channels = blocks
      .filter((b) => b.key.startsWith(`${prefix}Window`))
      .flatMap((b) => b.toMain)
    expect(channels.length).toBe(3)
    for (const ch of channels) expect(registered.has(ch)).toBe(true)
  })

  it('packs 窗（无边框）在 UI 里真的接了这三个通道', () => {
    const vue = readFileSync(join(ROOT, 'src', 'components', 'packs', 'PackEditor.vue'), 'utf8')
    expect(vue).toContain('packsWindowMinimize')
    expect(vue).toContain('packsWindowMaximize')
    expect(vue).toContain('packsWindowClose')
    // 无边框窗需要拖拽区，否则整窗移不动
    expect(vue).toContain('-webkit-app-region: drag')
  })
})
