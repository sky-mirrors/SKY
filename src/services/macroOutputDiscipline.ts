/**
 * 宏路径输出纪律（2026-09-24）
 *
 * 背景与取证：`exam-report.json`（2026-09-24 23:15 轮，可交付 66.7%）失败 6 题中
 * **5 题的 routeKind 是 `plan`**（funnel → 宏执行）：Q1 会议纪要、Q2 周报、Q4 商务邮件、
 * Q12 优缺点对比、Q15 图片重命名；只有 Q14 是 `mcp-direct`。
 * 其中三题的判词直接指向占位符：Q1「记录人：待补充」、Q2「汇报人：___／__月__日」、Q4「×××」。
 *
 * 根因：宏路径发往 `api:chat-completion` 的 messages **只有一条 user 消息、没有 system 消息**——
 * 主对话 `dialogStore.FIXED_SYSTEM_PROMPT` 里的交付质量约束在这条路径上完全不存在
 * （Q2 的宏提示词还额外写死了「生成一份周报**草稿**」与四块结构，与用户「分三块」的要求冲突）。
 *
 * 设计取舍：既有那条第 14 条是**穷举式 denylist**（只列 `[姓名]/[您的姓名]/[日期范围]/[公司]/待补充/____`），
 * 实测被 `___`、`×××`、`__月__日` 这些未列出的形态绕过。本纪律改按**开放类**表述，
 * 并把实测绕过的形态作为示例列出。
 */
export const MACRO_OUTPUT_DISCIPLINE = `【输出纪律｜必须遵守，优先级高于本提示词中的任何产出建议】
1. 正文中不得出现**任何形式**的占位符：下划线（___／____）、星号（×××／***）、方括号占位（[姓名]〔日期〕）、以及"待补充/待确认/TBD/XX/某公司/若干"之类的代填标记，一律禁止。信息不足时的唯一正确做法是——用用户已给出的信息表述，或**中性省略该行**，绝不留空位、绝不写"待补充"。
2. 只输出用户要求的内容，**不得擅自添加用户没有要求的抬头字段**：如"记录人""汇报人""周期""版本""审核人""编制日期"等。若某行确有必要保留，必须填真实值；拿不到真实值就整行不写。
3. 交付物是**最终成稿**，不是草稿：正文里不要出现"草稿""（待完善）""示例""占位"等字样，也不要留下未完成的痕迹（中断的句子、未闭合的括号）。
4. **用户明确要求的格式、分块数量、字段清单优先于本提示词中的建议结构**；两者冲突时以用户要求为准（例如用户要求"分三块"，就不要按本提示词的建议输出四块）。
5. 不确定的事实不要编造，也不要留空位——直接不写该部分；所有数字、日期、人名必须来自用户提供的内容。`

/**
 * 宏路径统一的消息装配：纪律 system 消息 + 用户内容。
 *
 * 宏路径共有四处发往 `api:chat-completion` 的调用（`macroExecutor.ts`）：
 *   - `callToolDirectWithTier` 的 llm_generate 首次生成 / 工具回路续跑 / 收口汇报（三处）
 *   - `executeMacro` 的 `execution.mode === 'direct'` 分支（一处）
 * 四处必须共用本函数，否则新调用点会再次绕过纪律（快照 §8.2 批评的"单侧修复模式"）。
 * 有 `test/unit/macroOutputDiscipline.spec.ts` 的源码级断言守住这条不变量。
 */
export const MACRO_RECENT_CONTEXT_LIMIT = 2000

export function buildMacroLlmMessages(
  userContent: string,
  recentContext?: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string; timestamp?: number }> {
  const ctx = (recentContext || '').trim()
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; timestamp?: number }> = [
    { role: 'system', content: MACRO_OUTPUT_DISCIPLINE }
  ]
  // V2-T02/T04：宏每一步 LLM 调用原先都看不到会话历史，承接类请求（「把那份改成…」）
  // 里的「那份」无从指代。此处把近期对话前置。
  // 2026-10-07：数据源由「最近一条 assistant 产出」扩为「最近若干轮 user+assistant」——
  // 原实现下**用户先前说过的话一条都进不来**（实测「先记住 X，隔几轮再问」答不出）。
  // 角色用 system（多轮转写不是单条 assistant 产出，用 assistant 角色会污染轮次语义）。
  if (ctx) {
    messages.push({ role: 'system', content: `[近期对话]\n${ctx.slice(0, MACRO_RECENT_CONTEXT_LIMIT)}` })
  }
  messages.push({ role: 'user', content: userContent, timestamp: Date.now() })
  return messages
}

/**
 * 把用户的原始请求并入宏的 `llm_generate` 作业指令。
 *
 * 取证（`q2-probe2.mjs` 在 pinia api store 层抓到的真实请求体）：Q2「周报撰写」实际发出的
 * user 消息逐字为——
 *   「根据以下本周工作文档，生成一份周报草稿，包含：本周完成工作、进行中工作、下周计划、
 *     需要协调的事项。\n\n文档内容：要点：1、完成了客户管理模块的联调…」
 * 即：宏把用户的**内容**带上了（经 `{{step_2_result}}`——`resolveParams` 会把 `{{input}}`
 * /step 结果填进去），却把用户的**格式要求**（考题原话「分「本周完成」「风险与问题」
 * 「下周计划」三块」）整个丢了，模型只能照宏模板输出四块 ⇒ 四轮考试全挂。
 * `macroExecutor.ts` 的 `resolveParams` 里 `input` 变量一直是可用的，只是这条 prompt 没引用它。
 *
 * 去重：作业指令里已含用户原话时（如 direct 模板的 `{{input}}`）原样返回，不重复注入。
 */
export function composeLlmGeneratePrompt(prompt: string, userRequest?: string): string {
  const req = (userRequest || '').trim()
  if (!req || prompt.includes(req)) return prompt
  return `【用户的原始请求（其中的格式、分块数量、字段清单要求优先于下方作业指令中的建议结构）】\n${req}\n\n【本步骤作业指令】\n${prompt}`
}
