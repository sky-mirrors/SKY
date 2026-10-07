import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * tokens.css 里出现的类选择器必须在真实模板中存在（防「死规则」）
 *
 * 背景（2026-10-07）：tokens.css 用 `.msg-content` 与 `.chat-input textarea` 去主题化「消息气泡」与
 * 「输入框」，但模板里根本没这两个类（真实类是 `.text-msg` 与裸 `textarea`）——两条规则长期是**死规则**，
 * 气泡/输入框从未被主题化，直到用活 DOM 审计才发现。本测试把「选择器必须命中真实类」固化为不变量。
 *
 * 模板中以动态拼接收尾的类（如 `:class="[`msg-${msg.role}`]"`）无法字面匹配，列入 ALLOW。
 */
const ALLOW = new Set(['msg-user', 'msg-assistant', 'msg-system'])

describe('tokens.css 类选择器必须命中真实模板类', () => {
  const root = process.cwd()
  const raw = readFileSync(join(root, 'src/styles/tokens.css'), 'utf-8')
  const tokens = raw.replace(/\/\*[\s\S]*?\*\//g, '') // 去注释后再提取选择器
  const vue = walk(join(root, 'src'))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => readFileSync(f, 'utf-8'))
    .join('\n')

  it('每个 .class 都在某个 .vue 里出现过（或属已知动态类）', () => {
    const classes = new Set<string>()
    for (const m of tokens.matchAll(/(?<![%\w.-])\.([a-zA-Z_][\w-]*)/g)) classes.add(m[1])
    const missing = [...classes].filter((c) => !ALLOW.has(c) && !vue.includes(c))
    expect(missing).toEqual([])
  })

  it('回归守卫：不再使用不存在的 .msg-content / .chat-input', () => {
    expect(tokens.includes('msg-content')).toBe(false)
    expect(tokens.includes('chat-input')).toBe(false)
  })
})
