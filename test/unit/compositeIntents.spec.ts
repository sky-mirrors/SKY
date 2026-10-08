import { describe, it, expect } from 'vitest'
import { tryL0Skill } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// 组合意图（composite intents）—— 能力组合的**缺口登记册**（2026-10-07）
//
// 为什么要这份文件：
//   用户的真实请求常常是**两个已知能力的组合**（建目录 + 归类 / 转换 + 归档 / 重命名 + 移动 …），
//   而现有分层里**没有任何一层为"组合"负责**：
//     · L0 规则 = 手写正则 + 硬编码计划 ⇒ 只覆盖枚举过的句式，且规则之间会用 forbiddenPatterns 互斥；
//     · L2 候选 = 已编译的成品 manifest + 部分工具名 ⇒ 「刻意不进模型工具表」的能力（如 create_directory）
//       结构性缺席 ⇒ 组合请求落到候选消歧时**不可能给出正确选项**（实测：用户请求被错配成 create_docx）。
//   本文件把这类请求**逐个登记**，把"感觉缺东西"变成"可度量的缺口表"。
//
// 用法（重要）：
//   · `已覆盖` 组 —— 契约已实现，必须通过；
//   · `缺口登记` 组 —— 用 `it.fails`。**实现后它会由"预期失败"变成"意外通过"从而报错**，
//     提示你把它移到「已覆盖」组 —— 这是有意为之，防止缺口被遗忘。
//   新增一类组合意图：在缺口组加一条 `it.fails`，写明输入与期望的最小计划。
// ─────────────────────────────────────────────────────────────────────────────

/** 期望：L0 至少产出一个计划，且动作序列匹配 */
function planTools(plan: { steps?: Array<{ tool?: string }> } | null | undefined): string[] {
  return (plan?.steps || []).map(s => String(s?.tool || ''))
}

