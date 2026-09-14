import { getLLM } from '@/kernel/plugins/llm'
import { ChatMessage, PromptChainResult, PromptChainStep, TaskPlan, TaskCase } from '@/models'
import type { L2ToolManifest } from '@/models'
import { cosineSimilarity, generatePseudoVector, VECTOR_DIM } from './embedder'
import { debugLog } from '@/services/debugLog'
import { vault } from '@/vault'

const SEED_CASES: TaskCase[] = [
  {
    id: 'seed-1',
    input: '帮我审查这份合同的风险条款',
    plan: {
      intent: '审查合同风险条款',
      needs: ['合同文本', '法律知识'],
      steps: [
        { step: 1, description: '检索知识库获取法律相关知识', tool: 'knowledge_search', depends_on: [], params: { query: '合同风险审查要点' }, expectedOutput: '合同风险审查要点' },
        { step: 2, description: '读取合同文件内容', tool: 'read_file', depends_on: [], params: {}, expectedOutput: '合同全文' },
        { step: 3, description: '分析风险条款并生成报告', tool: 'shell_exec', depends_on: [1, 2], params: {}, expectedOutput: 'docx报告文件' }
      ]
    },
    toolsUsed: ['knowledge_search', 'read_file', 'shell_exec'],
    success: true,
    vector: [],
    createdAt: 0
  },
  {
    id: 'seed-2',
    input: '生成本周工作周报',
    plan: {
      intent: '生成工作周报',
      needs: ['工作记录', '模板'],
      steps: [
        { step: 1, description: '读取工作记录文件', tool: 'read_file', depends_on: [], params: {}, expectedOutput: '工作记录内容' },
        { step: 2, description: '检索知识库获取周报模板', tool: 'knowledge_search', depends_on: [], params: { query: '周报模板' }, expectedOutput: '周报模板' },
        { step: 3, description: '生成docx周报', tool: 'shell_exec', depends_on: [1, 2], params: {}, expectedOutput: 'Word格式周报' }
      ]
    },
    toolsUsed: ['read_file', 'knowledge_search', 'shell_exec'],
    success: true,
    vector: [],
    createdAt: 0
  },
  {
    id: 'seed-3',
    input: '对比两份合同的差异',
    plan: {
      intent: '对比两份合同差异',
      needs: ['合同A内容', '合同B内容'],
      steps: [
        { step: 1, description: '读取第一份合同', tool: 'read_file', depends_on: [], params: {}, expectedOutput: '合同A全文' },
        { step: 2, description: '读取第二份合同', tool: 'read_file', depends_on: [], params: {}, expectedOutput: '合同B全文' },
        { step: 3, description: '检索知识库获取对比要点', tool: 'knowledge_search', depends_on: [], params: { query: '合同对比维度' }, expectedOutput: '合同对比维度' },
        { step: 4, description: '生成对比表格报告', tool: 'shell_exec', depends_on: [1, 2, 3], params: {}, expectedOutput: '对比报告docx' }
      ]
    },
    toolsUsed: ['read_file', 'knowledge_search', 'shell_exec'],
    success: true,
    vector: [],
    createdAt: 0
  }
]

const CASES_KEY = 'holo-task-cases'

function loadCases(): TaskCase[] {
  try {
    const saved = vault.readCache('task', CASES_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as TaskCase[]
      const normalized = parsed.map(c => {
        if (c.plan && c.plan.steps) {
          c.plan.steps = c.plan.steps.map((s: Record<string, unknown>, i: number) => {
            if (s.step === undefined) s.step = i + 1
            if (!s.depends_on) s.depends_on = []
            if (!s.params) s.params = {}
            return s as TaskPlan['steps'][0]
          })
        }
        return c
      })
      return [...SEED_CASES, ...normalized]
    }
  } catch { /* ignore */ }
  return SEED_CASES
}

