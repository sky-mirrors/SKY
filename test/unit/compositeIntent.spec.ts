import { describe, it, expect } from 'vitest'
import { looksComposite, actionFamilies } from '@/services/compositeIntent'

// ─────────────────────────────────────────────────────────────────────────────
// 组合意图判据（2026-10-07）—— 候选机制前的守卫
//
// 判据用途：L2 低置信路径（selectDisambigStrategy → show_candidates）**不再对组合请求出候选**，
// 而是返回 miss 交给 L3/L4 规划。理由见 src/services/compositeIntent.ts 模块头注释。
// 本文件锁定：① 组合请求被识别；② **单动作/纯问答不得被误判**（否则会把正常候选路径打死）。
// ─────────────────────────────────────────────────────────────────────────────

describe('looksComposite：组合意图判据', () => {
  it('两个动作家族（建目录 + 归类）⇒ true', () => {
    expect(looksComposite('将桌面上的docx文档全都放在一个新建的文件夹中，文件夹无需命名')).toBe(true)
    expect(actionFamilies('将桌面上的docx文档全都放在一个新建的文件夹中')).toEqual(
      expect.arrayContaining(['mkdir', 'move'])
    )
  })

  it('顺序连接词 + 单动作 ⇒ true', () => {
    expect(looksComposite('把它压缩一下，然后发给我')).toBe(true)
  })

  it('转换 + 归类 ⇒ true', () => {
    expect(looksComposite('把桌面的 md 都转成 pdf，然后收进一个文件夹')).toBe(true)
  })

  it('不误判：单动作（只有建目录）⇒ false', () => {
    expect(looksComposite('新建一个名为 mydir 的文件夹')).toBe(false)
  })

  it('不误判：纯问答（无动作家族）⇒ false', () => {
    expect(looksComposite('什么是向量数据库？')).toBe(false)
    expect(looksComposite('1+1 等于几')).toBe(false)
    expect(looksComposite('把刚才那个清单前三个名字念给我')).toBe(false)
  })

  it('不误判：单个移动动作但有"再"字（连接词）——当前判据判 true（保守，宁可转规划）', () => {
    // 这条是**已知的保守偏差**：判据宁可多转规划，也不把用户放进错误候选里。
    // 若日后要收紧，需先有"候选命中率"指标证明误伤代价（见 docs 总览 §5）。
    expect(looksComposite('再把那个文件移过去')).toBe(true)
  })
})
