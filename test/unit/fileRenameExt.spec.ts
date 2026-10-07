import { describe, it, expect } from 'vitest'
import { planRenameExt, normalizeExtToken } from '@electron/fileRenameExt'

// ─────────────────────────────────────────────────────────────────────────────
// 「批量改扩展名（留在原位）」的**纯计划核心**（2026-10-08）—— CI-07 缺口
//（「把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹」）。
//
// 缺口原由：file_move 只能把文件搬到指定目标路径（可顺带改名），没有「只改扩展名、留在原位」的批量形态。
// 语义约束（同前两个算子）：
//   · 就地改名：`<目录>\a.txt` → `<目录>\a.md`（不挪窝）；
//   · 目标已存在同名文件 ⇒ **跳过并上报**（绝不覆盖 ⇒ 可重复执行）；
//   · fromExt == toExt 且大小写一致 ⇒ 无需改名（跳过，避免无意义的重写与"改了个寂寞"的假成功）。
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeExtToken', () => {
  it('去点、去空白、小写；jpeg→jpg 类归并交给调用方（此处只做字面归一）', () => {
    expect(normalizeExtToken('.MD')).toBe('md')
    expect(normalizeExtToken(' Txt ')).toBe('txt')
    expect(normalizeExtToken('')).toBe('')
  })
})

describe('planRenameExt：就地改名计划', () => {
  it('只挑源扩展名匹配的文件，逐个算目标名（保留多点的主名）', () => {
    const plan = planRenameExt(['a.txt', 'b.TXT', 'c.md', 'd.txt.bak', 'note'], 'txt', 'md')
    expect(plan).toEqual([
      { from: 'a.txt', to: 'a.md' },
      { from: 'b.TXT', to: 'b.md' }
    ])
  })

  it('源扩展名与目标扩展名相同（忽略大小写）⇒ 空计划（无意义的重命名不做）', () => {
    expect(planRenameExt(['a.md', 'b.MD'], 'md', 'md')).toEqual([])
    expect(planRenameExt(['a.txt', 'b.TXT'], 'txt', 'txt')).toEqual([])
  })

  it('目标扩展名为空 ⇒ 空计划（fail-closed：不产出"去掉扩展名"这类破坏性改名）', () => {
    expect(planRenameExt(['a.txt'], 'txt', '')).toEqual([])
  })

  it('无扩展名文件不参与（不带点 ⇒ 不是"某类文件"）', () => {
    expect(planRenameExt(['LICENSE', '.env'], 'env', 'txt')).toEqual([])
  })
})
