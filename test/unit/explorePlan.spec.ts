// N2：探索计划须含确定性文件步骤。
//
// 根因（验收考试三轮实证）：Q14「列桌面 .docx 清单」/ Q16「在 HoloExam 文件夹里找张三的报销单」
// 都落到 buildExplorePlan 的通用分支——单步 llm_generate，计划里没有任何文件读取步骤；
// 框架把「调不调工具」完全交给 3b 小模型，而它选择用散文回答（"我无法访问你的文件"）。
// 修法：文件相关但无显式路径时，由**框架**确定性地 list_directory，把真实清单喂给 LLM。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/kernel/plugins/llm', () => ({
  getLLM: vi.fn(() => null)   // 无 LLM：确保 buildExplorePlan 不走文件名兜底路径
}))

import { buildExplorePlan } from '@/services/l0SkillRouter'
import { EXAM_CASES } from '@/exam/examCases'

const q14 = EXAM_CASES.find(c => c.id === 'Q14')!
const q16 = EXAM_CASES.find(c => c.id === 'Q16')!

describe('N2：探索计划的确定性文件步骤', () => {
  it('Q14（列桌面 .docx 清单）→ 首步为 list_directory 且指向桌面', async () => {
    const p = await buildExplorePlan(q14.prompt)
    expect(p.steps[0].tool).toBe('list_directory')
    expect(String(p.steps[0].params.path).toLowerCase()).toContain('desktop')
    // 末步把清单喂给 LLM，且必须依赖第 1 步（否则 {{step_1_result}} 无依赖保证）
    const answerStep = p.steps.find(s => s.tool === 'llm_generate')!
    expect(answerStep).toBeDefined()
    expect(answerStep.depends_on).toContain(1)
    expect(JSON.stringify(answerStep.params)).toContain('{{step_1_result}}')
  })

  it('Q16（在 HoloExam 文件夹找张三报销单）→ 首步 list_directory 且路径含 HoloExam', async () => {
    const p = await buildExplorePlan(q16.prompt)
    expect(p.steps[0].tool).toBe('list_directory')
    expect(String(p.steps[0].params.path)).toContain('HoloExam')
  })

  it('普通请求不被劫持（仍走单步 llm_generate）', async () => {
    const p = await buildExplorePlan('帮我把这段话润色一下，让它读起来更正式一些')
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0].tool).toBe('llm_generate')
  })

  it('纯算术请求不被劫持', async () => {
    const p = await buildExplorePlan('帮我算一下 1234 × 5678 等于多少，把计算过程也写出来。')
    expect(p.steps[0].tool).toBe('llm_generate')
  })
})
