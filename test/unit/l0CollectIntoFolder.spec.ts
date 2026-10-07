import { describe, it, expect } from 'vitest'
import { tryL0Skill } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// L0 · 「建文件夹并归类文件」组合意图（2026-10-07）
//
// 病理（真实用户对话，探针实测）：
//   用户说「将桌面上的docx文档全都放在一个新建的文件夹中，文件夹无需命名」
//   ① 既有『创建文件夹』规则的 trigger 要求「新建文件夹」**紧邻**，用户写的是「新建**的**文件夹」⇒ 不命中；
//      用该句实测 4 条触发模式：全部不命中（RED 证据）。
//   ② 且该规则 forbiddenPatterns 含 `文档|docx|…`，该句含 docx ⇒ 规则被**主动禁用**。
//   ③ 于是落到 L2 候选消歧，而候选池**不含 create_directory**（刻意不进模型工具表）
//      ⇒ 给出 create_docx(70%)/doc_extract/文档翻译/合同风险审查 等完全不沾边的候选；
//   ④ 用户被迫选「1」⇒ 真去创建了一份 Word 文档，并把 list_directory 原始返回当答案吐回；两次同样失败。
//
// 本文件锁定修复：该组合意图应命中 L0 并产出**确定性两步计划**（建目录 + 按类型批量移动），不经候选消歧。
// ─────────────────────────────────────────────────────────────────────────────

describe('L0 · 建文件夹并归类文件（组合意图）', () => {
  it('原句（用户真实输入）命中本规则并产出两步计划', async () => {
    const plan = await tryL0Skill('将桌面上的docx文档全都放在一个新建的文件夹中，文件夹无需命名')
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(2)
    expect(plan!.steps[0].tool).toBe('create_directory')
    expect(plan!.steps[1].tool).toBe('file_move')
    expect(plan!.steps[1].params.ext).toBe('docx')
    expect(String(plan!.steps[1].params.fromDir)).toContain('Desktop')
    expect(String(plan!.steps[1].params.toDir)).toContain('新建文件夹')
  })

  it('换说法（用户第二轮实际输入）同样命中', async () => {
    const plan = await tryL0Skill('将桌面上关于holo的docx文档全都放在你新建的文件夹里面')
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(2)
    expect(plan!.steps[1].tool).toBe('file_move')
    expect(plan!.steps[1].params.ext).toBe('docx')
  })

  it('不误伤：纯「建文件夹」仍走旧规则（只建目录、不移动）', async () => {
    const plan = await tryL0Skill('新建一个名为 mydir 的文件夹')
    expect(plan).not.toBeNull()
    expect(plan!.steps).toHaveLength(1)
    expect(plan!.steps[0].tool).toBe('create_directory')
  })

  it('不误伤：文档生成类请求不产出「建文件夹+移动」计划', async () => {
    const plan = await tryL0Skill('帮我写一份周报，存成 docx')
    const hasBatchMove = plan?.steps?.some(s => s.tool === 'file_move' && s.params?.fromDir)
    expect(hasBatchMove).not.toBe(true)
  })
})
