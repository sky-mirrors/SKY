import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadUserPackTree,
  createUserPackSource,
  createHybridPackSource
} from '@/host/pack/userPackSource'
import type { PackSource } from '@/host/pack/types'

/**
 * 2026-10-01（用户诉求：「领域包应该用户下载后自动接到路由」）：
 * 把 pack 源从「编译期内置」扩到「内置 + 用户目录」。本组锁定：
 * ① 递归读盘成内存树；② 6 个同步视图方法各自正确；③ 混合源并集且**内置优先**；
 * ④ 失败一律 fail-safe（目录不存在 / 无 IPC 能力 ⇒ 空树，绝不抛）。
 */
const ROOT = '/ud/holostarmap-packs'

const listing: Record<string, { name: string; isDir: boolean }[]> = {
  // 目录 name 带尾斜杠 —— 这是**真实** file:list 的契约（electron/fileListing.ts:69），
  // mock 若用裸名就会漏掉「packId 变成 'demo/'」这类 bug（真机实测踩到过）。
  [ROOT]: [{ name: 'shop/', isDir: true }],
  [`${ROOT}/shop`]: [
    { name: 'pack.json', isDir: false },
    { name: 'boundary/', isDir: true },
    { name: 'knowledge/', isDir: true },
    { name: 'execution/', isDir: true }
  ],
  [`${ROOT}/shop/boundary`]: [{ name: 'constraints.json', isDir: false }],
  [`${ROOT}/shop/knowledge`]: [{ name: 'a.json', isDir: false }],
  [`${ROOT}/shop/execution`]: [{ name: 'routing.json', isDir: false }]
}

const fileBody: Record<string, string> = {
  [`${ROOT}/shop/pack.json`]: JSON.stringify({ id: 'shop', version: '1.0.0', domain: 'ecommerce' }),
  [`${ROOT}/shop/boundary/constraints.json`]: JSON.stringify({ constraints: [{ id: 'c1' }] }),
  [`${ROOT}/shop/knowledge/a.json`]: JSON.stringify({ filename: 'a.md', text: '你好' }),
  [`${ROOT}/shop/execution/routing.json`]: JSON.stringify({ keywords: ['订单'] })
}

const originalWindow = globalThis.window

beforeEach(() => {
  ;(globalThis as any).window = {
    electronAPI: {
      fileList: vi.fn(async (dir: string) =>
        listing[dir] ? { success: true, entriesWithMeta: listing[dir] } : { success: false, error: '目录不存在' }),
      fileRead: vi.fn(async (p: string) =>
        fileBody[p] ? { success: true, content: fileBody[p] } : { success: false, error: 'not found' })
    }
  }
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
})

describe('loadUserPackTree —— 递归读盘（fail-safe）', () => {
  it('读出 packId → 相对路径 → 文件原文', async () => {
    const tree = await loadUserPackTree(ROOT)
    expect(Object.keys(tree)).toEqual(['shop'])
    expect(Object.keys(tree.shop).sort()).toEqual([
      'boundary/constraints.json',
      'execution/routing.json',
      'knowledge/a.json',
      'pack.json'
    ])
  })

  it('目录不存在 ⇒ 空树（不抛）', async () => {
    await expect(loadUserPackTree('/nope')).resolves.toEqual({})
  })

  it('无 electronAPI ⇒ 空树（不抛）', async () => {
    ;(globalThis as any).window = {}
    await expect(loadUserPackTree(ROOT)).resolves.toEqual({})
  })
})

describe('createUserPackSource —— 同步视图', () => {
  it('6 个方法与内置源同语义；evaluators 恒空（TS 是编译期能力）', async () => {
    const src = createUserPackSource(await loadUserPackTree(ROOT))
    expect(src.listPackIds()).toEqual(['shop'])
    expect((src.readManifest('shop') as { id: string }).id).toBe('shop')
    expect(src.readConstraints('shop')).toEqual({ constraints: [{ id: 'c1' }] })
    expect(src.listKnowledge('shop')).toEqual([{ filename: 'a.md', text: '你好' }])
    expect(src.listEvaluators('shop')).toEqual({})
    expect(src.readExecution('shop')).toEqual({ routing: { keywords: ['订单'] } })
    expect(src.readManifest('missing')).toBeNull()
  })
})

describe('createHybridPackSource —— 内置 + 用户', () => {
  const fakeBuiltin = (over: Partial<PackSource> = {}): PackSource => ({
    listPackIds: () => ['finance'],
    readManifest: () => ({ id: 'finance', from: 'builtin' }),
    readConstraints: () => null,
    listKnowledge: () => [],
    listEvaluators: () => ({ 'e.ts': {} as never }),
    readExecution: () => null,
    ...over
  })

  it('packId 并集', () => {
    const hybrid = createHybridPackSource(fakeBuiltin(), createUserPackSource({ shop: {} }))
    expect(hybrid.listPackIds().sort()).toEqual(['finance', 'shop'])
  })

  it('同名 pack 时内置优先（用户目录不能改写内置行为）', () => {
    const hybrid = createHybridPackSource(
      fakeBuiltin({ readManifest: () => ({ from: 'builtin' }) }),
      createUserPackSource({ finance: { 'pack.json': JSON.stringify({ from: 'user' }) } })
    )
    expect(hybrid.readManifest('finance')).toEqual({ from: 'builtin' })
  })

  it('内置没有的 pack 由用户补上', () => {
    const hybrid = createHybridPackSource(
      fakeBuiltin({ readManifest: () => null }),
      createUserPackSource({ shop: { 'pack.json': JSON.stringify({ from: 'user' }) } })
    )
    expect(hybrid.readManifest('shop')).toEqual({ from: 'user' })
  })

  it('知识文件取并集（同 pack 可内置+用户共存）', () => {
    const hybrid = createHybridPackSource(
      fakeBuiltin({ listKnowledge: () => [{ filename: 'b.md', text: 'builtin' }] }),
      createUserPackSource({ finance: { 'knowledge/a.json': JSON.stringify({ filename: 'a.md', text: 'user' }) } })
    )
    expect(hybrid.listKnowledge('finance').map(k => k.filename).sort()).toEqual(['a.md', 'b.md'])
  })
})
