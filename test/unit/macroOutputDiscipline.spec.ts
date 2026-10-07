import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MACRO_OUTPUT_DISCIPLINE, buildMacroLlmMessages, composeLlmGeneratePrompt } from '@/services/macroOutputDiscipline'

/**
 * 宏路径输出纪律（2026-09-24 第三批之二）
 *
 * 取证（`exam-report.json`，startedAt 2026-09-24T23:15:39+08:00，可交付 66.7%）：
 *   失败 6 题里 **5 题的 routeKind 是 `plan`**（funnel 走宏执行）：
 *     Q1 会议纪要 → l2-meeting-minutes-gen-v1（routing.keywords 命中「会议/纪要/记录/会议记录」）
 *     Q2 周报     → l2-weekly-report-draft-v1（keywords 命中「周报/本周」）
 *     Q4 商务邮件 → l2-client-email-compose-v1（mode:direct）
 *     Q12/Q15 亦同。只有 Q14 是 mcp-direct。
 *   判词三题指向占位符：Q1「记录人：待补充」、Q2「汇报人：___／__月__日」、Q4「×××」。
 *
 * 根因：宏路径（`callToolDirectWithTier` 的 llm_generate 与 `executeMacro` 的 direct 分支）
 * 发往 `api:chat-completion` 的 messages **只有一条 user 消息，没有 system 消息**——
 * 主对话 `dialogStore.FIXED_SYSTEM_PROMPT` 的第 14 条「不留占位符」在此路径上根本不存在。
 * 且既有那条第 14 条本身是**穷举式 denylist**（只列 [姓名]/[您的姓名]/[日期范围]/[公司]/待补充/____），
 * 实测被 `___`、`×××`、`__月__日` 这些未列出的形态绕过——本纪律改按**开放类**表述。
 */

describe('宏路径输出纪律：常量内容', () => {
  it('按开放类禁止占位符，并覆盖实测绕过的三种形态', () => {
    // 开放类表述（不是穷举清单）
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('任何形式')
    // 实测绕过既有 denylist 的三种形态必须出现在示例里
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('___')
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('×××')
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('待补充')
  })

  it('禁止臆造用户未要求的抬头字段（Q1 记录人 / Q2 汇报人·周期）', () => {
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('记录人')
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('汇报人')
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('周期')
  })

  it('声明「用户明确要求优先于模板建议结构」（Q2 三块 vs 宏模板四块）', () => {
    expect(MACRO_OUTPUT_DISCIPLINE).toMatch(/用户.*优先/)
  })

  it('要求成稿而非草稿（Q2 开头写了「本周周报（草稿）」）', () => {
    expect(MACRO_OUTPUT_DISCIPLINE).toContain('草稿')
  })
})

describe('宏路径输出纪律：消息装配', () => {
  it('buildMacroLlmMessages 把纪律作为 system 消息前置', () => {
    const msgs = buildMacroLlmMessages('用户内容')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(MACRO_OUTPUT_DISCIPLINE)
    expect(msgs[1].role).toBe('user')
    expect(msgs[1].content).toBe('用户内容')
  })

  it('用户内容不做任何改写（原样透传）', () => {
    const raw = '你是会议纪要专家。包含：会议主题、参会人员。\n\n会议记录：{{step_1_result}}'
    expect(buildMacroLlmMessages(raw)[1].content).toBe(raw)
  })
})

