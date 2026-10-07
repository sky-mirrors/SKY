import { describe, it, expect } from 'vitest'
import { tryL0Skill, type L0DirectPlan } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// 批量移动的**过滤器安全**契约（2026-10-08）
//
// 病理（代码坐实）：`file_move` 的批量形态里，`ext` 为空串 = **移动目录下全部文件**
//   （electron/ipc-handlers.ts:376 `!wantExt || n.toLowerCase().endsWith('.' + wantExt)`）。
// 而「建文件夹并归类文件」规则在抽不到扩展名时恰好传 `ext: ''`（l0SkillRouter.ts:547-551），
// 于是「把桌面上的**图片**都放进一个新建的文件夹里」会把桌面上**所有**文件
// ——连同 .exe / .lnk / 其它文档——一起搬进新文件夹：用户明确说了类型词，系统却当成"全部"。
// 这是批量数据移动，且是**静默的不符请求**，必须由契约钉住。
//
// 期望行为：① 类型词（图片/照片/音视频/压缩包/表格…）→ 扩展名集（多扩展名）；
//          ② 认得出是类型词、却映射不出扩展名集合（如「文档」）→ **fail-closed**：
//             不产出无界批量移动（宁可如实澄清，也不把用户桌面搬空）；
//          ③ 没有类型词（如「文件」）→ 保持既有语义（全量迁移），这是用户字面请求。
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic']

function moveStep(plan: L0DirectPlan | null | undefined) {
  return (plan?.steps || []).find(s => s.tool === 'file_move')
}

function extsOf(step: { params?: Record<string, string> } | undefined): string[] {
  return String(step?.params?.ext || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
}

describe('L0 · 归类到新文件夹：扩展名过滤器的安全边界', () => {
  it('类型词「图片」→ 过滤器必须落成图片扩展名集，绝不能是空串（空串=搬走桌面全部文件）', async () => {
    const plan = await tryL0Skill('把桌面上的图片都放进一个新建的文件夹里')
    const mv = moveStep(plan)
    expect(mv, '应产出确定性计划（建目录 + 批量移动）').toBeTruthy()

    const exts = extsOf(mv)
    expect(exts.length, `过滤器不能为空（空串会把桌面全部文件搬走）；实得：${JSON.stringify(mv?.params)}`).toBeGreaterThan(0)
    for (const e of exts) expect(IMAGE_EXTS, `非图片扩展名混进过滤器：${e}`).toContain(e)
    expect(exts).toContain('jpg')
    expect(exts).toContain('png')
  })

  it('换说法「所有的照片」同样落成图片扩展名集', async () => {
    const plan = await tryL0Skill('把桌面上所有的照片都收进一个新建的文件夹')
    const exts = extsOf(moveStep(plan))
    expect(exts.length).toBeGreaterThan(0)
    for (const e of exts) expect(IMAGE_EXTS).toContain(e)
  })

  it('类型词映射不出集合（「文档」）→ fail-closed：不得产出无界批量移动', async () => {
    const plan = await tryL0Skill('把桌面上的文档都放进一个新建的文件夹里')
    const mv = moveStep(plan)
    if (mv) {
      expect(extsOf(mv).length, '「文档」映射不出扩展名集时，不得退化成"移动全部文件"').toBeGreaterThan(0)
    }
  })

  it('无类型词（「文件」）→ 保持既有语义：全量迁移（空过滤器即用户字面请求）', async () => {
    const plan = await tryL0Skill('把桌面上的文件都放进一个新建的文件夹里')
    const mv = moveStep(plan)
    expect(mv).toBeTruthy()
    expect(extsOf(mv)).toEqual([])
  })
})
