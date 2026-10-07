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
})

describe('组合意图 · 缺口登记（it.fails：实现后会自动报"意外通过"，届时移入已覆盖组）', () => {
  // 2026-10-08：登记册从「感觉缺东西」升级为「可机读缺口」——同一份缺口现在有两面：
  //   · 数据面：src/data/compositeCombos.json 的 $missing（引擎据此**如实拒绝**，绝不"少做一半"）；
  //   · 契约面：本组的 it.fails（实现后翻牌，防止缺口被遗忘）。
  // 两面的 id 一一对应：CI-03↔convert-collect、CI-07↔change-ext-collect。
  // （CI-04↔rename-collect、CI-06↔split-by-type、CI-05↔archive-collect 已分别于 2026-10-08 实现并翻牌，见上一组。）
  it.fails('CI-03 转换 + 归档：把桌面的 md 都转成 pdf 并收进新建文件夹', async () => {
    const plan = await tryL0Skill('把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里')
    expect(planTools(plan)).toEqual(['file_convert', 'file_move'])
  })

  it.fails('CI-07 改扩展名 + 归类：把桌面的 txt 都改成 md 并收进新建文件夹', async () => {
    const plan = await tryL0Skill('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')
    // 关键：不能只是 [create_directory, file_move]——那会把 txt 原样搬走，后缀没改
    expect(planTools(plan)).not.toEqual(['create_directory', 'file_move'])
    expect(planTools(plan)).toContain('file_move')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 缺口的**当前行为**契约（2026-10-08）：能力还没补上时，系统必须"如实说做不到"，
// 而不是产出「少做一半」的计划——只把 zip 搬个家却不解压、只搬 txt 却不改后缀，
// 都是对用户的静默降级（用户以为成了，产物不符）。
// 这一组随缺口实现而更新（与上一组 it.fails 同进同退）。
// ─────────────────────────────────────────────────────────────────────────────
describe('组合意图 · 缺口当前行为：如实说明，不"少做一半"', () => {
  it('改扩展名 + 归类：不得仅产出「建目录 + 批量移动」（那只是把 txt 搬家）', async () => {
    const plan = await tryL0Skill('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')
    const steps = plan?.steps || []
    expect(steps.some(s => s.tool === 'file_move' && (s.params as Record<string, string>)?.fromDir)).toBe(false)
    expect(steps.some(s => s.tool === 'llm_generate')).toBe(true)
  })

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

  it('批量转格式 + 归类：必须走缺口如实说明，不得被单文件转换规则抢去"要完整路径"', async () => {
    // 2026-10-08：这条请求先命中『文件格式转换』（在组合规则之前）。该规则是**单文件**转换器
    // （source/target 必填），抽不到路径时只能回一句「请提供完整路径」——用户的批次语义
    // （「所有的 md」）根本没被处理，等于用一句错误的澄清吃掉了整个请求。
    // 期望：下沉给组合规则，按 $missing 的 convert-collect 如实说明「批量转格式没有算子」+ 替代做法。
    const plan = await tryL0Skill('把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里')
    const steps = plan?.steps || []
    const prompt = steps.map(s => String((s.params as Record<string, string>)?.prompt || '')).join('\n')
    expect(prompt, `实得步骤：${JSON.stringify(steps.map(s => s.tool))}`).toContain('没有组合算子')
    expect(steps.some(s => s.tool === 'file_convert'), '不得假装能批量转换').toBe(false)
  })
})