describe('宏路径输出纪律：全路径走查（防单侧修复）', () => {
  const src = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')

  it('macroExecutor 中四处 api:chat-completion 调用全部经 buildMacroLlmMessages', () => {
    // 四处 = llm_generate 首次生成 / 工具回路续跑 / 收口汇报 + executeMacro 的 direct 分支
    const uses = src.match(/buildMacroLlmMessages\(/g) || []
    expect(uses.length).toBe(4)
  })

  it('不再残留裸 user 消息装配（否则新调用点又会绕过纪律）', () => {
    expect(src).not.toMatch(/messages:\s*\[\{\s*role:\s*'user'/)
  })
})

/**
 * 宏提示词压过用户原话（Q2 四轮全挂的根因）
 *
 * 取证（`q2-probe2.mjs` 在 pinia api store 层抓的真实请求体，2026-09-24）：
 *   [user] 根据以下本周工作文档，生成一份周报草稿，包含：本周完成工作、进行中工作、下周计划、需要协调的事项。
 *          \n\n文档内容：要点：1、完成了客户管理模块的联调…5、下周计划：做完导出功能…
 * ——宏把用户的**内容**带上了（经 {{step_2_result}}），却把用户的**格式要求**（考题原话「分「本周完成」
 * 「风险与问题」「下周计划」三块」）整个丢了，模型只能照宏模板输出四块。
 * `resolveParams`（macroExecutor.ts:752-756）里 `input` 一直是可用的，只是这条 prompt 没引用它。
 */
describe('宏提示词并入用户原始请求', () => {
  const REQ = '帮我写一份周报，分「本周完成」「风险与问题」「下周计划」三块。\n要点：1、xxx'
  const JOB = '根据以下本周工作文档，生成一份周报草稿，包含：本周完成工作、进行中工作、下周计划、需要协调的事项。\n\n文档内容：要点：1、xxx'

  it('用户请求不在作业指令里时，前置并入并声明优先级', () => {
    const out = composeLlmGeneratePrompt(JOB, REQ)
    expect(out).toContain(REQ)
    expect(out).toContain(JOB)
    expect(out.indexOf(REQ)).toBeLessThan(out.indexOf(JOB))
    expect(out).toMatch(/优先/)
  })

  it('作业指令已含用户原话时不重复注入（direct 模板的 {{input}} 已带）', () => {
    const withInput = `请根据以下要点撰写一封专业的商务邮件。\n\n要点：${REQ}`
    expect(composeLlmGeneratePrompt(withInput, REQ)).toBe(withInput)
  })

  it('无用户请求（未提供/空白）时原样返回', () => {
    expect(composeLlmGeneratePrompt(JOB, '')).toBe(JOB)
    expect(composeLlmGeneratePrompt(JOB, undefined)).toBe(JOB)
    expect(composeLlmGeneratePrompt(JOB, '   ')).toBe(JOB)
  })

  it('作业指令逐字保留在尾部，不被改写', () => {
    const out = composeLlmGeneratePrompt(JOB, REQ)
    expect(out.endsWith(JOB)).toBe(true)
  })
})


describe('宏路径承接上下文（V2-T02/T04 第二轮根因：宏看不到会话历史）', () => {
  it('提供最近上下文时，作为 [近期对话] system 块插入到纪律与用户内容之间', () => {
    const msgs = buildMacroLlmMessages('把那份改成下午三点', '用户：写个通知\n助手：会议通知\n各位同事：…')
    expect(msgs).toHaveLength(3)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toBe(MACRO_OUTPUT_DISCIPLINE)
    // 2026-10-07：数据源由「最近一条 assistant 产出」扩为「最近若干轮 user+assistant」——
    // 角色随之改为 system（多轮转写不是单条 assistant 产出，用 assistant 角色会污染轮次语义）
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].content).toBe('[近期对话]\n用户：写个通知\n助手：会议通知\n各位同事：…')
    expect(msgs[2].role).toBe('user')
    expect(msgs[2].content).toBe('把那份改成下午三点')
  })

  it('无上下文（undefined / 空串 / 纯空白）时与旧行为逐字一致（零回归）', () => {
    const base = buildMacroLlmMessages('用户内容')
    for (const ctx of [undefined, '', '   ']) {
      const msgs = buildMacroLlmMessages('用户内容', ctx)
      expect(msgs).toHaveLength(2)
      expect(msgs.map(m => m.role)).toEqual(base.map(m => m.role))
      expect(msgs[0].content).toBe(MACRO_OUTPUT_DISCIPLINE)
      expect(msgs[1].content).toBe('用户内容')
    }
  })

  it('上下文超长时截断到 2000 字（前缀不计入截断）', () => {
    const long = 'A'.repeat(5000)
    const msgs = buildMacroLlmMessages('x', long)
    expect(msgs[1].content.length).toBe('[近期对话]\n'.length + 2000)
  })

  it('上下文原样透传，且不改写用户内容（作业指令仍逐字保留）', () => {
    const raw = '你是会议纪要专家。\n\n会议记录：{{step_1_result}}'
    const msgs = buildMacroLlmMessages(raw, '上一轮产出')
    expect(msgs[1].content).toBe('[近期对话]\n上一轮产出')
    expect(msgs[2].content).toBe(raw)
  })
})

describe('宏路径承接上下文：全路径走查（防单侧修复）', () => {
  const src = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')

  it('四处调用点全部透传最近上下文与知识库上下文（防单侧修复）', () => {
    // 2026-10-07：契约升级——除最近对话上下文外，还必须透传会话级知识检索结果
    //（否则「把会话合并进项目空间后对话查不到」在宏路径上依旧存在）。
    const full = src.match(/buildMacroLlmMessages\([A-Za-z_][A-Za-z0-9_]*,\s*recentDialogContext\(\),\s*await kbContextFor\([A-Za-z_.]+\)\)/g) || []
    expect(full.length).toBe(4)
  })

  it('kb 上下文的 bus 通道有注册点，且数据源已暴露', () => {
    const handlers = readFileSync(join(process.cwd(), 'src/domains/dialog/handlers.ts'), 'utf-8')
    expect(handlers).toContain('dialog:get-kb-context')
    const store = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(store).toContain('buildKbContext')
  })

  it('提供最近上下文的 bus 通道有注册点', () => {
    const handlers = readFileSync(join(process.cwd(), 'src/domains/dialog/handlers.ts'), 'utf-8')
    expect(handlers).toContain('dialog:get-recent-context')
  })

  it('dialogStore 暴露 getRecentAssistantOutput 数据源', () => {
    const store = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(store).toContain('getRecentAssistantOutput')
  })
})
