// 回归测试：路由假阳性修复（B + A）。
//
// 背景（验收考试复考 exam-report.json 实证）：
//   题 Q9「合同违约金每日金额」的三千字合同正文、题 Q4「商务邮件改写」的邮件正文，
//   被误派进 l2-sales-proposal-draft-v1（销售提案草稿）宏——两题输出逐字相同的销售话术问卷。
//
// B：关键词匹配限定「指令段」——附着材料不得淹没指令（test/unit 中已实现）。
// A：给销售提案 manifest 补 forbiddenKeywords（变换/列查类意图反向门）——
//    指令含「改写/翻译/总结/列出…」时该清单关键词分归零，治 B 覆盖不到的 Q4
//    （Q4 的「商务」就在指令段内，B 抹不掉；但「改写」暴露了它是改写任务而非生成任务）。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/embedder', () => ({
  generateVector: vi.fn(() => Promise.resolve(new Array(384).fill(0.1))),
  cosineSimilarity: vi.fn(() => 1)
}))
vi.mock('@/services/fileContext', () => ({ getFileBoostForItem: vi.fn(() => 0) }))
vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: vi.fn(() => ({ getWeightModifier: vi.fn(() => 0) }))
}))
vi.mock('@/stores/debugStore', () => ({
  useDebugStore: vi.fn(() => ({ emitEvent: vi.fn() }))
}))

import { keywordMatchScore } from '@/services/toolRetrieval'
import l2Manifests from '@/data/l2Manifests'
import { EXAM_CASES } from '@/exam/examCases'

const sales = l2Manifests.find(m => m.identity.id === 'l2-sales-proposal-draft-v1')!
const q4 = EXAM_CASES.find(c => c.id === 'Q4')!
const q9 = EXAM_CASES.find(c => c.id === 'Q9')!

describe('B：关键词匹配限定指令段（附着材料不淹没指令）', () => {
  it('前置：sales manifest 与 Q9 用例存在', () => {
    expect(sales).toBeDefined()
    expect(q9).toBeDefined()
  })

  it('Q9 长合同正文（附着材料）不得让关键词命中销售提案宏', () => {
    // RED→GREEN 锚点：旧实现对整段输入匹配 → 命中「方案/报价」→ >0；限定指令段后 → 0
    expect(keywordMatchScore(q9.prompt, sales)).toBe(0)
  })

  it('合成：指令无关键词 + 附着材料堆满关键词 → 0', () => {
    const material = '销售 提案 方案 客户 商务 报价 '.repeat(20)
    const input = `帮我算一下这份合同每天违约金多少钱？\n\n${material}`
    expect(keywordMatchScore(input, sales)).toBe(0)
  })

  it('合成：指令含关键词 + 附着材料无关 → 仍命中（防误伤）', () => {
    const input = '帮我根据客户需求生成一份销售提案草稿，含报价方案\n\n' + '无关的会议记录内容'.repeat(20)
    expect(keywordMatchScore(input, sales)).toBeGreaterThan(0)
  })

  it('无附着材料（单段指令）行为不变', () => {
    expect(keywordMatchScore('帮我写一份销售提案，包含报价方案', sales)).toBeGreaterThan(0)
    expect(keywordMatchScore('帮我写一份会议纪要', sales)).toBe(0)
  })
})

describe('A：变换/列查类意图反向门（forbiddenKeywords）', () => {
  it('前置：sales manifest 声明了 forbiddenKeywords', () => {
    expect(sales.routing.forbiddenKeywords?.length).toBeGreaterThan(0)
  })

  it('Q4 商务邮件改写（改写任务）不得命中销售提案宏', () => {
    // RED→GREEN 锚点：Q4 指令段含「改写」；无禁词时 keywordMatchScore >0（B 覆盖不到）
    expect(keywordMatchScore(q4.prompt, sales)).toBe(0)
  })

  it('常见变换类指令一律不命中', () => {
    expect(keywordMatchScore('把这封邮件改写成正式商务邮件', sales)).toBe(0)
    expect(keywordMatchScore('把这段内容翻译成英文', sales)).toBe(0)
    expect(keywordMatchScore('帮我润色一下这份方案', sales)).toBe(0)
    expect(keywordMatchScore('总结一下这个销售方案', sales)).toBe(0)
  })

  it('列查类指令不命中（要读不要生成）', () => {
    expect(keywordMatchScore('列出所有销售方案清单', sales)).toBe(0)
    expect(keywordMatchScore('查看一下这个商务报价', sales)).toBe(0)
  })

  it('正常生成类输入不受影响（防误伤）', () => {
    expect(keywordMatchScore('根据客户需求生成一份销售提案，含报价方案', sales)).toBeGreaterThan(0)
    expect(keywordMatchScore('帮我起草一个新的商务方案', sales)).toBeGreaterThan(0)
  })
})