export function searchTaskCases(input: string, topK: number = 3): TaskCase[] {
  const cases = loadCases()
  const inputVec = generatePseudoVector(input)
  const scored = cases.map(c => {
    const caseVec = c.vector.length > 0 ? c.vector : generatePseudoVector(c.input)
    const score = cosineSimilarity(inputVec, caseVec)
    return { case: c, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map(s => s.case)
}

export function saveTaskCase(taskCase: TaskCase): void {
  const saved: TaskCase[] = (() => {
    try {
      const raw = vault.readCache('task', CASES_KEY)
      return raw ? JSON.parse(raw) as TaskCase[] : []
    } catch { return [] }
  })()
  if (!taskCase.vector || taskCase.vector.length === 0) {
    taskCase.vector = generatePseudoVector(taskCase.input)
  }
  saved.push(taskCase)
  if (saved.length > 50) saved.splice(0, saved.length - 50)
  try { vault.writeThrough('task', CASES_KEY, JSON.stringify(saved)) } catch { /* ignore */ }
}

const DISAMBIG_CACHE = new Map<string, { choice: number; ts: number }>()
const DISAMBIG_CACHE_TTL = 3600000

export async function disambiguateChoice(
  userInput: string,
  candidates: { manifest: L2ToolManifest; score: number; method: string }[],
  recentContext: string = ''
): Promise<{ choiceIndex: number; manifest: L2ToolManifest } | null> {
  const cacheKey = `${userInput.substring(0, 80)}|${candidates.map(c => c.manifest.identity.id).join(',')}`
  const cached = DISAMBIG_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.ts < DISAMBIG_CACHE_TTL) {
    const idx = cached.choice - 1
    if (idx >= 0 && idx < candidates.length) {
      debugLog(`[Disambig] 缓存命中: 选择${cached.choice}`)
      return { choiceIndex: idx, manifest: candidates[idx].manifest }
    }
  }

  if (candidates.length === 0) return null
  if (candidates.length === 1) return { choiceIndex: 0, manifest: candidates[0].manifest }

  const candList = candidates.slice(0, 4).map((c, i) => `${i + 1}. ${c.manifest.identity.name}`).join('\n')
  const contextLine = recentContext ? `\n上下文：${recentContext.substring(0, 80)}` : ''

  const prompt = `用户指令：${userInput.substring(0, 100)}
候选技能：
${candList}${contextLine}
请只输出数字（1-${Math.min(candidates.length, 4)}），不要解释。`

  const llm = getLLM()
  try {
    const response = await llm.chatCompletion(
      [{ role: 'user', content: prompt }],
      { taskType: 'classify', callerId: 'promptTranslator_lang', maxTokens: 16 }
    )
    const text = (response.content || '').trim()
    const num = parseInt(text.replace(/[^0-9]/g, ''), 10)
    if (num >= 1 && num <= candidates.length) {
      DISAMBIG_CACHE.set(cacheKey, { choice: num, ts: Date.now() })
      debugLog(`[Disambig] 选择${num}: ${candidates[num - 1].manifest.identity.name}`)
      return { choiceIndex: num - 1, manifest: candidates[num - 1].manifest }
    }
  } catch (e) {
    debugLog(`[Disambig] 超时或失败，降级为用户选择: ${(e as Error).message}`)
  }
  return null
}

export async function translateIntent(
  userInput: string,
  manifest: L2ToolManifest,
  recentContext: string = ''
): Promise<{ intent: string; params: Record<string, string> } | null> {
  const skillDesc = manifest.identity.name
  const slots = manifest.execution.paramMapping?.slots || []
  const slotDesc = slots.length > 0
    ? `该技能需要参数：${slots.map(s => `${s.name}(${s.description}${s.required ? ',必填' : ''})`).join('、')}`
    : '该技能无需额外参数'

  const contextLine = recentContext ? `\n对话上下文：${recentContext.substring(0, 100)}` : ''

  const prompt = `用户说："${userInput.substring(0, 120)}"
系统匹配到技能："${skillDesc}"
${slotDesc}${contextLine}

请翻译为明确的意图和参数。只输出JSON：{"intent":"明确意图描述","params":{"参数名":"提取值"}}
若无参数则params为空对象。不要解释。`

  const llm = getLLM()
  try {
    const response = await llm.chatCompletion(
      [{ role: 'user', content: prompt }],
      { taskType: 'classify', callerId: 'promptTranslator_intent', maxTokens: 128 }
    )
    const text = (response.content || '').trim()
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (parsed.intent) {
      debugLog(`[TranslateIntent] 翻译: "${userInput.substring(0, 40)}" → ${parsed.intent}`)
      return { intent: String(parsed.intent), params: parsed.params || {} }
    }
  } catch (e) {
    debugLog(`[TranslateIntent] 失败: ${(e as Error).message}`)
  }
  return null
}

export async function planTask(userInput: string, mcpToolNames: string[] = [], recentUserMsg: string = ''): Promise<TaskPlan> {
  const llm = getLLM()
  const cases = searchTaskCases(userInput, 2)

  const caseLines = cases.map((c, i) =>
    `案例${i + 1}: "${c.input}" → ${c.plan.steps.map(s => `${s.tool}(step${s.step})`).join('→')} (${c.success ? '成功' : '失败'})`
  ).join('\n')

  const caseTemplates = cases.filter(c => c.success).map((c, i) =>
    `模板${i + 1}: ${JSON.stringify(c.plan.steps)}`
  ).join('\n')

  const toolList = mcpToolNames.length > 0
    ? mcpToolNames.map(n => `- ${n}`).join('\n')
    : `- knowledge_search: 检索知识库\n- read_file/file_write: 读写文件\n- list_directory: 浏览目录\n- shell_exec: 执行本地命令\n- http_request: 发送HTTP请求(GET/POST等)\n- create_docx: 生成Word文档`

  const contextLine = recentUserMsg && recentUserMsg !== userInput
    ? `\n最近对话上下文：${recentUserMsg.substring(0, 100)}`
    : ''

  const now = new Date()
  const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const timeStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} 周${dayOfWeek} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`

  const systemPrompt = `你是一个企业工作流规划专家。将用户请求翻译为DAG执行计划。

规划思维链（不要输出）：
1. 识别最终交付物（Word报告？邮件？Excel表？）
2. 倒推需要哪些数据输入
3. 确定工具调用顺序（若B依赖A的输出，则B.depends_on含A的step号）
4. 无依赖的步骤可并行执行

硬约束：
- 步骤不得超过5步
- 总Token预算8000
- 当前时间：${timeStr}（若需联系他人且非工作时间，改为生成待办事项）
- 涉及薪资/个人隐私数据时，中间步骤不得输出具体数值
- 每个步骤的params必须从上下文或历史中提取，不要捏造
- 若某步骤可能失败，设计fallback工具

只输出JSON。`

  const userPrompt = `可用工具：
${toolList}

历史成功案例：
${caseLines}

成功计划模板（请模仿结构，根据当前上下文微调参数）：
${caseTemplates}
${contextLine}

用户请求：${userInput}

输出严格JSON格式（DAG）：
{"intent":"意图","needs":["需求1"],"steps":[{"step":1,"description":"步骤描述","tool":"工具名","depends_on":[],"params":{},"expectedOutput":"期望输出","fallback":"备用工具"}]}

注意：step从1开始编号；depends_on是数组，填前置步骤的step号（无依赖填空数组[]）；params填该步骤需要的参数。`

  try {
    const response = await llm.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { taskType: 'classify', callerId: 'promptTranslator_dag', maxTokens: 768 })
    const rawContent = response.content || ''
    const cleaned = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (parsed.intent && parsed.steps && Array.isArray(parsed.steps)) {
      for (let i = 0; i < parsed.steps.length; i++) {
        const s = parsed.steps[i]
        if (s.step === undefined) s.step = i + 1
        if (!s.depends_on) s.depends_on = []
        if (!s.params) s.params = {}
      }
      return validateDAG(parsed as TaskPlan)
    }
  } catch { /* fallback */ }

  return {
    intent: userInput.substring(0, 50),
    needs: ['直接处理'],
    steps: [
      { step: 1, description: '根据用户请求选择合适的工具执行任务', tool: 'auto', depends_on: [], params: {}, expectedOutput: '任务结果' }
    ]
  }
}

function validateDAG(plan: TaskPlan): TaskPlan {
  const stepMap = new Map(plan.steps.map(s => [s.step, s]))

  function findCycleEdge(): [number, number] | null {
    const visited = new Set<number>()
    const path = new Set<number>()
    const stack: number[] = []

    function dfs(stepNum: number): [number, number] | null {
      if (path.has(stepNum)) {
        const cycleIdx = stack.indexOf(stepNum)
        if (cycleIdx >= 0 && cycleIdx < stack.length - 1) {
          return [stack[cycleIdx], stack[cycleIdx + 1]]
        }
        return null
      }
      if (visited.has(stepNum)) return null
      visited.add(stepNum)
      path.add(stepNum)
      stack.push(stepNum)
      const step = stepMap.get(stepNum)
      if (step) {
        for (const dep of step.depends_on) {
          const edge = dfs(dep)
          if (edge) return edge
        }
      }
      path.delete(stepNum)
      stack.pop()
      return null
    }

    for (const s of plan.steps) {
      const edge = dfs(s.step)
      if (edge) return edge
    }
    return null
  }

  // Iteratively remove cycle edges instead of stripping all dependencies
  let maxIterations = plan.steps.length * 2
  while (maxIterations-- > 0) {
    const cycleEdge = findCycleEdge()
    if (!cycleEdge) break
    const [from, to] = cycleEdge
    const step = stepMap.get(to)
    if (step) {
      step.depends_on = step.depends_on.filter(d => d !== from)
    }
  }

  return plan
}

export async function replan(
  failedStep: number,
  errorMsg: string,
  remainingSteps: TaskPlan['steps'],
  completedResults: Record<number, string>
): Promise<TaskPlan['steps']> {
  const llm = getLLM()

  const completedInfo = Object.entries(completedResults)
    .map(([step, result]) => `步骤${step}已完成，结果摘要：${result.substring(0, 200)}`)
    .join('\n')

  const remainingInfo = remainingSteps.map(s =>
    `step${s.step}: ${s.description}, tool=${s.tool}, depends_on=${JSON.stringify(s.depends_on)}`
  ).join('\n')

  const prompt = `执行步骤${failedStep}失败，原因：${errorMsg}。

已完成的步骤：
${completedInfo}

剩余计划：
${remainingInfo}

请修改剩余步骤（可替换工具、调整参数或依赖关系），使其绕开错误。只输出修改后的剩余步骤JSON数组，格式同上。不要重复已完成步骤。`

  try {
    const response = await llm.chatCompletion([
      { role: 'system', content: '你是重规划器。只修改失败步骤之后的剩余计划，不全量重来。只输出JSON。' },
      { role: 'user', content: prompt }
    ], { taskType: 'classify', callerId: 'promptTranslator_replan', maxTokens: 512 })
    const rawContent = response.content || ''
    const cleaned = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      for (const s of parsed) {
        if (!s.depends_on) s.depends_on = []
        if (!s.params) s.params = {}
      }
      return validateDAG({ intent: '', needs: [], steps: parsed } as TaskPlan).steps
    }
  } catch { /* fallback: return original remaining */ }

  return remainingSteps
}

export function reflectOnResult(
  plan: TaskPlan,
  executedTools: string[],
  hasErrors: boolean
): { satisfied: boolean; missingSteps: number[]; suggestion: string } {
  const missingSteps: number[] = []
  for (let i = 0; i < plan.steps.length; i++) {
    const plannedTool = plan.steps[i].tool
    const found = executedTools.some(et =>
      et === plannedTool || et.includes(plannedTool) || plannedTool.includes(et)
    )
    if (!found) missingSteps.push(i)
  }

  if (hasErrors) {
    return { satisfied: false, missingSteps, suggestion: '部分工具调用失败，需要重试或替代方案' }
  }

  if (missingSteps.length > 0) {
    const desc = missingSteps.map(i => plan.steps[i].description).join('、')
    return { satisfied: false, missingSteps, suggestion: `跳过了步骤：${desc}` }
  }

  return { satisfied: true, missingSteps: [], suggestion: '' }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          params: { type: 'object' },
          expectedOutput: { type: 'string' }
        },
        required: ['tool', 'params', 'expectedOutput']
      }
    }
  },
  required: ['steps']
}

export async function compileToChain(userInput: string, context?: string): Promise<PromptChainResult> {
  const llm = getLLM()

  const systemPrompt = `你是一个企业办公提示词编译器。用户输入大白话描述任务需求，你需要将其编译为结构化的工具调用步骤。

可用工具：
- l1-knowledge-feeder: 检索知识库文档，params: {query}
- l1-task-translator: 将自然语言翻译为结构化Prompt，params: {input}
- l1-model-gateway: 调用AI模型生成内容，params: {prompt}
- l1-workspace-memory: 获取项目上下文/历史记录，params: {projectId, limit}
- l1-result-beautifier: 格式化输出为文档，params: {format}
- l1-pipeline-builder: 编排多步骤流程，params: {steps}

输出必须严格遵循以下JSON Schema：
${JSON.stringify(OUTPUT_SCHEMA)}

只输出JSON，不要其他文字。`

  const userPrompt = context
    ? `上下文：${context}\n\n用户需求：${userInput}`
    : `用户需求：${userInput}`

  const response = await llm.chatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], { stream: true, taskType: 'chat', callerId: 'promptTranslator_chat' })

  const rawContent = response.content || ''

  try {
    const parsed = JSON.parse(rawContent)
    if (parsed.steps && Array.isArray(parsed.steps)) {
      return {
        steps: parsed.steps as PromptChainStep[],
        raw: rawContent
      }
    }
    return { steps: [{ tool: 'l1-model-gateway', params: { prompt: userInput }, expectedOutput: 'AI回复' }], raw: rawContent }
  } catch {
    return { steps: [{ tool: 'l1-model-gateway', params: { prompt: userInput }, expectedOutput: 'AI回复' }], raw: rawContent }
  }
}