describe('组合意图 · 已覆盖（契约生效，必须通过）', () => {
  it('CI-01 建目录 + 归类（用户原句）', async () => {
    const plan = await tryL0Skill('将桌面上的docx文档全都放在一个新建的文件夹中，文件夹无需命名')
    expect(planTools(plan)).toEqual(['create_directory', 'file_move'])
    expect(plan!.steps[1].params.ext).toBe('docx')
  })

  it('CI-02 建目录 + 归类（换说法）', async () => {
    const plan = await tryL0Skill('将桌面上关于holo的docx文档全都放在你新建的文件夹里面')
    expect(planTools(plan)).toEqual(['create_directory', 'file_move'])
  })

  it('CI-00 回归：纯建文件夹仍走旧规则（不得被组合规则吞掉）', async () => {
    const plan = await tryL0Skill('新建一个名为 mydir 的文件夹')
    expect(planTools(plan)).toEqual(['create_directory'])
  })

  it('CI-04 重命名 + 归类：把桌面图片按日期重命名后收进新建文件夹（2026-10-08 由缺口翻牌）', async () => {
    const plan = await tryL0Skill('把桌面上的图片按拍摄日期重命名，然后都归到一个新建文件夹里')
    expect(planTools(plan)).toEqual(['rename_images_by_date', 'file_move'])
    // 重命名按目录、归类按扩展名集——两处参数都必须落在真实目录/真实扩展名上（不是空串）
    expect(String(plan!.steps[0].params.dir)).toContain('Desktop')
    expect(String(plan!.steps[1].params.ext).split(',').filter(Boolean).length).toBeGreaterThan(0)
  })

  it('CI-06 按类型分拣：把桌面文件按类型各归到一个文件夹（2026-10-08 由缺口翻牌：新增算子 file_sort_by_type）', async () => {
    // 缺口原由：静态计划表达不了「一个动作产出多个目录并按类型分派」（create_directory / file_move 都只支持单目标）
    // ⇒ 补批处理算子（与 rename_images_by_date 同型），组合表里从 $missing 移到 combos。
    const plan = await tryL0Skill('把桌面上的文件按类型分好类，每类一个文件夹')
    expect(planTools(plan)).toEqual(['file_sort_by_type'])
    expect(String(plan!.steps[0].params.fromDir)).toContain('Desktop')
  })

  it('CI-05 解压 + 归类：把桌面的压缩包各自解开归档（2026-10-08 由缺口翻牌：新增算子 file_unzip）', async () => {
    // 缺口原由：没有解压算子（依赖里的 extract-zip 此前只用于恢复应用自身备份）。语义选型见 electron/fileUnzip.ts：
    // **每个压缩包解成一个同名子目录**（不把多个包摊平混合），目标已存在则跳过。
    const plan = await tryL0Skill('把桌面上的 zip 压缩包都解压，然后放进一个新建的文件夹里')
    expect(planTools(plan)).toEqual(['file_unzip'])
    expect(String(plan!.steps[0].params.fromDir)).toContain('Desktop')
    expect(String(plan!.steps[0].params.toDir)).toContain('新建文件夹')
  })

  it('CI-07 改扩展名 + 归类：把桌面的 txt 都改成 md 收进新文件夹（2026-10-08 由缺口翻牌：新增算子 file_rename_ext）', async () => {
    // 缺口原由：file_move 只能搬到指定目标路径（可顺带改名），没有「只改扩展名、留在原位」的批量形态。
    // 本用例特意钉住两处容易写错的地方：源/目标扩展名分别取对，且**归类按改后的后缀**（按 txt 收等于没改）。
    const plan = await tryL0Skill('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')
    expect(planTools(plan)).toEqual(['file_rename_ext', 'file_move'])
    expect(plan!.steps[0].params).toMatchObject({ fromExt: 'txt', toExt: 'md' })
    expect(String(plan!.steps[1].params.ext)).toBe('md')
  })
  it('CI-03 转换 + 归档：把桌面的 md 都转成 pdf 收进新建文件夹（2026-10-08 由缺口翻牌：file_convert 补批量形态）', async () => {
    // 缺口原由：file_convert 是**单文件**算子（source/target 都必填，只出 PDF），静态计划表达不了
    // 「对目录下每个文件都转一次」⇒ 补批量形态 { fromDir, ext, targetDir }（主进程逐个调用同一转换管线）。
    const plan = await tryL0Skill('把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里')
    expect(planTools(plan)).toEqual(['file_convert'])
    expect(String(plan!.steps[0].params.ext)).toBe('md')
    expect(String(plan!.steps[0].params.fromDir)).toContain('Desktop')
    expect(String(plan!.steps[0].params.targetDir)).toContain('新建文件夹')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 缺口登记册（it.fails 组）——**当前为空**：CI-03..CI-07 六条已全部实现并翻牌。
// 机制保留：以后遇到"感觉缺东西"的组合意图，按下面的三步加回去——
//   ① 数据面：src/data/compositeCombos.json 的 $missing 加一条（引擎据此**如实拒绝**，绝不"少做一半"）；
//   ② 契约面：本文件加一条 `it.fails('CI-XX …')`，写明输入与期望的最小计划（实现后它会自动报"意外通过"，逼人翻牌）；
//   ③ 行为面：在下面的「缺口当前行为」组加一条，钉住"如实说明 + 给替代做法"这个出口。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 缺口的**当前行为**契约（2026-10-08）：能力还没补上时，系统必须"如实说做不到"，
// 而不是产出「少做一半」的计划——只把 zip 搬个家却不解压、只搬 txt 却不改后缀，
// 都是对用户的静默降级（用户以为成了，产物不符）。
// 这一组随缺口实现而更新（与上一组 it.fails 同进同退）。
// ─────────────────────────────────────────────────────────────────────────────
describe('组合意图 · 缺口当前行为：如实说明，不"少做一半"', () => {
  it('域词（写周报 + 放进文件夹）不得被当成"归类桌面已有文件"', async () => {
    const plan = await tryL0Skill('帮我写一份周报，存成 docx，然后放进一个新建的文件夹里')
    const steps = plan?.steps || []
    expect(steps.some(s => s.tool === 'file_move' && (s.params as Record<string, string>)?.fromDir)).toBe(false)
  })

  it('「未解压的压缩包」是移动请求，不得被判成"解压+归类"缺口', async () => {
    const plan = await tryL0Skill('把桌面上还没解压的压缩包都放进一个新建的文件夹里')
    const steps = plan?.steps || []
    expect(steps.some(s => s.tool === 'file_move' && (s.params as Record<string, string>)?.fromDir), '应正常批量移动 zip').toBe(true)
  })

  it('批量转格式 + 归类：目标**不是 PDF** 时不得假装能转（应用内转换只出 PDF）', async () => {
    // 2026-10-08：PDF 目标已有真算子（convert-collect）；但用户要 →docx 这类目标时仍无能力，
    // 此时必须如实说明，不得回落成"只搬不转"的 mkdir-collect，也不得产出假转换计划。
    const plan = await tryL0Skill('把桌面上所有的 md 文件转成 docx，然后都放进一个新建的文件夹里')
    const steps = plan?.steps || []
    const prompt = steps.map(s => String((s.params as Record<string, string>)?.prompt || '')).join('\n')
    expect(prompt, `实得步骤：${JSON.stringify(steps.map(s => s.tool))}`).toContain('只出 PDF')
    expect(steps.some(s => s.tool === 'file_convert')).toBe(false)
  })
})
