import { describe, it, expect } from 'vitest'
import { tryL0Skill, type L0DirectPlan } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// 组合意图的**真实说法语料回归**（2026-10-08）
//
// 为什么加这一份：今天一天里同一个缺陷类踩了两次——
//   · CI-04「按拍摄日期重命名后归到新建文件夹」被『创建文件夹』抢走（只建了个空文件夹）；
//   · CI-07「改成 md 后缀」既进不了 rename 家族、也没算子，请求静默退化成"只搬不改"。
//   两次都不是判据错，而是**规则之间的抢单与触发式漂移**——单条 combo 的单测看不见这类问题。
// 故这里用**用户原话**（换说法一起）钉住"哪条请求该落到哪条路"，作为这一层的回归网。
// 新增组合/新增规则后，先跑这份语料再跑全量。
// ─────────────────────────────────────────────────────────────────────────────

function tools(plan: L0DirectPlan | null | undefined): string[] {
  return (plan?.steps || []).map(s => String(s.tool || ''))
}
function params(plan: L0DirectPlan | null | undefined, i = 0): Record<string, string> {
  return (plan?.steps?.[i]?.params || {}) as Record<string, string>
}
async function planOf(input: string) {
  return tryL0Skill(input)
}

describe('语料回归 · 归类类（建目录 + 批量移动）', () => {
  it('「把桌面上的 docx 都放进一个新建的文件夹」（用户原句）', async () => {
    const p = await planOf('将桌面上的docx文档全都放在一个新建的文件夹中，文件夹无需命名')
    expect(tools(p)).toEqual(['create_directory', 'file_move'])
    expect(params(p, 1).ext).toBe('docx')
    expect(String(params(p, 1).toDir)).toContain('新建文件夹')
  })

  it('换说法「你新建的文件夹」同样命中（历史 bug：触发式要求"新建文件夹"紧邻）', async () => {
    const p = await planOf('将桌面上关于holo的docx文档全都放在你新建的文件夹里面')
    expect(tools(p)).toEqual(['create_directory', 'file_move'])
  })

  it('类型词「图片」→ 过滤器落成图片扩展名集（**不得**是空串＝搬空桌面）', async () => {
    const p = await planOf('把桌面上的图片都放进一个新建的文件夹里')
    const exts = String(params(p, 1).ext).split(',').filter(Boolean)
    expect(exts.length).toBeGreaterThan(0)
    expect(exts).toContain('jpg')
  })

  it('纯建文件夹不误伤：只建目录、不移动', async () => {
    const p = await planOf('新建一个名为 mydir 的文件夹')
    expect(tools(p)).toEqual(['create_directory'])
  })
})

describe('语料回归 · 组合类（各自落到自己的算子）', () => {
  it('图片按日期重命名 + 归类 → rename_images_by_date（不得被"创建文件夹"抢走）', async () => {
    const p = await planOf('把桌面上的图片按拍摄日期重命名，然后都归到一个新建文件夹里')
    expect(tools(p)).toEqual(['rename_images_by_date', 'file_move'])
  })

  it('按类型分拣 → file_sort_by_type', async () => {
    const p = await planOf('把桌面上的文件按类型分好类，每类一个文件夹')
    expect(tools(p)).toEqual(['file_sort_by_type'])
  })

  it('解压 + 归类 → file_unzip（不得只把 zip 搬家）', async () => {
    const p = await planOf('把桌面上的 zip 压缩包都解压，然后放进一个新建的文件夹里')
    expect(tools(p)).toEqual(['file_unzip'])
  })

  it('改后缀 + 归类 → 先就地把 txt 改成 md，再按**新**后缀归类', async () => {
    const p = await planOf('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')
    expect(tools(p)).toEqual(['file_rename_ext', 'file_move'])
    expect(params(p, 0)).toMatchObject({ fromExt: 'txt', toExt: 'md' })
    expect(params(p, 1).ext).toBe('md')
  })

  it('批量转 PDF + 归类 → file_convert 批量形态（ext 取源类型）', async () => {
    const p = await planOf('把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里')
    expect(tools(p)).toEqual(['file_convert'])
    expect(params(p, 0).ext).toBe('md')
  })
})

describe('语料回归 · 诚实边界（做不到就说做不到，且不得"少做一半"）', () => {
  it('转成 docx 再归类 → 如实说明（应用内转换只出 PDF），不得产出 file_convert', async () => {
    const p = await planOf('把桌面上所有的 md 文件转成 docx，然后都放进一个新建的文件夹里')
    expect(tools(p)).not.toContain('file_convert')
    expect(tools(p)).not.toContain('file_move')
    expect(tools(p)).toContain('llm_generate')
  })

  it('「未解压的压缩包」是移动请求 → 照常批量移动（不得误判成解压缺口）', async () => {
    const p = await planOf('把桌面上还没解压的压缩包都放进一个新建的文件夹里')
    expect(tools(p)).toContain('file_move')
    expect(tools(p)).not.toContain('llm_generate')
  })

  it('域词（写周报）不得被当成"归类桌面已有文件"', async () => {
    const p = await planOf('帮我写一份周报，存成 docx，然后放进一个新建的文件夹里')
    expect(tools(p)).not.toEqual(['create_directory', 'file_move'])
  })

  it('映射不出类型的类型词（「文档」）→ fail-closed：不产出无界批量移动', async () => {
    const p = await planOf('把桌面上的文档都放进一个新建的文件夹里')
    const mv = (p?.steps || []).find(s => s.tool === 'file_move')
    if (mv) expect(String(mv.params.ext || '').split(',').filter(Boolean).length).toBeGreaterThan(0)
  })
})

describe('语料回归 · 不该被组合规则抢走的（列举/读/问）', () => {
  it('列清单类请求不得产出"建目录 + 移动"', async () => {
    const p = await planOf('列出桌面上所有的 docx 文件')
    expect(tools(p)).not.toContain('file_move')
  })

  it('纯问答不落到文件组合', async () => {
    const p = await planOf('什么是向量数据库？')
    expect(tools(p)).not.toContain('file_move')
  })
})
