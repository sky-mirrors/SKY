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
import { pickTopFileFromListing } from '@/services/macroExecutor'
import { EXAM_CASES } from '@/exam/examCases'

const q14 = EXAM_CASES.find(c => c.id === 'Q14')!
const q16 = EXAM_CASES.find(c => c.id === 'Q16')!

describe('N2：探索计划的确定性文件步骤', () => {
  it('Q14（列桌面 .docx 清单）→ 单步确定性 list_directory + ext（不经模型综合）', async () => {
    const p = await buildExplorePlan(q14.prompt)
    // 2026-09-25（HANDOFF「下一步 1」做法②）：不再走 list→read→llm 三步——末步 3B 会把文件名
    // 首尾粘连（exam-report.json Q14 恒 not-deliverable）。改为**单步 list_directory + ext**：
    // 计划全为原生工具 ⇒ confirmPlan 的 isAllNative 快路径直接 presentExecutionOutput，不经模型。
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0].tool).toBe('list_directory')
    expect(String(p.steps[0].params.path).toLowerCase()).toContain('desktop')
    expect(p.steps[0].params.ext).toBe('docx')
    // 不得再有 read_file / llm_generate 步——那正是文件名粘连的模型综合路径
    expect(p.steps.some(s => s.tool === 'read_file')).toBe(false)
    expect(p.steps.some(s => s.tool === 'llm_generate')).toBe(false)
  })

  it('Q16（找报销单读金额）→ 仍是 list→read→llm 三步（列清单收口不得劫持读内容请求）', async () => {
    const p = await buildExplorePlan(q16.prompt)
    expect(p.steps[0].tool).toBe('list_directory')
    expect(p.steps.some(s => s.tool === 'read_file')).toBe(true)
    expect(p.steps.some(s => s.tool === 'llm_generate')).toBe(true)
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

  it('Q15（重命名任务）不被「列目录并回答」分支劫持', async () => {
    const q15 = EXAM_CASES.find(c => c.id === 'Q15')!
    const p = await buildExplorePlan(q15.prompt)
    expect(p.steps.some(s => s.tool === 'list_directory')).toBe(false)
  })

  it('含显式路径时采用该路径（Q15 曾把它猜成 %USERPROFILE%\\Desktop\\photos）', async () => {
    const p = await buildExplorePlan('把 C:\\Users\\Admin\\Desktop\\HoloExam\\photos 文件夹里的图片列个清单给我')
    expect(p.steps[0].tool).toBe('list_directory')
    expect(String(p.steps[0].params.path)).toBe('C:\\Users\\Admin\\Desktop\\HoloExam\\photos')
  })

  // 2026-09-24（第一波·文档能力）：A3 的"本机无渲染器 → 诚实说明"已被**真转换**取代——
  // 应用内 mammoth(docx→HTML) + Electron printToPDF(HTML→PDF) 落地后，PDF 目标产出真实的
  // file_convert 步骤。原不变量继续成立：不得出现「把内容转换为 pdf 格式」这类 LLM 假动作。
  it('PDF 目标 → 真实的 file_convert 步骤（含源/目标路径），不再有假转换', async () => {
    const p = await buildExplorePlan('把 C:\\x\\a.docx 转成 pdf')
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0].tool).toBe('file_convert')
    expect(String(p.steps[0].params.source)).toBe('C:\\x\\a.docx')
    expect(String(p.steps[0].params.target)).toBe('C:\\x\\a.pdf')
    expect(String(p.steps[0].params.prompt ?? '')).not.toContain('将以下内容转换为')
  })

  it('源格式不支持时仍走确定性「不支持」说明，绝不假装成功', async () => {
    const p = await buildExplorePlan('把 C:\\x\\a.xlsx 转成 pdf')
    expect(p.steps[0].tool).toBe('llm_generate')
    expect(String(p.steps[0].params.prompt)).not.toContain('将以下内容转换为')
    expect(String(p.steps[0].params.prompt)).toContain('只支持')
  })
})

describe('B1：从清单里挑目标文件（{{step_N_top_files}} 的解析内核）', () => {
  const listing = 'a.txt\n张三报销单.txt\n项目周报.docx'
  it('按用户输入关键词挑出最匹配的文件（Q16 场景）', () => {
    const picked = pickTopFileFromListing(listing, '帮我在桌面找一下张三的报销单（在 HoloExam 文件夹里），告诉我他的报销总金额是多少钱。')
    expect(picked).toBe('张三报销单.txt')
  })
  it('无关键词命中时退回清单首个（保证 read_file 的 path 非空）', () => {
    expect(pickTopFileFromListing(listing, '把这段文字润色一下')).toBe('a.txt')
  })
  it('空清单返回空串', () => {
    expect(pickTopFileFromListing('', '随便什么')).toBe('')
  })
})
