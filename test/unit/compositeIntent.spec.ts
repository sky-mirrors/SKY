import { describe, it, expect } from 'vitest'
import {
  looksComposite,
  actionFamilies,
  matchCompositePlan,
  resolveCollectFilter,
  type CollectFilter,
  type ComboTable
} from '@/services/compositeIntent'

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

// ─────────────────────────────────────────────────────────────────────────────
// 引擎（2026-10-08）：matchCompositePlan 读表产计划 + 过滤器解析
//
// 契约：**加一条组合 = 加一条数据，不改代码**（表 src/data/compositeCombos.json）。
// 故这里用**注入的合成表**证明引擎只依赖数据形状；真实表的端到端行为由
// compositeIntents.spec.ts（用户原句）与 l0CollectFilter.spec.ts（过滤器安全）覆盖。
// ─────────────────────────────────────────────────────────────────────────────
describe('matchCompositePlan：数据驱动引擎', () => {
  const ctx = (filter: CollectFilter) => ({ dir: 'D:\\src', target: 'D:\\src\\归档', folderName: '归档', filter })

  it('过滤器：显式扩展名 → 单扩展名；类型词 → 扩展名集；模糊类型词 → unmapped；无类型词 → 空（全部文件）', () => {
    expect(resolveCollectFilter('把桌面的 docx 都放进新文件夹')).toMatchObject({ exts: ['docx'], label: 'docx', category: null })
    const img = resolveCollectFilter('把桌面上的图片都放进新文件夹')
    expect(img.category).toBe('images')
    expect(img.exts).toContain('jpg')
    expect(img.exts).toContain('png')
    expect(resolveCollectFilter('把桌面上的文档都放进新文件夹')).toMatchObject({ exts: [], unmapped: true, label: '文档' })
    expect(resolveCollectFilter('把桌面上的文件都放进新文件夹')).toMatchObject({ exts: [], unmapped: false, label: '' })
  })

  it('合成表：加一条 combo（不改代码）就能产出该组合的计划，占位符全部渲染', () => {
    const table: ComboTable = {
      typeWords: {},
      ambiguousTypeWords: [],
      combos: [{
        id: 'demo-collect',
        name: '演示组合',
        enabled: true,
        intent: '演示：{folderName}（{extLabel}）',
        when: { familiesAllOf: ['mkdir', 'move'] },
        plan: [
          { tool: 'create_directory', description: '建目录 {target}', params: { path: '{target}' } },
          { tool: 'file_move', description: '把 {dir} 下的{extLabel}文件移走', params: { fromDir: '{dir}', ext: '{ext}', toDir: '{target}' } }
        ]
      }]
    }
    const plan = matchCompositePlan('把桌面上的图片都放进新建文件夹', ctx(resolveCollectFilter('把桌面上的图片都放进新建文件夹')), table)
    expect(plan?.steps.map(s => s.tool)).toEqual(['create_directory', 'file_move'])
    expect(plan?.steps[0].params.path).toBe('D:\\src\\归档')
    expect(plan?.steps[1].params.fromDir).toBe('D:\\src')
    expect(plan?.steps[1].params.ext).toContain('jpg')
    expect(plan?.intent).toContain('归档')
    expect(plan?.steps[1].description).toContain(' 图片 ')
  })

  it('缺能力优先于组合：要求解压时不得只搬不减压（哪怕 mkdir+move 组合成立）', () => {
    const table: ComboTable = {
      typeWords: {},
      ambiguousTypeWords: [],
      combos: [{
        id: 'mkdir-collect', name: '建文件夹并归类文件', enabled: true,
        when: { familiesAllOf: ['mkdir', 'move'] },
        plan: [{ tool: 'create_directory', params: { path: '{target}' } }, { tool: 'file_move', params: { fromDir: '{dir}', ext: '{ext}', toDir: '{target}' } }]
      }],
      $missing: [{ id: 'archive-collect', reason: '没有解压算子', alternative: '先手动解开', when: { patternsAllOf: ['解压'] } }]
    }
    const input = '把桌面上的 zip 压缩包都解压，然后放进一个新建的文件夹里'
    const plan = matchCompositePlan(input, ctx(resolveCollectFilter(input)), table)
    expect(plan?.steps.map(s => s.tool)).toEqual(['llm_generate'])
    expect(plan?.steps[0].params.prompt).toContain('没有解压算子')
  })

  it('过滤器映射不出扩展名集 ⇒ fail-closed（不得退化成"移动全部文件"）', () => {
    const input = '把桌面上的文档都放进一个新建的文件夹里'
    const plan = matchCompositePlan(input, ctx(resolveCollectFilter(input)))
    expect(plan?.steps.map(s => s.tool)).toEqual(['llm_generate'])
    expect(plan?.steps[0].params.prompt).toContain('文档')
  })

  it('无组合、无缺口 ⇒ null（下沉给下游层，不猜）', () => {
    expect(matchCompositePlan('把桌面的文件都列出来', ctx(resolveCollectFilter('把桌面的文件都列出来')))).toBeNull()
  })
})
