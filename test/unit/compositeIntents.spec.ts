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
})

describe('组合意图 · 缺口登记（it.fails：实现后会自动报"意外通过"，届时移入已覆盖组）', () => {
  it.fails('CI-03 转换 + 归档：把桌面的 md 都转成 pdf 并收进新建文件夹', async () => {
    const plan = await tryL0Skill('把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里')
    expect(planTools(plan)).toEqual(['file_convert', 'file_move'])
  })

  it.fails('CI-04 重命名 + 归类：把桌面图片按日期重命名后收进新建文件夹', async () => {
    const plan = await tryL0Skill('把桌面上的图片按拍摄日期重命名，然后都归到一个新建文件夹里')
    expect(planTools(plan)).toEqual(['rename_images_by_date', 'file_move'])
  })

  it.fails('CI-05 解压 + 归类：把桌面的压缩包都解开并各自放好', async () => {
    const plan = await tryL0Skill('把桌面上的 zip 压缩包都解压，然后放进一个新建的文件夹里')
    // 必须含"解压/抽取"一步——仅 [create_directory, file_move] 只是把 zip 搬了个家，没有解压
    const tools = planTools(plan)
    const hasExtract = tools.some(t => /extract|unzip|archive|decompress/i.test(t))
    expect(hasExtract).toBe(true)
    expect(tools).toContain('file_move')
  })

  it.fails('CI-06 按类型分拣：把桌面文件按类型各归到一个文件夹', async () => {
    const plan = await tryL0Skill('把桌面上的文件按类型分好类，每类一个文件夹')
    expect(planTools(plan).filter(t => t === 'create_directory').length).toBeGreaterThanOrEqual(2)
  })

  it.fails('CI-07 改扩展名 + 归类：把桌面的 txt 都改成 md 并收进新建文件夹', async () => {
    const plan = await tryL0Skill('把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹')
    // 关键：不能只是 [create_directory, file_move]——那会把 txt 原样搬走，后缀没改
    expect(planTools(plan)).not.toEqual(['create_directory', 'file_move'])
    expect(planTools(plan)).toContain('file_move')
  })
})
