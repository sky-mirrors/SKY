import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles } from '@electron/fileSearch'

/**
 * 只读检索（2026-10-07 Wave 2）
 *
 * 动机：常驻原生工具集（NATIVE_TOOL_NAMES）里此前**没有任何检索类能力**（无 grep/glob），
 * 「找一下哪里用到 X」只能靠模型自己逐层 list_directory。本模块是 `file:search` 的数据路径，
 * 抽成叶子模块以便直接对真实目录断言（同 fileListing.ts 的约定：handler 只留路径校验与错误包装）。
 *
 * 边界（不变量）：只读、不写任何文件；跳过 node_modules/.git 等重目录；递归深度与结果数有上限。
 */
describe('fileSearch · 只读检索', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'holo-search-'))
    mkdirSync(join(root, 'sub'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'alpha.md'), 'hello world\nneeds 检索 here\n')
    writeFileSync(join(root, 'beta.txt'), 'nothing relevant\n')
    writeFileSync(join(root, 'sub', 'alpha2.md'), 'deep content\n')
    writeFileSync(join(root, 'node_modules', 'alpha3.md'), 'should be skipped\n')
  })
  afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('按名检索：递归命中、且跳过 node_modules', () => {
    const r = searchFiles(root, 'alpha', 'name')
    expect(r.hits.map(h => h.name).sort()).toEqual(['alpha.md', 'alpha2.md'])
    expect(JSON.stringify(r.hits)).not.toContain('node_modules')
  })

  it('按内容检索：带行号与片段', () => {
    const r = searchFiles(root, '检索', 'content')
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].name).toBe('alpha.md')
    expect(r.hits[0].line).toBe(2)
    expect(String(r.hits[0].excerpt)).toContain('检索')
  })

  it('maxResults 生效并标记 truncated', () => {
    const r = searchFiles(root, 'alpha', 'name', 1)
    expect(r.hits).toHaveLength(1)
    expect(r.truncated).toBe(true)
  })

  it('空 query 直接返回空（不遍历）', () => {
    const r = searchFiles(root, '', 'name')
    expect(r.hits).toEqual([])
    expect(r.scanned).toBe(0)
  })

  it('上层给再大的 maxResults 也被上限钳住', () => {
    const r = searchFiles(root, 'alpha', 'name', 100000)
    expect(r.hits.length).toBeLessThanOrEqual(200)
  })
})
