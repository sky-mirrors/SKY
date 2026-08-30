import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DialogMessage, ThoughtStep, TaskPlan, TaskCase, WorkflowCard, ToolCallLog } from '@/models'
import type { DecisionContext } from '@/models'
import { useApiStore } from './apiStore'
import { useNodeStore } from './nodeStore'
import { useMemoryStore } from './memoryStore'
import { useMcpStore } from './mcpStore'
import { useDebugStore } from './debugStore'
import { searchKnowledge, SearchScope } from '@/services/knowledgeBase'
import { planTask, reflectOnResult, saveTaskCase, replan, disambiguateChoice, translateIntent } from '@/services/promptTranslator'
import { executeMacro, resolveDirectPrompt, formatLineage, computeLineageSavings } from '@/services/macroExecutor'
import type { MacroLineage } from '@/services/macroExecutor'
import { beautify } from '@/services/resultBeautifier'
import { contentHash, truncateForLog } from '@/services/scheduleOptimizer'
import { logManifestUsage } from '@/services/proactiveScheduler'
import {
  indexConversationRound,
  searchConversationContext,
  getLatestSummary,
  getAllSummaries,
  savePeriodSummary,
  shouldCompress,
  detectChallenge
} from '@/services/convMemory'
import { buildToolIndex, retrieveTopTools, makeSummaryToolList, universalMatch, getTop3Candidates, llmFallback, rewriteQuery, getTop3CandidatesUniversal, extractCoreKeywords } from '@/services/toolRetrieval'
import type { RaapMatchResult, UniversalMatchResult, MatchableItem } from '@/services/toolRetrieval'
import { selectArm as mabSelectArm } from '@/services/mabOptimizer'
import { tryL0Skill, buildExplorePlan, classifyDomain, tryL05QuickMatch, checkL1Capability } from '@/services/l0SkillRouter'
import type { L0DirectPlan } from '@/services/l0SkillRouter'

function planContainsShellExec(plan: TaskPlan): boolean {
  return plan.steps.some(s => s.tool === 'shell_exec')
}

function classifyError(err: string): string {
  const e = err.toLowerCase()
  if (e.includes('econnrefused') || e.includes('enotfound') || e.includes('network') || e.includes('fetchfailed') || e.includes('etimedout')) return '网络错误'
  if (e.includes('timeout') || e.includes('timed out') || e.includes('超时')) return '超时'
  if (e.includes('typeerror') || e.includes('referenceerror') || e.includes('syntaxerror')) return '内部错误'
  if (e.includes('exit code')) return `退出码${err.match(/exit code (\d+)/)?.[1] ?? '?'}`
  if (e.includes('permission') || e.includes('eacces') || e.includes('forbidden')) return '权限不足'
  if (e.includes('enoent') || e.includes('not found') || e.includes('找不到')) return '资源不存在'
  return '执行异常'
}

function userRequestedFile(input: string): boolean {
  return /发送(文件|文档)|发(文件|文档)|word|docx|导出(文件|文档)|保存(为|到)(文件|文档)|写成文件|输出文件/.test(input)
}

import { useSessionStore } from './sessionStore'
import { debugLog } from '@/services/debugLog'

function loadSummaries(): { period: string; summary: string; from: number; to: number }[] {
  try {
    const raw = localStorage.getItem('holo-conv-summaries')
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

const FIXED_SYSTEM_PROMPT = `你是 HoloStarmap 全息星图助手，一个拥有真实工具能力的 AI。

【核心规则 - 必须严格遵守】
1. 你拥有通过 function calling 调用 MCP 工具和 shell_exec 工具的能力。当用户请求需要实际操作时，你【必须】调用对应工具执行，绝不许编造结果。
2. 严禁在没有实际调用工具的情况下声称"已完成"某个操作。如果工具调用失败，如实报告失败原因。
3. 禁止不思考就调用工具。每次调用前必须有明确的理由。
4. 如果用户提供了附件（文件内容已包含在消息中的"=== 文件: xxx ==="标记内），【直接阅读消息中的内容即可】，【不要】再去用 file_read 工具从磁盘读取文件。附件内容已经在你的上下文中了。
5. 工具调用失败时，尝试替代方案，不要直接放弃。
6. 每步思考不超过2句话，简洁明了。
7. 最终回复必须基于工具返回的真实数据，不得编造。
8. 当可用工具不足以完成任务时，诚实告知用户缺少哪些工具或权限，不要编造替代方案的结果。
9. 生成 .docx 文件的【完整步骤】：
   第一步：先用 shell_exec 执行 "npm install docx"（工作目录 %USERPROFILE%），安装docx库。
   第二步：再用 shell_exec 执行 node -e "脚本内容"，脚本中使用 require("docx") 的 Document/Packer/Paragraph/TextRun/HeadingLevel 创建文档，用 Packer.toBuffer 生成 Buffer，用 fs.writeFileSync 写入桌面路径（process.env.USERPROFILE + "\\Desktop\\文件名.docx"）。
   【注意】不要用 fs.writeFile 把纯文本写到 .docx 后缀的文件，那只是改名后的 .md 文件，不是真正的 docx。必须用 docx 库生成真正的 docx 格式。
10. 所有需要输出的文件，默认保存到用户桌面（%USERPROFILE%\\Desktop\\）。
11. 【回复格式】使用纯文本和Markdown格式回复，禁止输出HTML标签、<div>、<span>、style属性等HTML代码。用户看到的是渲染后的界面，不需要HTML。
12. 【完整回复】每次回复必须完整，禁止说"需要更多权限"或"继续执行"之类的话。如果需要权限或遇到问题，直接说明问题，不要要求用户操作。如果回复可能很长，优先保证内容完整，宁可简洁也不要截断。
13. 【执行完整性】调用工具后必须检查返回结果，确认操作真正成功。如果shell_exec返回错误，必须报告错误而非假装成功。`

function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(v => stableStringify(v)).join(',') + ']'
  const rec = obj as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}'
}

export const useDialogStore = defineStore('dialog', () => {
  const messages = ref<DialogMessage[]>([])
  const mode = ref<'command' | 'plan' | 'teach'>('command')
  const isProcessing = ref(false)
  const currentEngine = ref('')
  const pendingPlan = ref<TaskPlan | null>(null)
  const pendingContent = ref('')
  const awaitingConfirmation = ref(false)
  const pendingMacroManifestId = ref<string | null>(null)

  const lastDecisionContext = ref<DecisionContext | null>(null)

  const transientHint = ref('')
  let _hintTimer: ReturnType<typeof setTimeout> | null = null

  function showTransientHint(text: string, durationMs: number = 2500) {
    transientHint.value = text
    if (_hintTimer) clearTimeout(_hintTimer)
    _hintTimer = setTimeout(() => { transientHint.value = '' }, durationMs)
  }

  const translatedIntent = ref<{ intent: string; manifestId: string; params: Record<string, string>; originalInput: string } | null>(null)
  const awaitingIntentConfirm = ref(false)

  const slotClarification = ref<{ manifestId: string; manifestName: string; slots: { name: string; description: string; required: boolean; value: string }[] } | null>(null)
  const awaitingSlotFill = ref(false)

  const pendingCandidateList = ref<{ manifestId: string; manifestName: string; score: number }[]>([])
  const awaitingCandidatePick = ref(false)

  const factConflict = ref<{ conflicts: { type: string; sourceRaw: string; outputRaw: string; diff: string; severity: string }[]; pendingStepNum: number; pendingManifestId: string } | null>(null)
  const awaitingFactResolution = ref(false)

  const riskAction = ref<import('@/models').ActionManifest | null>(null)
  const awaitingRiskConfirm = ref(false)
  let _riskResolve: ((approved: boolean) => void) | null = null

  const dagPaused = ref(false)
  const dagPausedStep = ref<number | null>(null)
  const dagPausedManifestId = ref<string | null>(null)
  const awaitingTakeover = ref(false)
  const takeoverStepNum = ref<number | null>(null)
  let _takeoverResolve: ((result: string) => void) | null = null

  function clearAllPausePoints(): void {
    awaitingConfirmation.value = false
    awaitingIntentConfirm.value = false
    awaitingSlotFill.value = false
    awaitingFactResolution.value = false
    awaitingRiskConfirm.value = false
    awaitingCandidatePick.value = false
    dagPaused.value = false
    awaitingTakeover.value = false
  }

  function acquirePausePoint(point: 'confirmation' | 'intentConfirm' | 'slotFill' | 'factResolution' | 'riskConfirm' | 'dagPaused' | 'takeover'): void {
    clearAllPausePoints()
    switch (point) {
      case 'confirmation': awaitingConfirmation.value = true; break
      case 'intentConfirm': awaitingIntentConfirm.value = true; break
      case 'slotFill': awaitingSlotFill.value = true; break
      case 'factResolution': awaitingFactResolution.value = true; break
      case 'riskConfirm': awaitingRiskConfirm.value = true; break
      case 'dagPaused': dagPaused.value = true; break
      case 'takeover': awaitingTakeover.value = true; break
    }
  }

  function setMode(m: 'command' | 'plan' | 'teach') {
    mode.value = m
    saveToStorage()
  }

  function addSystemNotice(content: string) {
    const msg: DialogMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      type: 'system_notice',
      content,
      timestamp: Date.now()
    }
    messages.value.push(msg)
    saveToStorage()
  }

  function updateMessageContent(messageId: string, newContent: string) {
    const msg = messages.value.find(m => m.id === messageId)
    if (msg) {
      msg.content = newContent
      saveToStorage()
    }
  }

  function addUserMessage(content: string) {
    const displayContent = content.length > 500
      ? content.substring(0, 200) + '\n... (含附件内容，已省略显示) ...\n' + content.substring(content.length - 100)
      : content
    const msg: DialogMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      type: 'text',
      content: displayContent,
      timestamp: Date.now()
    }
    messages.value.push(msg)

    const memoryStore = useMemoryStore()
    memoryStore.addDialogMessage({
      role: 'user',
      type: 'text',
      content
    })
    saveToStorage()
  }

  function addAssistantMessage(content: string, card?: WorkflowCard, log?: ToolCallLog, thoughtChain?: ThoughtStep[], taskPlan?: TaskPlan, lineage?: MacroLineage) {
    const msg: DialogMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      type: card ? 'workflow_card' : log ? 'tool_log' : 'text',
      content,
      workflowCard: card,
      toolLog: log,
      thoughtChain,
      taskPlan,
      lineage,
      timestamp: Date.now(),
      isTyping: false
    }
    messages.value.push(msg)

    if (!card && !log && content.length >= 2000) {
      autoGenerateDocxAttachment(msg, content)
    }

    const memoryStore = useMemoryStore()
    memoryStore.addDialogMessage({
      role: 'assistant',
      type: card ? 'workflow_card' : log ? 'tool_log' : 'text',
      content,
      workflowCard: card,
      toolLog: log
    })
    saveToStorage()
  }

  async function autoGenerateDocxAttachment(msg: DialogMessage, content: string) {
    try {
      const home = await window.electronAPI?.resolvePath('%USERPROFILE%') || 'C:\\Users\\Default'
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const fileName = `holo-result-${ts}.docx`
      const filePath = `${home}\\Desktop\\${fileName}`
      const result = await window.electronAPI?.createDocx({ filePath, content, title: '工具执行结果' })
      if (result?.success) {
        msg.content = content.substring(0, 500) + '...\n\n📄 完整结果已导出到桌面'
        msg.fileAttachment = { fileName, filePath, fileType: 'docx', label: '点击打开文档' }
        saveToStorage()
      } else {
        msg.content = content + '\n\n⚠️ 文件导出失败，完整内容如上'
        saveToStorage()
        const debugStore = useDebugStore()
        debugStore.emitEvent('warn', 'tool', '自动docx生成失败', result?.error || '未知错误')
      }
    } catch (e: unknown) {
      msg.content = content + '\n\n⚠️ 文件导出失败，完整内容如上'
      saveToStorage()
      const debugStore = useDebugStore()
      debugStore.emitEvent('warn', 'tool', '自动docx生成失败', e instanceof Error ? e.message : String(e))
    }
  }

  function addThoughtMessage(thoughtChain: ThoughtStep[], taskPlan?: TaskPlan) {
    const msg: DialogMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      type: 'text',
      content: '',
      thoughtChain,
      taskPlan,
      timestamp: Date.now()
    }
    messages.value.push(msg)
    saveToStorage()
  }

  function addToolLogMessage(log: ToolCallLog) {
    const msg: DialogMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'assistant',
      type: 'tool_log',
      content: `工具调用: ${log.toolName}`,
      toolLog: log,
      timestamp: Date.now()
    }
    messages.value.push(msg)
    saveToStorage()
  }

  function buildModeInstruction(): string {
    return mode.value === 'command'
      ? '指令模式：直接执行用户命令，调用工具完成任务。'
      : mode.value === 'plan'
        ? '规划模式：先制定计划，列出步骤和所需工具，等用户确认后执行。'
        : '教学模式：解释每个步骤的原理，引导用户理解工具如何协作。'
  }

  async function buildVariableContext(userContent: string): Promise<string> {
    const nodeStore = useNodeStore()
    const apiStore = useApiStore()
    const mcpStore = useMcpStore()

    const selectedNode = nodeStore.selectedNode
    const selectedInfo = selectedNode
      ? `当前选中节点：${selectedNode.name}(${selectedNode.level})，可用 MCP 工具：${mcpStore.mcpToolsAsNodes.length} 个`
      : '未选中任何节点'

    currentEngine.value = apiStore.config.activeModel || '未配置'

    const nodeStore2 = useNodeStore()
    nodeStore2.setL1Status('l1-knowledge-feeder', 'working')
    const sessionStore3 = useSessionStore()
    const scope: SearchScope | undefined = sessionStore3.activeSession?.knowledgeGroupId
      ? { groupIds: [sessionStore3.activeSession.knowledgeGroupId] }
      : undefined
    const kbResults = await searchKnowledge(userContent, 5, scope)
    nodeStore2.setL1Status('l1-knowledge-feeder', kbResults.length > 0 ? 'success' : 'idle')
    let kbContext = ''
    if (kbResults.length > 0) {
      kbContext = '\n\n【知识库检索结果 - 以下是与用户问题相关的已投喂文档片段】\n' + kbResults.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')
    }

    const mcpTools = mcpStore.mcpToolsAsNodes.map(t => ({ name: t.name, description: t.description }))

    let toolListStr = ''
    if (mcpTools.length > 0) {
      try {
        const toolIdx = await buildToolIndex(mcpTools)
        const topTools = await retrieveTopTools(userContent, toolIdx, 10)
        toolListStr = `【候选工具（已根据意图检索，共${topTools.length}个）】\n${makeSummaryToolList(topTools)}\n\n请从中选择1-3个最合适的工具调用。`
      } catch {
        addSystemNotice('⚠️ 智能工具检索失败，使用默认列表')
        toolListStr = `【可用工具列表】\n${mcpTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}\n\n请根据用户需求选择合适的工具调用。`
      }
    }

    return `${buildModeInstruction()}

当前状态：
- ${selectedInfo}
- 当前引擎：${apiStore.config.activeModel || '未配置'} (${apiStore.isReady ? '已连接' : '离线'})
- 已连接 MCP：${mcpStore.connections.filter(c => c.isConnected).length} 个
- 知识库：${kbResults.length} 条相关上下文已自动检索
${kbContext}

${mcpTools.length > 0 ? toolListStr : '【警告】当前没有可用的 MCP 工具，只能进行文本对话。'}`
  }

  type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    tool_call_id?: string
  }

  type ToolDef = { name: string; description: string; parameters: Record<string, unknown> }

  function buildMcpTools(mcpStore: ReturnType<typeof useMcpStore>): ToolDef[] {
    const tools: ToolDef[] = []
    for (const conn of mcpStore.connections) {
      if (!conn.isConnected) continue
      for (const tool of conn.tools) {
        const safeId = conn.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        const safeName = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        const fullName = `${safeId}___${safeName}`
        const schema = (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} }
        tools.push({
          name: fullName,
          description: `[${conn.name}] ${tool.description}`.substring(0, 200),
          parameters: schema
        })
      }
    }
    tools.push({
      name: 'shell_exec',
      description: '在本机执行shell命令（如node脚本、npm install等），用于生成文件等需要本地执行环境的操作。命令在Windows cmd中运行。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的shell命令' },
          cwd: { type: 'string', description: '工作目录（可选，默认用户主目录）' },
          timeout: { type: 'number', description: '超时毫秒数（可选，默认60000）' }
        },
        required: ['command']
      }
    })
    tools.sort((a, b) => a.name.localeCompare(b.name))
    return tools
  }

  function filterToolsByPlan(allTools: ToolDef[], plan: TaskPlan): ToolDef[] {
    const plannedTools = plan.steps.map(s => s.tool.toLowerCase())
    if (plannedTools.includes('auto')) return allTools
    const filtered = allTools.filter(t => {
      const nameLower = t.name.toLowerCase()
      const bareName = nameLower.replace(/.*___/, '')
      return plannedTools.some(pt => {
        return nameLower.includes(pt) || bareName.includes(pt) || pt.includes(bareName)
          || fuzzyToolMatch(pt, bareName)
      })
    })
    const result = filtered.length > 0 ? filtered : allTools
    const hasShellExec = result.some(t => t.name === 'shell_exec')
    if (!hasShellExec) {
      const shellTool = allTools.find(t => t.name === 'shell_exec')
      if (shellTool) result.push(shellTool)
    }
    result.sort((a, b) => a.name.localeCompare(b.name))
    debugLog(`[filterToolsByPlan] planned=${JSON.stringify(plannedTools)}, filtered=${result.map(t => t.name).join(',')}`)
    return result
  }

  function fuzzyToolMatch(planned: string, actual: string): boolean {
    const pairs: [string, string][] = [
      ['file_read', 'read_file'], ['read_file', 'read_file'],
      ['file_write', 'write_file'], ['write_file', 'write_file'],
      ['directory_tree', 'list_directory'], ['list_directory', 'list_directory'],
      ['search_directory', 'search_files'], ['search_files', 'search_files'],
      ['shell_exec', 'shell_exec'], ['shell', 'shell_exec'],
      ['knowledge_search', 'knowledge'], ['search', 'search'],
      ['get_file_info', 'get_file_info'], ['create_directory', 'create_directory'],
      ['create_docx', 'create_docx'], ['file_write', 'file_write'],
      ['move_file', 'move_file']
    ]
    return pairs.some(([a, b]) => planned.includes(a) && actual.includes(b))
  }

  function getTruncateLen(expectedOutput: string): number {
    if (expectedOutput.includes('全文') || expectedOutput.includes('完整')) return 30000
    if (expectedOutput.includes('列表') || expectedOutput.includes('目录')) return 15000
    return 8000
  }

  function buildChatHistory(currentContent: string): ChatMessage[] {
    const recentMsgs = messages.value.filter(m => m.role === 'user' || (m.role === 'assistant' && m.type === 'text'))

    const recentCount = 3
    const recent = recentMsgs.slice(-recentCount)
    const olderMsgs = recentMsgs.slice(0, -recentCount)

    const history: ChatMessage[] = []

    if (olderMsgs.length > 0) {
      const allSummaries = getAllSummaries()
      const localSummary = localStorage.getItem('holo-history-summary') || ''
      const summary = allSummaries || localSummary
      if (summary) {
        history.push({ role: 'system', content: `[历史对话摘要]\n${summary.substring(0, 500)}` })
      }
    }

    for (const msg of recent) {
      if (msg.role === 'user') {
        history.push({ role: 'user', content: msg.content })
      } else if (msg.role === 'assistant' && msg.type === 'text') {
        history.push({ role: 'assistant', content: msg.content })
      }
    }

    if (!history.some(m => m.role === 'user' && m.content === currentContent)) {
      history.push({ role: 'user', content: currentContent })
    }

    return history
  }

  let summaryGenPromise: Promise<void> | null = null
  async function generateHistorySummary() {
    if (summaryGenPromise) return
    const run = async () => {
      const apiStore = useApiStore()
      const recentMsgs = messages.value.filter(m => m.role === 'user' || (m.role === 'assistant' && m.type === 'text'))
      if (recentMsgs.length < 4) return
      const summaryPrompt = '请用3-5句话概括以下对话的关键信息、用户需求和AI给出的结论。保留具体细节（文件名、数据、结论等），以便后续追问时可以关联：\n'
        + recentMsgs.slice(-20).map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.content.substring(0, 200)}`).join('\n')
      try {
        const result = await apiStore.chatCompletion(
          [{ role: 'user', content: summaryPrompt }],
          false,
          undefined,
          512
        )
        if (result.content) {
          localStorage.setItem('holo-history-summary', result.content)
        }
      } catch { /* ignore */ }
    }
    summaryGenPromise = run().finally(() => { summaryGenPromise = null })
    await summaryGenPromise
  }

  async function executeToolCall(
    mcpStore: ReturnType<typeof useMcpStore>,
    fullName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    if (fullName === 'shell_exec') {
      if (!window.electronAPI?.shellExec) throw new Error('shell_exec not available')
      const result = await window.electronAPI.shellExec({
        command: String(args.command || ''),
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeout: args.timeout ? Number(args.timeout) : undefined
      })
      if (result.success) {
        return result.stdout || '(命令执行成功，无输出)'
      }
      const debugStore = useDebugStore()
      debugStore.emitEvent('error', 'shell', `命令执行失败(exit code ${result.code})`, result.stderr || result.stdout || '')
      return `命令执行失败（退出码${result.code}）`
    }

    const sepIdx = fullName.indexOf('___')
    if (sepIdx < 0) throw new Error(`无效工具名: ${fullName}`)
    const mcpIdRaw = fullName.substring(0, sepIdx)
    const toolName = fullName.substring(sepIdx + 3)
    const conn = mcpStore.connections.find(c => {
      const safeId = c.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      return safeId === mcpIdRaw
    })
    if (!conn) throw new Error(`MCP连接未找到: ${mcpIdRaw}`)
    const result = await mcpStore.callTool(conn.id, toolName, args)
    return result
  }

  function yieldToUI(): Promise<void> {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0)
      })
    })
  }

  function stripHtml(text: string): string {
    return text
      .replace(/<div[^>]*>/gi, '\n')
      .replace(/<\/div>/gi, '')
      .replace(/<span[^>]*>/gi, '')
      .replace(/<\/span>/gi, '')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  async function sendMessage(content: string): Promise<string> {
    if (content.trim() === '/debug') {
      const debugStore = useDebugStore()
      if (debugStore.enabled) {
        debugStore.deactivate()
        addSystemNotice('🔍 调试模式已关闭')
      } else {
        debugStore.activate()
        const apiS = useApiStore()
        const nodeS = useNodeStore()
        debugStore.updateEnvironment({
          model: apiS.config.activeModel || '',
          provider: apiS.config.activeProviderId || '',
          apiReachable: apiS.isReady,
          nodeCount: nodeS.nodes.length,
          manifestCount: Object.keys(nodeS.l2Manifests).length
        })
        addSystemNotice('🔍 调试模式已开启 — 输入 /debug 关闭')
      }
      isProcessing.value = false
      return ''
    }
    addUserMessage(content)
    const apiStore = useApiStore()
    const nodeStore = useNodeStore()
    const mcpStore = useMcpStore()
    const debugStore = useDebugStore()

    try {
      debugStore.emitEvent('info', 'dialog', `[Dialog] 用户发送消息: ${content.substring(0, 100)}`)
    } catch { /* non-critical */ }
    if (awaitingRiskConfirm.value) {
      isProcessing.value = false
      return
    }
    isProcessing.value = true

    await yieldToUI()

    if (!apiStore.isReady) {
      if (apiStore.config.activeProviderId && apiStore.config.activeModel) {
        const ok = await apiStore.checkConnection()
        if (!ok) {
          addSystemNotice('❌ 连接失败，请检查API配置')
          isProcessing.value = false
          return ''
        }
      } else {
        addSystemNotice('❌ 未配置模型网关')
        isProcessing.value = false
        return ''
      }
    }

    try {
      const allMcpTools = buildMcpTools(mcpStore)
      await yieldToUI()

      const variableContext = await buildVariableContext(content)
      await yieldToUI()

      // ===== Phase A: Plan =====
      nodeStore.setL1Status('l1-task-translator', 'working')

      const mcpToolNames = allMcpTools.map(t => t.name.replace(/.*___/, ''))
      const recentUserMsgs = messages.value.filter(m => m.role === 'user')
      const recentUserMsg = recentUserMsgs.length > 1 ? recentUserMsgs[recentUserMsgs.length - 2].content : ''

      let plan: TaskPlan
      let macroManifestId: string | null = null

      // ===== L0 Skill: 简单命令直通L1，跳过RaaP =====
      nodeStore.setL1Status('l1-task-translator', 'working')
      const l0Plan = await tryL0Skill(content)
      if (l0Plan) {
        const domains = classifyDomain(content)
        nodeStore.setL1Status('l1-task-translator', 'success')
        nodeStore.setL1Status('l1-pipeline-builder', 'success')
        addSystemNotice(`⚡ L0 Skill直通：${l0Plan.intent}（${domains.join('/')}域，${l0Plan.steps.length}步L1执行）`)

        debugStore.emitEvent('info', 'schedule', `[Router] L0命中 → ${l0Plan.intent} | ${domains.join('/')}域 | ${l0Plan.steps.length}步`)

        const plan: TaskPlan = {
          intent: l0Plan.intent,
          needs: domains,
          steps: l0Plan.steps.map(s => ({
            step: s.step, description: s.description, tool: s.tool,
            depends_on: [], params: s.params, expectedOutput: s.expectedOutput
          }))
        }
        pendingPlan.value = plan
        pendingContent.value = content
        pendingMacroManifestId.value = null
        acquirePausePoint('confirmation')
        isProcessing.value = false
        const planSummary = `📋 **L0 Skill直通 (简单任务)**\n意图：${plan.intent}\n\n**执行计划：**\n${plan.steps.map(s => `${s.step}. ${s.description} → ${s.tool}`).join('\n')}\n\n确认执行？`
        addSystemNotice(planSummary)
        return ''
      }

      debugStore.emitEvent('info', 'schedule', `[Router] L0未命中 → 进入L0.5检查 | input="${content.substring(0, 50)}"`)

      // ===== L0.5 Quick Match: 关键词快照直通单步manifest =====
      const allL2 = nodeStore.getAllL2Manifests()
      const l05Result = tryL05QuickMatch(content, allL2)
      if (l05Result && l05Result.confidence >= 0.8) {
        nodeStore.setL1Status('l1-task-translator', 'success')
        nodeStore.setL1Status('l1-pipeline-builder', 'success')
        const m = l05Result.manifest
        addSystemNotice(`⚡ L0.5快速匹配：${m.identity.name}（关键词${l05Result.matchedKeywords.join(',')}命中，置信${(l05Result.confidence * 100).toFixed(0)}%）`)

        debugStore.emitEvent('info', 'schedule', `[Router] L0.5命中 → ${m.identity.id} | 置信${(l05Result.confidence * 100).toFixed(0)}% | 关键词: ${l05Result.matchedKeywords.join(',')}`)

        macroManifestId = m.identity.id
        if (m.execution.mode === 'direct' && m.execution.directCall) {
          plan = {
            intent: m.identity.name,
            needs: m.routing.keywords.slice(0, 3),
            steps: [{
              step: 1,
              description: m.identity.name,
              tool: 'llm_generate',
              depends_on: [],
              params: { prompt: m.execution.directCall.promptTemplate.replace('{{input}}', content) },
              expectedOutput: m.identity.name + '输出'
            }]
          }
        } else if (m.execution.dagPlan) {
          plan = {
            intent: m.identity.name,
            needs: m.routing.keywords.slice(0, 3),
            steps: m.execution.dagPlan.steps.map(s => ({
              step: s.step, description: s.description, tool: s.tool,
              depends_on: s.depends_on, params: s.params as Record<string, string>,
              expectedOutput: s.expectedOutput
            }))
          }
        } else {
          plan = {
            intent: m.identity.name,
            needs: m.routing.keywords.slice(0, 3),
            steps: [{ step: 1, description: m.identity.name, tool: 'llm_generate', depends_on: [], params: { prompt: content }, expectedOutput: '处理结果' }]
          }
        }

        pendingPlan.value = plan
        pendingContent.value = content
        pendingMacroManifestId.value = macroManifestId

        if (l05Result.confidence >= 0.9 && !planContainsShellExec(plan)) {
          addSystemNotice(`⚡ L0.5高置信自动执行（${(l05Result.confidence * 100).toFixed(0)}%，无shell操作）`)
          isProcessing.value = false
          await confirmPlan()
          return ''
        }

        acquirePausePoint('confirmation')
        isProcessing.value = false
        const planSummary = `📋 **L0.5快速匹配 (单步manifest)**\n意图：${plan.intent}\nManifest：${m.identity.id}\n\n**执行计划：**\n${plan.steps.map(s => `${s.step}. ${s.description} → ${s.tool}`).join('\n')}\n\n确认执行？`
        addSystemNotice(planSummary)
        return ''
      }

      // ===== L1 Check: 单步管道直通 =====
      const l1Check = checkL1Capability(content)
      if (l1Check.canHandle && l1Check.plan && l1Check.confidence >= 0.6) {
        nodeStore.setL1Status('l1-task-translator', 'success')
        addSystemNotice(`🔧 L1管道直通：${l1Check.nodeName}（置信${(l1Check.confidence * 100).toFixed(0)}%）`)

        debugStore.emitEvent('info', 'schedule', `[Router] L1命中 → ${l1Check.nodeId} | 置信${(l1Check.confidence * 100).toFixed(0)}%`)

        plan = {
          intent: l1Check.plan.intent,
          needs: [l1Check.nodeId],
          steps: l1Check.plan.steps.map(s => ({
            step: s.step, description: s.description, tool: s.tool,
            depends_on: [], params: s.params, expectedOutput: s.expectedOutput
          }))
        }
        pendingPlan.value = plan
        pendingContent.value = content
        pendingMacroManifestId.value = null
        acquirePausePoint('confirmation')
        isProcessing.value = false
        const planSummary = `📋 **L1管道直通 (单节点)**\n意图：${plan.intent}\n节点：${l1Check.nodeId}\n\n**执行计划：**\n${plan.steps.map(s => `${s.step}. ${s.description} → ${s.tool}`).join('\n')}\n\n确认执行？`
        addSystemNotice(planSummary)
        return ''
      }

      debugStore.emitEvent('info', 'schedule', `[Router] L0.5/L1均未命中 → 进入RaaP | input="${content.substring(0, 50)}"`)

      // ===== RaaP: Retrieval-as-Planning (zero LLM for matching) =====
      nodeStore.setL1Status('l1-task-translator', 'working')
      const toolIndex = await buildToolIndex(allMcpTools.map(t => ({
        name: t.name,
        description: t.description
      })), allL2)

      const retrievalFilter = {
        visibleL2Ids: nodeStore.getVisibleL2Ids(),
        selectedRole: nodeStore.interaction.selectedRole ?? undefined
      }

      let raapResult: RaapMatchResult | null = null
      let universalResult: UniversalMatchResult | null = null

      const lastAssistantMsgs = messages.value.filter(m => m.role === 'assistant')
      const lastAssistantContent = lastAssistantMsgs.length > 0 ? lastAssistantMsgs[lastAssistantMsgs.length - 1].content : ''
      const isLikelyFeedback = lastAssistantContent.length > 50 && /没有|不存在|找不到|不行|错误|失败|没看到|没找到|搞错了|不对|不是/i.test(content)
      const isShortFeedback = content.length < 30 && /没有|不行|不对|错误|失败|找不到|不是/i.test(content)

      debugLog(`[Dialog] sendMessage: "${content.substring(0, 80)}"`)
      debugLog(`[Dialog] isLikelyFeedback=${isLikelyFeedback} isShortFeedback=${isShortFeedback} lastAssistantLen=${lastAssistantContent.length}`)

      if (isLikelyFeedback || isShortFeedback) {
        debugLog('[Dialog] 跳过RaaP，作为反馈处理')
        raapResult = null
      } else {
        try {
          const rewriteStrategy = content.length > 6 ? mabSelectArm('rewrite_strategy') : 'none'
          let activeQuery = content
          let wasRewritten = false
          let rewrittenQuery: string | undefined

          universalResult = await universalMatch(content, toolIndex, retrievalFilter)

          if (!universalResult) {
            switch (rewriteStrategy) {
              case 'none':
                break
              case 'keyword_extract': {
                const keywords = extractCoreKeywords(content)
                if (keywords.length > 0) {
                  activeQuery = keywords.join(' ')
                  wasRewritten = true
                  rewrittenQuery = activeQuery
                  debugStore.emitEvent('info', 'raap', `关键词提取: "${content.substring(0, 40)}" → "${activeQuery}"`)
                  universalResult = await universalMatch(activeQuery, toolIndex, retrievalFilter)
                }
                break
              }
              case 'llm_rewrite': {
                const rewritten = await rewriteQuery(content, async (msgs) => {
                  const r = await apiStore.chatCompletion(msgs as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }[], false, undefined, 64)
                  return { content: r.content || '' }
                })
                if (rewritten !== content) {
                  activeQuery = rewritten
                  wasRewritten = true
                  rewrittenQuery = rewritten
                  debugStore.emitEvent('info', 'raap', `查询改写: "${content.substring(0, 40)}" → "${rewritten}"`)
                  universalResult = await universalMatch(rewritten, toolIndex, retrievalFilter)
                }
                break
              }
              case 'both': {
                const keywords = extractCoreKeywords(content)
                if (keywords.length > 0) {
                  const kwQuery = keywords.join(' ')
                  const kwResult = await universalMatch(kwQuery, toolIndex, retrievalFilter)
                  if (kwResult && kwResult.gate === 'green') {
                    universalResult = kwResult
                    wasRewritten = true
                    rewrittenQuery = kwQuery
                    debugStore.emitEvent('info', 'raap', `关键词提取命中: "${content.substring(0, 40)}" → "${kwQuery}"`)
                  }
                }
                if (!universalResult) {
                  const rewritten = await rewriteQuery(content, async (msgs) => {
                    const r = await apiStore.chatCompletion(msgs as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }[], false, undefined, 64)
                    return { content: r.content || '' }
                  })
                  if (rewritten !== content) {
                    activeQuery = rewritten
                    wasRewritten = true
                    rewrittenQuery = rewritten
                    debugStore.emitEvent('info', 'raap', `查询改写(both): "${content.substring(0, 40)}" → "${rewritten}"`)
                    universalResult = await universalMatch(rewritten, toolIndex, retrievalFilter)
                  }
                }
                break
              }
            }
          }

          lastDecisionContext.value = {
            rewriteStrategy,
            disambigStrategy: '',
            wasRewritten,
            originalQuery: content,
            rewrittenQuery,
            matchResult: universalResult?.item.name || '',
            gate: universalResult?.gate || 'red'
          }
          if (universalResult) {
            if (universalResult.item.source === 'l2' && universalResult.item.manifest) {
              raapResult = {
                manifest: universalResult.item.manifest,
                confidence: universalResult.confidence,
                matchMethod: universalResult.matchMethod === 'keyword+vector' ? 'model' : universalResult.matchMethod,
                isAmbiguous: universalResult.isAmbiguous,
                candidates: universalResult.candidates?.filter(c => c.item.source === 'l2' && c.item.manifest).map(c => ({
                  manifest: c.item.manifest!,
                  score: c.score,
                  method: c.method
                })),
                gate: universalResult.gate
              }
            } else if (universalResult.item.source === 'mcp' && universalResult.isAmbiguous) {
              const cands = universalResult.candidates || []
              if (cands.length > 1) {
                const candList = cands.slice(0, 5).map((c, i) => `${i + 1}. ${c.item.name}（${(c.score * 100).toFixed(0)}%，${c.method === 'keyword' ? '关键词' : c.method === 'vector' ? '向量' : '融合'}）`).join('\n')
                addSystemNotice(`🟡 匹配到多个工具候选，请选择：\n${candList}\n\n输入编号选择，或重新描述你的需求`)
                pendingCandidateList.value = cands.slice(0, 5).map(c => ({ manifestId: c.item.id, manifestName: c.item.name, score: c.score }))
                awaitingCandidatePick.value = true
                isProcessing.value = false
                return ''
              }
            } else if (universalResult.item.source === 'mcp' && !universalResult.isAmbiguous) {
              const mcpToolName = universalResult.item.id
              const matchedMcpTool = allMcpTools.find(t => t.name === mcpToolName)
              if (matchedMcpTool) {
                debugLog(`[Dialog] Universal匹配MCP工具: ${universalResult.item.name}，直接调用`)
                addSystemNotice(`🎯 自动匹配工具：**${universalResult.item.name}**（置信${(universalResult.confidence * 100).toFixed(0)}%，${universalResult.matchMethod}）`)
                try {
                  const apiResult = await apiStore.chatCompletion([{ role: 'user', content }], true, [matchedMcpTool])
                  if (apiResult) {
                    addAssistantMessage(apiResult)
                  }
                } catch (e) {
                  const errStr = e instanceof Error ? e.message : String(e)
                  addAssistantMessage(`❌ 工具调用失败（${classifyError(errStr)}）`)
                  debugStore.emitEvent('error', 'tool', `工具调用失败: ${errStr}`, errStr)
                }
                isProcessing.value = false
                return ''
              }
            }
          }
        } catch { /* vector search may fail */ }
      }

      if (raapResult && raapResult.isAmbiguous) {
        if (raapResult.gate === 'yellow') {
          const disambigStrategy = mabSelectArm('disambig_strategy')
          if (lastDecisionContext.value) {
            lastDecisionContext.value.disambigStrategy = disambigStrategy
          }

          const cands = raapResult.candidates || []
          switch (disambigStrategy) {
            case 'show_candidates': {
              if (cands.length > 1) {
                const candList = cands.slice(0, 5).map((c, i) => `${i + 1}. ${c.manifest.identity.name}（${(c.score * 100).toFixed(0)}%，${c.method === 'keyword' ? '关键词' : '向量'}）`).join('\n')
                addSystemNotice(`🟡 RaaP匹配到多个候选，请选择：\n${candList}\n\n输入编号选择，或重新描述你的需求`)
                pendingCandidateList.value = cands.slice(0, 5).map(c => ({ manifestId: c.manifest.identity.id, manifestName: c.manifest.identity.name, score: c.score }))
                awaitingCandidatePick.value = true
                isProcessing.value = false
                return ''
              }
              const topManifest = raapResult.manifest
              const translated = await translateIntent(content, topManifest, recentUserMsg)
              if (translated) {
                const paramStr = Object.entries(translated.params).map(([k, v]) => `${k}=${v}`).join(', ')
                const slotSlots = topManifest.execution.paramMapping?.slots || []
                const missingRequired = slotSlots.filter(s => s.required && !translated.params[s.name])
                translatedIntent.value = {
                  intent: translated.intent,
                  manifestId: topManifest.identity.id,
                  params: translated.params,
                  originalInput: content
                }
                if (missingRequired.length === 0) {
                  acquirePausePoint('intentConfirm')
                  addSystemNotice(`🟡 Agent翻译：你的意图是"${translated.intent}"${paramStr ? '，参数：' + paramStr : ''}\n\n确认执行？`)
                  isProcessing.value = false
                  return ''
                } else {
                  slotClarification.value = {
                    manifestId: topManifest.identity.id,
                    manifestName: topManifest.identity.name,
                    slots: slotSlots.map(s => ({
                      name: s.name,
                      description: s.description,
                      required: s.required,
                      value: (translated.params[s.name] as string) || ''
                    }))
                  }
                  acquirePausePoint('slotFill')
                  isProcessing.value = false
                  addSystemNotice(`🔴 缺少必填参数：${missingRequired.map(s => s.name).join('、')}\n请填写以下信息：`)
                  return ''
                }
              } else {
                const candList = cands.slice(0, 4).map((c, i) => `${i + 1}. ${c.manifest.identity.name}（${(c.score * 100).toFixed(0)}%）`).join('\n')
                addSystemNotice(`🟡 翻译超时，候选：\n${candList}\n请重新描述或从候选中选择`)
                raapResult = null
              }
              break
            }
            case 'llm_pick': {
              if (cands.length >= 2) {
                debugStore.emitEvent('info', 'raap', `MAB选择LLM仲裁（${cands.length}个候选）`)
                const fbItems = cands.map(c => ({ item: { id: `l2://${c.manifest.identity.id}`, name: c.manifest.identity.name, description: c.manifest.routing.retrievalSummary || '', keywords: c.manifest.routing.keywords, userSummary: c.manifest.routing.userSummary || '', source: 'l2' as const, manifest: c.manifest }, score: c.score, method: c.method }))
                const picked = await llmFallback(content, fbItems, async (msgs) => {
                  const r = await apiStore.chatCompletion(msgs as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }[], false, undefined, 128)
                  return { content: r.content || '' }
                })
                if (picked && picked.manifest) {
                  raapResult = {
                    manifest: picked.manifest,
                    confidence: 0.5,
                    matchMethod: 'model',
                    isAmbiguous: false,
                    gate: 'green'
                  }
                  debugStore.emitEvent('info', 'raap', `LLM仲裁选中: ${picked.manifest.identity.name}`)
                } else {
                  raapResult = null
                }
              } else {
                raapResult = null
              }
              break
            }
            case 'ask_clarify': {
              const candNames = cands.slice(0, 3).map(c => c.manifest.identity.name).join('、')
              if (cands.length > 1) {
                addSystemNotice(`🟡 您是指：${candNames}？请重新描述您的需求，或输入编号选择`)
                pendingCandidateList.value = cands.slice(0, 5).map(c => ({ manifestId: c.manifest.identity.id, manifestName: c.manifest.identity.name, score: c.score }))
                awaitingCandidatePick.value = true
                isProcessing.value = false
                return ''
              }
              raapResult = null
              break
            }
            case 'fallback_l1': {
              const l1Cap = checkL1Capability(content)
              if (l1Cap) {
                debugStore.emitEvent('info', 'raap', 'MAB选择降级到L1管道')
                raapResult = null
              } else {
                raapResult = null
              }
              break
            }
          }
        } else {
          raapResult = null
        }
      }

      if (raapResult === null && !awaitingIntentConfirm.value && !awaitingSlotFill.value) {
        // ===== LLM Fallback: red gate → LLM仲裁 =====
        let llmFallbackHit = false
        if (toolIndex.length > 0) {
          try {
            const fbCandidates = getTop3CandidatesUniversal(content, toolIndex)
            if (fbCandidates.length >= 2) {
              debugStore.emitEvent('warn', 'raap', `RaaP红色gate，尝试LLM仲裁（${fbCandidates.length}个候选）`)
              const fbItem = await llmFallback(content, fbCandidates, async (msgs) => {
                const r = await apiStore.chatCompletion(msgs as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }[], false, undefined, 128)
                return { content: r.content || '' }
              })
              if (fbItem) {
                llmFallbackHit = true
                if (fbItem.source === 'l2' && fbItem.manifest) {
                  raapResult = {
                    manifest: fbItem.manifest,
                    confidence: 0.5,
                    matchMethod: 'model',
                    isAmbiguous: false,
                    gate: 'green'
                  }
                  debugStore.emitEvent('info', 'raap', `LLM仲裁选中: ${fbItem.name}`)
                } else if (fbItem.source === 'mcp') {
                  const mcpToolName = fbItem.id
                  const matchedMcpTool = allMcpTools.find(t => t.name === mcpToolName)
                  if (matchedMcpTool) {
                    debugStore.emitEvent('info', 'raap', `LLM仲裁选中MCP工具: ${fbItem.name}，直接调用`)
                    try {
                      const apiResult = await apiStore.chatCompletion([{ role: 'user', content }], true, [matchedMcpTool])
                      if (apiResult) {
                        addAssistantMessage(apiResult.content || '(无输出)')
                      }
                    } catch (e) {
                      const errStr = e instanceof Error ? e.message : String(e)
                      addAssistantMessage(`❌ 工具调用失败（${classifyError(errStr)}）`)
                      debugStore.emitEvent('error', 'tool', `工具调用失败: ${errStr}`, errStr)
                    }
                    isProcessing.value = false
                    return ''
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[Dialog] LLM fallback失败:', e instanceof Error ? e.message : String(e))
          }
        }

        if (!llmFallbackHit) {
          debugStore.emitEvent('info', 'schedule', `[Router] RaaP+LLM仲裁均未命中 → 探索模式 | input="${content.substring(0, 50)}"`)
          const explorePlan = await buildExplorePlan(content)
          addSystemNotice(`🤔 RaaP未命中，进入探索模式：${explorePlan.intent}`)
          const plan: TaskPlan = {
            intent: explorePlan.intent,
            needs: ['探索模式'],
            steps: explorePlan.steps.map(s => ({
              step: s.step, description: s.description, tool: s.tool,
              depends_on: [], params: s.params, expectedOutput: s.expectedOutput
            }))
          }
          nodeStore.setL1Status('l1-task-translator', 'success')
          nodeStore.setL1Status('l1-pipeline-builder', 'success')
        pendingPlan.value = plan
        pendingContent.value = content
        pendingMacroManifestId.value = null

        if (!planContainsShellExec(plan)) {
          addSystemNotice(`⚡ L0 Skill自动执行（无shell操作）`)
          isProcessing.value = false
          await confirmPlan()
          return ''
        }

        acquirePausePoint('confirmation')
        isProcessing.value = false
          const planSummary = `📋 **探索模式 (L1临时编排)**\n意图：${plan.intent}\n\n**执行计划：**\n${plan.steps.map(s => `${s.step}. ${s.description} → ${s.tool}`).join('\n')}\n\n确认执行？`
          addSystemNotice(planSummary)
          return ''
        }
      }

      if (raapResult && (raapResult.manifest.execution.mode === 'macro' || raapResult.manifest.execution.mode === 'chain') && raapResult.manifest.execution.dagPlan) {
        macroManifestId = raapResult.manifest.identity.id
        plan = {
          intent: raapResult.manifest.identity.name,
          needs: raapResult.manifest.routing.keywords.slice(0, 3),
          steps: raapResult.manifest.execution.dagPlan.steps.map(s => ({
            step: s.step,
            description: s.description,
            tool: s.tool,
            depends_on: s.depends_on,
            params: s.params,
            expectedOutput: s.expectedOutput,
            fallback: s.fallback
          }))
        }
        const methodLabel = raapResult.matchMethod === 'vector' ? '向量匹配' : raapResult.matchMethod === 'keyword' ? '关键词匹配' : '模型分类'
        const gateLabel = raapResult.gate === 'green' ? '🟢绿色通道' : raapResult.gate === 'yellow' ? '🟡黄色通道' : '🔴红色通道'
        addSystemNotice(`${gateLabel} RaaP匹配：${raapResult.manifest.identity.name}（${methodLabel}，置信度${(raapResult.confidence * 100).toFixed(0)}%）`)
        debugStore.emitEvent('info', 'schedule', `[Router] RaaP命中 → ${raapResult.manifest.identity.id} | ${methodLabel} | gate=${raapResult.gate} | 置信${(raapResult.confidence * 100).toFixed(0)}% | 节省~${raapResult.manifest.cacheMeta.estimatedTokenSaving} tokens`)
      } else if (raapResult && raapResult.manifest.execution.mode === 'direct' && raapResult.manifest.execution.directCall) {
        macroManifestId = raapResult.manifest.identity.id
        plan = {
          intent: raapResult.manifest.identity.name,
          needs: raapResult.manifest.routing.keywords.slice(0, 3),
          steps: [{
            step: 1,
            description: raapResult.manifest.identity.name,
            tool: 'llm_generate',
            depends_on: [],
            params: { prompt: raapResult.manifest.execution.directCall.promptTemplate },
            expectedOutput: raapResult.manifest.identity.name + '输出'
          }]
        }
        const methodLabel = raapResult.matchMethod === 'vector' ? '向量匹配' : raapResult.matchMethod === 'keyword' ? '关键词匹配' : '模型分类'
        const gateLabel2 = raapResult.gate === 'green' ? '🟢' : raapResult.gate === 'yellow' ? '🟡' : '🔴'
        addSystemNotice(`${gateLabel2} RaaP直调：${raapResult.manifest.identity.name}（${methodLabel}，置信度${(raapResult.confidence * 100).toFixed(0)}%）`)
        debugStore.emitEvent('info', 'schedule', `[Router] RaaP直调 → ${raapResult.manifest.identity.id} | ${methodLabel} | gate=${raapResult.gate} | 置信${(raapResult.confidence * 100).toFixed(0)}%`)
      }

      if (!macroManifestId) {
        try {
          plan = await planTask(content, mcpToolNames, recentUserMsg)
        } catch {
          addSystemNotice('⚠️ 任务规划失败，使用通用执行方案')
          plan = {
            intent: content.substring(0, 50),
            needs: ['直接处理'],
            steps: [{ step: 1, description: '根据用户需求选择合适的工具执行任务', tool: 'auto', depends_on: [], params: {}, expectedOutput: '任务结果' }]
          }
        }
      }
      await yieldToUI()

      // ===== Phase A2: Self-check plan =====
      const planIssues: string[] = []
      if (plan.steps.length === 0) planIssues.push('计划步骤为空')
      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]
        if (!step.description || step.description.length < 3) planIssues.push(`步骤${i + 1}描述不明确`)
        if (!step.tool) planIssues.push(`步骤${i + 1}未指定工具`)
      }
      if (plan.intent.length < 3) planIssues.push('意图不明确')

      const planThought: ThoughtStep = {
        phase: 'plan',
        content: `意图：${plan.intent} | 需要：${plan.needs.join('、')} | ${plan.steps.length}步计划${planIssues.length > 0 ? ' | ⚠️' + planIssues.join('、') : ' | ✅计划合理'}`,
        timestamp: Date.now()
      }
      addThoughtMessage([planThought], plan)
      nodeStore.setL1Status('l1-task-translator', 'success')
      nodeStore.setL1Status('l1-pipeline-builder', 'success')
      await yieldToUI()

      // ===== Phase A3: User confirmation =====
      pendingPlan.value = plan
      pendingContent.value = content
      acquirePausePoint('confirmation')
      pendingMacroManifestId.value = macroManifestId
      isProcessing.value = false

      const planSummary = `📋 **任务分析 (DAG)**\n意图：${plan.intent}\n需要：${plan.needs.join('、')}\n\n**执行计划：**\n${plan.steps.map(s => {
        const deps = s.depends_on.length > 0 ? `（依赖步骤${s.depends_on.join(',')}）` : ''
        return `${s.step}. ${s.description} → ${s.tool} ${deps}`
      }).join('\n')}\n\n请确认是否按此计划执行？`
      addSystemNotice(planSummary)
      return ''
    } catch (err) {
      const errMsg = String(err)
      addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
      debugStore.emitEvent('error', 'tool', `执行失败: ${errMsg}`, errMsg)
      const nodeStore = useNodeStore()
      nodeStore.setL0RedFlash(true)
      isProcessing.value = false
      return ''
    }
  }

  async function confirmPlan(): Promise<string> {
    if (!pendingPlan.value) return ''
    const plan = pendingPlan.value
    const content = pendingContent.value
    const macroId = pendingMacroManifestId.value
    pendingPlan.value = null
    pendingContent.value = ''
    awaitingConfirmation.value = false
    pendingMacroManifestId.value = null
    isProcessing.value = true

    try {
      const debugStore = useDebugStore()
      debugStore.emitEvent('info', 'dialog', `[Dialog] 确认执行计划: macroId=${macroId || 'none'}, steps=${plan.steps?.length || 0}`)
    } catch { /* non-critical */ }

    const nodeStore = useNodeStore()
    const mcpStore = useMcpStore()

    // ===== Native tools fast path (0 LLM tokens) =====
    const NATIVE_TOOLS = new Set(['create_docx', 'file_write', 'create_directory', 'shell_exec', 'read_file', 'llm_generate', 'http_request', 'knowledge_search'])
    const isAllNative = plan.steps.length > 0 && plan.steps.every(s => NATIVE_TOOLS.has(s.tool))
    if (isAllNative) {
      addSystemNotice('✅ 用户确认，直接执行原生工具...')
      const stepResults: Record<number, string> = {}
      let lastResult = ''
      let allOk = true

      for (const s of plan.steps) {
        const depsOk = s.depends_on.every(d => stepResults[d] !== undefined)
        if (!depsOk) {
          debugStore.emitEvent('info', 'schedule', `跳过步骤${s.step}: 依赖未满足`)
          continue
        }
        const resolvedParams: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(s.params)) {
          if (typeof v === 'string') {
            let val = v
            for (const [depNum, depResult] of Object.entries(stepResults)) {
              val = val.replace(`{{step_${depNum}_result}}`, depResult)
            }
            resolvedParams[k] = val
          } else {
            resolvedParams[k] = v
          }
        }

        addSystemNotice(`▶ 步骤${s.step}: ${s.description}`)
        try {
          const { callToolDirectWithTier } = await import('@/services/macroExecutor')
          const result = await callToolDirectWithTier(mcpStore, s.tool, resolvedParams, undefined, undefined, undefined, stepResults, { inputText: content })
          stepResults[s.step] = result
          lastResult = result
          addSystemNotice(`✓ 步骤${s.step}完成`)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          addSystemNotice(`✗ 步骤${s.step}失败（${classifyError(errMsg)}）`)
          debugStore.emitEvent('error', 'tool', `步骤${s.step}失败: ${errMsg}`, errMsg)
          allOk = false
          break
        }
      }

      if (allOk && lastResult) {
        const finalText = stripHtml(beautify(lastResult))
        addAssistantMessage(finalText)
      }
      nodeStore.markTaskChainComplete()
      isProcessing.value = false
      return lastResult || ''
    }

    // ===== Direct mode shortcut =====
    const macroManifest = macroId ? nodeStore.getL2Manifest(macroId) : null
    if (macroManifest && macroManifest.execution.mode === 'direct' && macroManifest.execution.directCall) {
      addSystemNotice('✅ 用户确认，执行直调模式...')
      nodeStore.setL1Status('l1-model-gateway', 'working')
      try {
        const directInfo = resolveDirectPrompt(macroManifest, {
          inputText: content,
          context: content
        })
        if (directInfo) {
          const apiStore = useApiStore()
          const resp = await apiStore.chatCompletion(
            [{ role: 'user', content: directInfo.prompt }],
            true,
            undefined,
            directInfo.maxTokens
          )
          nodeStore.setL1Status('l1-model-gateway', 'success')
          const finalText = stripHtml(beautify(resp.content || '(无输出)'))
          addAssistantMessage(finalText)
          nodeStore.markTaskChainComplete()
          isProcessing.value = false
          return finalText
        }
      } catch (err) {
        const errStr = String(err)
        addSystemNotice(`❌ 直调失败（${classifyError(errStr)}）`)
        debugStore.emitEvent('error', 'tool', `直调失败: ${errStr}`, errStr)
        nodeStore.setL1Status('l1-model-gateway', 'error')
      }
    }

    // ===== Macro/Chain mode shortcut =====
    if (macroManifest && (macroManifest.execution.mode === 'macro' || macroManifest.execution.mode === 'chain') && macroManifest.execution.dagPlan) {
      addSystemNotice('✅ 用户确认，执行宏/链模式...')
      const dagSteps = macroManifest.execution.dagPlan.steps
      const dependsOnMap: Record<number, number[]> = {}
      for (const s of dagSteps) {
        dependsOnMap[s.step] = s.depends_on
      }
      const l2Nodes = nodeStore.nodes.filter(n => n.level === 'L2')
      nodeStore.setDAGChain(dagSteps.map(s => ({
        nodeId: l2Nodes.find(n => n.id === macroManifest.identity.id)?.id || macroManifest.identity.id,
        stepNum: s.step,
        status: 'pending' as const
      })), dependsOnMap)

      try {
        const macroResult = await executeMacro(
          macroManifest,
          { inputText: content, context: content },
          (stepNum, tool) => {
            nodeStore.updateDAGStep(stepNum, 'running')
            addSystemNotice(`▶ 步骤${stepNum}: ${tool}`)
          },
          (stepNum, result) => {
            nodeStore.updateDAGStep(stepNum, 'done')
            addSystemNotice(`✓ 步骤${stepNum}完成`)
          },
          (stepNum, error) => {
            nodeStore.updateDAGStep(stepNum, 'failed')
            addSystemNotice(`✗ 步骤${stepNum}失败（${classifyError(error)}）`)
            debugStore.emitEvent('error', 'tool', `步骤${stepNum}失败: ${error}`, error)
          },
          (stepNum) => {
            nodeStore.updateDAGStep(stepNum, 'reuse')
            debugStore.emitEvent('info', 'cache', `步骤${stepNum}复用缓存结果`)
            nodeStore.emitNodeVisualEvent(macroManifest.identity.id, 'cache_hit', 2000)
          },
          (stepNum) => {
            nodeStore.updateDAGStep(stepNum, 'skip')
            debugStore.emitEvent('info', 'schedule', `步骤${stepNum}条件短路跳过`)
          },
          (preview) => {
            debugStore.emitEvent('info', 'schedule', `执行计划预览`, preview)
          }
        )

        if (macroResult.savedTokens > 0) {
          debugStore.emitEvent('info', 'cache', `调度优化节省 ~${macroResult.savedTokens} tokens（缓存复用+条件短路）`)
        }

        if (macroResult.lineage && macroResult.lineage.length > 0) {
          const savings = computeLineageSavings(macroResult.lineage)
          const lineageText = formatLineage(macroResult.lineage)
          debugStore.emitEvent('info', 'cache', `执行血缘：零token步骤 ${savings.zeroTokenSteps}/${savings.llmSteps + savings.zeroTokenSteps}，预估节省 ${savings.tokensSaved} tokens`, lineageText)
        }

        logManifestUsage(macroManifest.identity.id)

        const finalText = stripHtml(beautify(macroResult.lastResult || '(执行完成)'))
        addAssistantMessage(finalText, undefined, undefined, undefined, undefined, macroResult.lineage)
        nodeStore.markTaskChainComplete()
        setTimeout(() => { nodeStore.clearDAGChain() }, 3000)
        isProcessing.value = false
        return finalText
      } catch (err) {
        const errMsg = String(err)
        if (errMsg.startsWith('FactGuard:')) {
          factConflict.value = {
            conflicts: [{ type: 'fact_guard', sourceRaw: '源文件', outputRaw: 'AI输出', diff: errMsg.replace('FactGuard: ', ''), severity: 'critical' }],
            pendingStepNum: 0,
            pendingManifestId: macroManifest.identity.id
          }
          acquirePausePoint('factResolution')
          isProcessing.value = false
          addSystemNotice(`🔴 事实一致性校验失败：${errMsg.replace('FactGuard: ', '')}`)
          return ''
        }
        addSystemNotice(`❌ 宏执行失败（${classifyError(errMsg)}），回退到普通模式`)
        debugStore.emitEvent('error', 'tool', `宏执行失败，回退到普通模式: ${errMsg}`, errMsg)
        nodeStore.clearDAGChain()
        // Fall through to normal execution
      }
    }

    const apiStore = useApiStore()

    try {
      addSystemNotice('✅ 用户确认，开始执行...')
      nodeStore.setL1Status('l1-workspace-memory', 'working')

      const allMcpTools = buildMcpTools(mcpStore)

      nodeStore.setL1Status('l1-task-translator', 'working')
      const planFiltered = filterToolsByPlan(allMcpTools, plan)
      const toolIndex = await buildToolIndex(planFiltered.map(t => ({
        name: t.name,
        description: t.description
      })))
      const topCandidates = await retrieveTopTools(content, toolIndex, 5)
      nodeStore.setL1Status('l1-task-translator', 'success')

      const candidateNames = new Set(topCandidates.map(t => t.fullName))
      const activeTools = planFiltered.filter(t => candidateNames.has(t.name) || t.name === 'shell_exec')
      if (activeTools.length < 3) {
        for (const t of planFiltered) {
          if (!activeTools.some(a => a.name === t.name)) activeTools.push(t)
          if (activeTools.length >= 5) break
        }
      }

      const candidateL2Ids = topCandidates.map(t => {
        const mcpPrefix = t.fullName.split('___')[0]
        const l2Nodes = nodeStore.nodes.filter(n => n.level === 'L2')
        return l2Nodes.find(n => n.id.includes(mcpPrefix) || t.shortName.includes(n.id.split('-').pop() || ''))?.id
      }).filter(Boolean) as string[]
      nodeStore.highlightL2Candidates(candidateL2Ids)
      if (candidateL2Ids.length > 0) {
          debugStore.emitEvent('info', 'raap', `RAG检索到${topCandidates.length}个候选工具，已高亮L2节点`)
      }

      // ===== Map plan steps to L2 nodes for DAG chain =====
      const stepToNodeMap = new Map<number, string>()
      const l2Nodes = nodeStore.nodes.filter(n => n.level === 'L2')
      for (const step of plan.steps) {
        const toolLower = step.tool.toLowerCase()
        const match = candidateL2Ids.find(id => {
          const node = l2Nodes.find(n => n.id === id)
          return node && (node.id.toLowerCase().includes(toolLower) || toolLower.includes(node.id.split('-').pop()?.toLowerCase() || ''))
        })
        if (match) stepToNodeMap.set(step.step, match)
      }

      const dagStepNodes = plan.steps.map(s => ({
        nodeId: stepToNodeMap.get(s.step) || `l1-model-gateway`,
        stepNum: s.step,
        dependsOn: s.depends_on
      }))

      // ===== Initialize DAG chain visuals =====
      const dependsOnMap: Record<number, number[]> = {}
      for (const s of plan.steps) {
        dependsOnMap[s.step] = s.depends_on
      }
      nodeStore.setDAGChain(dagStepNodes.map(s => ({
        nodeId: s.nodeId,
        stepNum: s.stepNum,
        status: 'pending' as const
      })), dependsOnMap)

      // ===== Mark root steps (no deps) as ready =====

      nodeStore.setL1Status('l1-model-gateway', 'working')

      const variableContext = await buildVariableContext(content)
      const chatHistory: ChatMessage[] = [
        { role: 'system', content: FIXED_SYSTEM_PROMPT }
      ]
      chatHistory.push({ role: 'system', content: variableContext })

      const historyMsgs = buildChatHistory(content)
      for (const msg of historyMsgs) {
        chatHistory.push(msg)
      }

      const lastAssistant = messages.value.filter(m => m.role === 'assistant' && m.type === 'text').slice(-1)[0]
      if (lastAssistant && detectChallenge(content, lastAssistant.content || '')) {
        nodeStore.setL1Status('l1-knowledge-feeder', 'working')
          debugStore.emitEvent('info', 'dialog', '检测到质疑，正在检索原始对话记录...')
        const ragResults = await searchConversationContext(content, 3)
        if (ragResults.length > 0) {
          chatHistory.push({
            role: 'system',
            content: `【系统自动注入 - 原始对话记录】用户质疑了你之前的回答，以下是最相关的历史对话原文，请据此纠正：\n${ragResults.join('\n---\n')}`
          })
          debugStore.emitEvent('info', 'dialog', '已检索到相关历史记录并注入上下文')
        }
        nodeStore.setL1Status('l1-knowledge-feeder', ragResults.length > 0 ? 'success' : 'idle')
      }

      nodeStore.setL1Status('l1-workspace-memory', 'success')

      const MAX_CONTEXT_CHARS = 200000
      let totalChars = chatHistory.reduce((sum, m) => sum + (m.content?.length || 0), 0)
      while (totalChars > MAX_CONTEXT_CHARS && chatHistory.length > 3) {
        const idx = chatHistory.findIndex(m => m.role !== 'system')
        if (idx < 0) break
        totalChars -= (chatHistory[idx].content?.length || 0)
        chatHistory.splice(idx, 1)
      }

      // ===== DAG-aware execution loop =====
      const MAX_ROUNDS = 12
      let finalContent = ''
      const toolCallSummary: string[] = []
      let hasToolCalls = false
      let hasErrors = false
      const executedTools: string[] = []
      const executionThoughts: ThoughtStep[] = []
      const completedStepResults: Record<number, string> = {}
      let currentPlanSteps = [...plan.steps]

      // Track which steps are done
      const stepDone = new Map<number, boolean>()
      const stepFailed = new Map<number, boolean>()

      for (let round = 0; round < MAX_ROUNDS; round++) {
        // Find next executable step (all deps satisfied, not auto tool)
        let nextStepIdx = -1
        for (let i = 0; i < currentPlanSteps.length; i++) {
          const step = currentPlanSteps[i]
          if (stepDone.has(step.step) || stepFailed.has(step.step)) continue
          if (step.tool === 'auto') continue  // skip auto steps
          const depsOk = step.depends_on.every(d => stepDone.has(d))
          if (depsOk) {
            nextStepIdx = i
            break
          }
        }

        // If no specific-tool step found, check if there are auto steps
        let isAutoRound = false
        if (nextStepIdx < 0) {
          const autoStep = currentPlanSteps.find(s => s.tool === 'auto' && !stepDone.has(s.step) && !stepFailed.has(s.step))
          if (autoStep) {
            isAutoRound = true
          } else {
            // All steps done or blocked
            break
          }
        }

        nodeStore.setL1Status('l1-model-gateway', 'working')
        await yieldToUI()

        let stepHint = ''
        if (nextStepIdx >= 0) {
          const step = currentPlanSteps[nextStepIdx]
          nodeStore.updateDAGStep(step.step, 'running')
          stepHint = `\n【当前执行第${step.step}步：${step.description}，期望输出：${step.expectedOutput}】先简述思考(1-2句)再调工具。`
        } else if (isAutoRound) {
          stepHint = '\n请根据用户需求选择合适的工具执行任务。如果需要读取文件用read_file，需要执行命令用shell_exec。先简述思考再调工具。'
        }

        if (stepHint && chatHistory.length > 0) {
          const lastMsg = chatHistory[chatHistory.length - 1]
          if (lastMsg.role === 'user' && !lastMsg.content.includes('【当前执行第')) {
            lastMsg.content = (lastMsg.content || '') + stepHint
          } else {
            chatHistory.push({ role: 'user', content: stepHint })
          }
        }

        let result: { content: string; toolCalls: { id: string; name: string; arguments: string }[] }
        try {
          result = await apiStore.chatCompletion(chatHistory, true, activeTools.length > 0 ? activeTools : undefined)
        } catch (callErr) {
          const e = String(callErr)
          addSystemNotice(`❌ 请求失败（${classifyError(e)}）`)
          debugStore.emitEvent('error', 'llm', `请求失败: ${e}`, e)
          nodeStore.setL1Status('l1-model-gateway', 'error')
          hasErrors = true
          if (nextStepIdx >= 0) {
            const step = currentPlanSteps[nextStepIdx]
            stepFailed.set(step.step, true)
            nodeStore.updateDAGStep(step.step, 'failed')
          }
          break
        }
        await yieldToUI()

        nodeStore.setL1Status('l1-model-gateway', 'success')

        const thoughtText = result.content || ''
        if (thoughtText && result.toolCalls.length > 0) {
          executionThoughts.push({
            phase: 'thought',
            content: thoughtText.substring(0, 200),
            timestamp: Date.now()
          })
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: result.content || null
        }

        if (result.toolCalls.length > 0) {
          assistantMsg.tool_calls = result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
          chatHistory.push(assistantMsg)

          let stepHadError = false

          for (const tc of result.toolCalls) {
            const shortName = tc.name.replace(/.*___/, '').substring(0, 30)
            hasToolCalls = true
            executedTools.push(shortName)

            const toolLower = shortName.toLowerCase()
            if (toolLower.includes('read') || toolLower.includes('search') || toolLower.includes('knowledge') || toolLower.includes('directory') || toolLower.includes('list')) {
              nodeStore.setL1Status('l1-knowledge-feeder', 'working')
            }
            if (toolLower.includes('shell') || toolLower.includes('exec')) {
              nodeStore.setL1Status('l1-result-beautifier', 'working')
            }
            if (toolLower.includes('write')) {
              nodeStore.setL1Status('l1-result-beautifier', 'working')
            }
            await yieldToUI()

            let toolResult: string
            try {
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.arguments) } catch { args = {} }
              toolResult = await executeToolCall(mcpStore, tc.name, args)

              if (toolResult.includes('Error') || toolResult.includes('失败') || toolResult.includes('error')) {
                executionThoughts.push({
                  phase: 'observation',
                  content: `⚠️ 工具返回异常: ${truncateForLog(toolResult, 100)}`,
                  toolName: shortName,
                  toolResult: truncateForLog(toolResult, 150),
                  timestamp: Date.now()
                })
              }

              toolCallSummary.push(`✓ ${shortName}`)
              nodeStore.setL1Status('l1-knowledge-feeder', 'success')
              nodeStore.setL1Status('l1-result-beautifier', 'success')
            } catch (err) {
              const errStr = String(err)
              toolResult = `工具调用失败: ${errStr}`
              toolCallSummary.push(`✗ ${shortName}`)
              debugStore.emitEvent('error', 'tool', `工具${shortName}调用失败: ${errStr}`, errStr)
              hasErrors = true
              stepHadError = true
              nodeStore.setL1Status('l1-knowledge-feeder', 'error')
              nodeStore.setL1Status('l1-result-beautifier', 'error')
            }

            const currentStepIdx = nextStepIdx >= 0 ? nextStepIdx : Math.min(round, currentPlanSteps.length - 1)
            const truncateLen = getTruncateLen(currentPlanSteps[currentStepIdx]?.expectedOutput || '')
            const truncatedResult = toolResult.substring(0, truncateLen)

            executionThoughts.push({
              phase: 'observation',
              content: truncateForLog(toolResult, 150),
              toolName: shortName,
              toolResult: truncateForLog(toolResult, 200),
              timestamp: Date.now()
            })

            chatHistory.push({
              role: 'tool',
              content: truncatedResult,
              tool_call_id: tc.id
            })
            await yieldToUI()
          }

          // Mark step status in DAG
          if (nextStepIdx >= 0) {
            const step = currentPlanSteps[nextStepIdx]
            if (stepHadError) {
              stepFailed.set(step.step, true)
              nodeStore.updateDAGStep(step.step, 'failed')

              // ===== Re-Plan: local patch for remaining steps =====
              addSystemNotice(`🔄 步骤${step.step}失败，触发重规划...`)
              nodeStore.setL1Status('l1-pipeline-builder', 'working')
              const remainingSteps = currentPlanSteps.filter(s => !stepDone.has(s.step) && !stepFailed.has(s.step))
              // Mark failed step as done (with error) so dependent steps can proceed
              stepDone.set(step.step, true)
              completedStepResults[step.step] = `步骤执行失败，已触发重规划`
              nodeStore.updateDAGStep(step.step, 'replanned')
              try {
                const truncatedResults: Record<number, string> = {}
                for (const [k, v] of Object.entries(completedStepResults)) {
                  truncatedResults[Number(k)] = v.substring(0, 200) + (v.length > 200 ? '...(已截断)' : '')
                }
                const patchedSteps = await replan(step.step, '步骤执行失败', remainingSteps, truncatedResults)
                const maxStepNum = currentPlanSteps.reduce((max, cs) => Math.max(max, cs.step), 0)
                const newSteps = patchedSteps.map((s, i) => ({
                  ...s,
                  step: maxStepNum + i + 1
                }))
                // Keep done steps + failed step (now marked done) + new replanned steps
                currentPlanSteps = [...currentPlanSteps.filter(s => stepDone.has(s.step)), ...newSteps]
                // Add new steps to DAG chain state
                for (const ns of newSteps) {
                  const nsNode = stepToNodeMap.get(ns.tool) || 'l1-model-gateway'
                  nodeStore.dagChainState.steps.push({
                    nodeId: nsNode,
                    stepNum: ns.step,
                    status: 'replanned' as const
                  })
                  // Update dependsOnMap for 3D visualization
                  nodeStore.dagChainState.dependsOnMap[ns.step] = ns.depends_on
                }
                debugStore.emitEvent('info', 'schedule', `重规划完成，剩余${newSteps.length}步已调整`)
              } catch {
                addSystemNotice('⚠️ 重规划失败，继续尝试原有步骤')
              }
              nodeStore.setL1Status('l1-pipeline-builder', 'success')
            } else {
              stepDone.set(step.step, true)
              nodeStore.updateDAGStep(step.step, 'done')
              const lastObservation = executionThoughts.length > 0 ? executionThoughts[executionThoughts.length - 1] : null
              const rawResult = lastObservation?.toolResult || lastObservation?.content || '步骤完成'
              completedStepResults[step.step] = truncateForLog(rawResult, 500)
            }
          }

          // Step self-check
          if (nextStepIdx >= 0) {
            const currentStep = currentPlanSteps[nextStepIdx]
            const stepCheck = executedTools.some(et => {
              const etLower = et.toLowerCase()
              const toolLower = currentStep.tool.toLowerCase()
              return etLower.includes(toolLower) || toolLower.includes(etLower) || fuzzyToolMatch(toolLower, etLower)
            })
            if (!stepCheck && !hasErrors) {
              executionThoughts.push({
                phase: 'reflection',
                content: `⚠️ 第${currentStep.step}步期望调用${currentStep.tool}，但实际调用了${executedTools.slice(-3).join(',')}。可能需要补充。`,
                timestamp: Date.now()
              })
            }
          }

          if (executionThoughts.length > 0) {
            const lastThoughts = executionThoughts.slice(-4)
            addThoughtMessage(lastThoughts)
            await yieldToUI()
          }
        } else {
          finalContent = result.content || ''
          chatHistory.push(assistantMsg)
          if (nextStepIdx >= 0) {
            const step = currentPlanSteps[nextStepIdx]
            if (finalContent) {
              stepDone.set(step.step, true)
              nodeStore.updateDAGStep(step.step, 'done')
              completedStepResults[step.step] = finalContent.substring(0, 1000)
            } else {
              stepFailed.set(step.step, true)
              nodeStore.updateDAGStep(step.step, 'failed')
            }
          }
          // If auto round or no remaining steps, break; otherwise continue
          const hasRemaining = currentPlanSteps.some(s => !stepDone.has(s.step) && !stepFailed.has(s.step))
          if (!hasRemaining || isAutoRound) break
          finalContent = ''  // Reset for next step
          continue
        }
      }

      // ===== Phase C: Final full-flow self-check =====
      const effectivePlan: TaskPlan = { intent: plan.intent, needs: plan.needs, steps: currentPlanSteps }
      const reflection = reflectOnResult(effectivePlan, executedTools, hasErrors)
      const reflectThought: ThoughtStep = {
        phase: 'reflection',
        content: reflection.satisfied
          ? '✅ 所有计划步骤已完成'
          : `⚠️ ${reflection.suggestion}`,
        timestamp: Date.now()
      }
      addThoughtMessage([reflectThought])

      if (!reflection.satisfied && reflection.missingSteps.length > 0 && !hasErrors) {
        const missingDesc = reflection.missingSteps.map(i => currentPlanSteps[i]?.description || '').join('、')
        addSystemNotice(`🔄 补充执行缺失步骤：${missingDesc}`)

        chatHistory.push({
          role: 'user',
          content: `之前跳过了以下步骤，请补充执行：${missingDesc}。调用对应工具后总结。`
        })

        try {
          const supplementResult = await apiStore.chatCompletion(chatHistory, true, allMcpTools.length > 0 ? allMcpTools : undefined)
          if (supplementResult.toolCalls.length > 0) {
            const supplementMsg: ChatMessage = {
              role: 'assistant',
              content: supplementResult.content || null,
              tool_calls: supplementResult.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments }
              }))
            }
            chatHistory.push(supplementMsg)

            for (const tc of supplementResult.toolCalls) {
              const shortName = tc.name.replace(/.*___/, '').substring(0, 30)
              let toolResult: string
              try {
                let args: Record<string, unknown> = {}
                try { args = JSON.parse(tc.arguments) } catch { args = {} }
                toolResult = await executeToolCall(mcpStore, tc.name, args)
                toolCallSummary.push(`✓ ${shortName}`)
                executedTools.push(shortName)
              } catch (err) {
                toolResult = `工具调用失败: ${String(err)}`
                toolCallSummary.push(`✗ ${shortName}`)
                hasErrors = true
              }
              chatHistory.push({
                role: 'tool',
                content: truncateForLog(toolResult, 1000),
                tool_call_id: tc.id
              })
            }
          } else {
            finalContent = supplementResult.content || ''
          }
        } catch { addSystemNotice('⚠️ 工具执行后总结失败，将尝试后续汇总') }
      }

      if (!finalContent) {
        chatHistory.push({ role: 'user', content: '请根据以上工具调用的实际结果，给用户一个完整的、基于真实数据的总结回复。必须引用工具返回的具体内容，不要编造。不要再调用工具。' })
        try {
          const summaryResult = await apiStore.chatCompletion(chatHistory, true, undefined)
          finalContent = summaryResult.content || '(模型未返回总结)'
        } catch {
          finalContent = '(模型总结请求失败，但工具已执行完毕)'
        }
      }

      if (toolCallSummary.length > 0) {
        addSystemNotice(`🔧 ${toolCallSummary.join(' | ')}`)
      }

      if (finalContent && hasToolCalls) {
        nodeStore.setL1Status('l1-result-beautifier', 'working')
        finalContent = beautify(finalContent)
        nodeStore.setL1Status('l1-result-beautifier', 'success')
      }

      finalContent = stripHtml(finalContent)

      addAssistantMessage(finalContent || '(空回复)')

      if (!hasErrors && executedTools.length > 0) {
        nodeStore.markTaskChainComplete()
        const taskCase: TaskCase = {
          id: `case-${Date.now()}`,
          input: content,
          plan,
          toolsUsed: executedTools,
          success: !hasErrors,
          vector: [],
          createdAt: Date.now()
        }
        saveTaskCase(taskCase)
      }

      // Clear DAG chain after completion
      setTimeout(() => { nodeStore.clearDAGChain() }, 3000)

      generateHistorySummary()

      indexConversationRound(messages.value).catch(() => {})

      if (shouldCompress(messages.value)) {
        const lastSummaryTime = loadSummaries()[loadSummaries().length - 1]?.to || 0
        const newMsgs = messages.value.filter(m => m.timestamp > lastSummaryTime && (m.role === 'user' || (m.role === 'assistant' && m.type === 'text')))
        if (newMsgs.length >= 8) {
          generateHistorySummary()
          const summary = localStorage.getItem('holo-history-summary') || ''
          if (summary) {
            savePeriodSummary(summary, newMsgs[0].timestamp, newMsgs[newMsgs.length - 1].timestamp)
          }
        }
      }

      isProcessing.value = false
      return finalContent
    } catch (err) {
      const errMsg = String(err)
      addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
      debugStore.emitEvent('error', 'tool', `执行失败: ${errMsg}`, errMsg)
      const nodeStore = useNodeStore()
      nodeStore.setL0RedFlash(true)
      isProcessing.value = false
      return ''
    }
  }

  function rejectPlan() {
    pendingPlan.value = null
    pendingContent.value = ''
    awaitingConfirmation.value = false
    pendingMacroManifestId.value = null
    addSystemNotice('❌ 用户取消了执行计划')
  }

  async function confirmTranslatedIntent(): Promise<string> {
    const ti = translatedIntent.value
    if (!ti) return ''
    awaitingIntentConfirm.value = false
    isProcessing.value = true
    addSystemNotice(`✅ 用户确认，执行：${ti.intent}`)
    const nodeStore = useNodeStore()
    const manifest = nodeStore.getL2Manifest(ti.manifestId)
    translatedIntent.value = null

    if (manifest && (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') && manifest.execution.dagPlan) {
      const plan: TaskPlan = {
        intent: ti.intent,
        needs: manifest.routing.keywords.slice(0, 3),
        steps: manifest.execution.dagPlan.steps.map(s => ({
          step: s.step,
          description: s.description,
          tool: s.tool,
          depends_on: s.depends_on,
          params: { ...s.params, ...ti.params },
          expectedOutput: s.expectedOutput,
          fallback: s.fallback
        }))
      }
      nodeStore.setL1Status('l1-task-translator', 'success')
      nodeStore.setL1Status('l1-pipeline-builder', 'success')
      try {
        const macroResult = await executeMacro(manifest, { inputText: ti.originalInput, context: ti.params ? JSON.stringify(ti.params) : '' })
        addSystemNotice(`✅ 执行完成: ${macroResult.lastResult.substring(0, 200)}`)
        isProcessing.value = false
        return macroResult.lastResult
      } catch (err) {
        const errMsg = String(err)
        if (errMsg.startsWith('FactGuard:')) {
          factConflict.value = {
            conflicts: [{ type: 'fact_guard', sourceRaw: '源文件', outputRaw: 'AI输出', diff: errMsg.replace('FactGuard: ', ''), severity: 'critical' }],
            pendingStepNum: 0,
            pendingManifestId: manifest.identity.id
          }
          awaitingFactResolution.value = true
          isProcessing.value = false
          addSystemNotice(`🔴 事实一致性校验失败：${errMsg.replace('FactGuard: ', '')}`)
          return ''
        }
        addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
        debugStore.emitEvent('error', 'tool', `执行失败: ${errMsg}`, errMsg)
        isProcessing.value = false
        return ''
      }
    }

    isProcessing.value = false
    return ''
  }

  function rejectTranslatedIntent() {
    translatedIntent.value = null
    awaitingIntentConfirm.value = false
    addSystemNotice('❌ 用户否定了翻译结果，请重新描述')
  }

  async function submitSlotFill(filledSlots: Record<string, string>): Promise<string> {
    const sc = slotClarification.value
    if (!sc) return ''
    awaitingSlotFill.value = false
    isProcessing.value = true
    addSystemNotice(`✅ 参数已填写，执行：${sc.manifestName}`)
    const nodeStore = useNodeStore()
    const manifest = nodeStore.getL2Manifest(sc.manifestId)
    slotClarification.value = null

    if (manifest && (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') && manifest.execution.dagPlan) {
      const plan: TaskPlan = {
        intent: sc.manifestName,
        needs: manifest.routing.keywords.slice(0, 3),
        steps: manifest.execution.dagPlan.steps.map(s => ({
          step: s.step,
          description: s.description,
          tool: s.tool,
          depends_on: s.depends_on,
          params: { ...s.params, ...filledSlots },
          expectedOutput: s.expectedOutput,
          fallback: s.fallback
        }))
      }
      nodeStore.setL1Status('l1-task-translator', 'success')
      nodeStore.setL1Status('l1-pipeline-builder', 'success')
      const lastUserMsg = messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
      try {
        const macroResult = await executeMacro(manifest, { inputText: lastUserMsg, context: filledSlots ? JSON.stringify(filledSlots) : '' })
        addSystemNotice(`✅ 执行完成: ${macroResult.lastResult.substring(0, 200)}`)
        isProcessing.value = false
        return macroResult.lastResult
      } catch (err) {
        const errMsg = String(err)
        if (errMsg.startsWith('FactGuard:')) {
          factConflict.value = {
            conflicts: [{ type: 'fact_guard', sourceRaw: '源文件', outputRaw: 'AI输出', diff: errMsg.replace('FactGuard: ', ''), severity: 'critical' }],
            pendingStepNum: 0,
            pendingManifestId: manifest.identity.id
          }
          awaitingFactResolution.value = true
          isProcessing.value = false
          addSystemNotice(`🔴 事实一致性校验失败：${errMsg.replace('FactGuard: ', '')}`)
          return ''
        }
        addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
        debugStore.emitEvent('error', 'tool', `执行失败: ${errMsg}`, errMsg)
        isProcessing.value = false
        return ''
      }
    }

    isProcessing.value = false
    return ''
  }

  function cancelSlotFill() {
    slotClarification.value = null
    awaitingSlotFill.value = false
    addSystemNotice('❌ 已取消，请重新描述需求')
  }

  async function pickCandidate(index: number): Promise<string> {
    const list = pendingCandidateList.value
    if (index < 0 || index >= list.length) {
      addSystemNotice('❌ 无效选择，请输入正确编号')
      return ''
    }
    const picked = list[index]
    awaitingCandidatePick.value = false
    pendingCandidateList.value = []
    isProcessing.value = true
    addSystemNotice(`✅ 已选择：${picked.manifestName}（${(picked.score * 100).toFixed(0)}%）`)

    const nodeStore = useNodeStore()
    const manifest = nodeStore.getL2Manifest(picked.manifestId)
    if (!manifest) {
      addSystemNotice('❌ 工具未找到，请重新描述需求')
      isProcessing.value = false
      return ''
    }

    if (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') {
      if (manifest.execution.dagPlan) {
        const plan: TaskPlan = {
          intent: manifest.identity.name,
          needs: manifest.routing.keywords.slice(0, 3),
          steps: manifest.execution.dagPlan.steps.map(s => ({
            step: s.step, description: s.description, tool: s.tool,
            depends_on: s.depends_on, params: s.params,
            expectedOutput: s.expectedOutput, fallback: s.fallback
          }))
        }
        nodeStore.setL1Status('l1-task-translator', 'success')
        nodeStore.setL1Status('l1-pipeline-builder', 'success')
        addSystemNotice(`🟢 RaaP匹配：${manifest.identity.name}（用户选择，置信度${(picked.score * 100).toFixed(0)}%）`)
        const lastUserMsg = messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
        try {
          const macroResult = await executeMacro(manifest, { inputText: lastUserMsg })
          addSystemNotice('✅ 执行完成')
          debugStore.emitEvent('info', 'tool', `执行完成: ${macroResult.lastResult.substring(0, 500)}`, macroResult.lastResult)
          isProcessing.value = false
          return macroResult.lastResult
        } catch (err) {
          const errStr = String(err)
          addSystemNotice(`❌ 执行失败（${classifyError(errStr)}）`)
          debugStore.emitEvent('error', 'tool', `执行失败: ${errStr}`, errStr)
          isProcessing.value = false
          return ''
        }
      }
    } else if (manifest.execution.mode === 'direct' && manifest.execution.directCall) {
      const plan: TaskPlan = {
        intent: manifest.identity.name,
        needs: manifest.routing.keywords.slice(0, 3),
        steps: [{ step: 1, description: manifest.identity.name, tool: 'llm_generate', depends_on: [], params: { prompt: manifest.execution.directCall.promptTemplate }, expectedOutput: manifest.identity.name + '输出' }]
      }
      nodeStore.setL1Status('l1-task-translator', 'success')
      nodeStore.setL1Status('l1-pipeline-builder', 'success')
      addSystemNotice(`🟢 RaaP直调：${manifest.identity.name}（用户选择，置信度${(picked.score * 100).toFixed(0)}%）`)
      pendingPlan.value = plan
      pendingContent.value = messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
      pendingMacroManifestId.value = manifest.identity.id
      acquirePausePoint('confirmation')
      isProcessing.value = false
      const planSummary = `📋 **任务分析 (直调)**\n意图：${plan.intent}\n\n确认执行？`
      addSystemNotice(planSummary)
      return ''
    }

    isProcessing.value = false
    return ''
  }

  function resolveFactConflict(useSource: boolean): void {
    if (!factConflict.value) return
    if (useSource) {
      addSystemNotice('✅ 已使用源文件值覆盖AI输出，继续执行')
    } else {
      addSystemNotice('⚠️ 用户确认保留AI输出值，继续执行')
    }
    factConflict.value = null
    awaitingFactResolution.value = false
  }

  function requestRiskConfirm(action: import('@/models').ActionManifest): Promise<boolean> {
    riskAction.value = action
    acquirePausePoint('riskConfirm')
    return new Promise<boolean>((resolve) => {
      _riskResolve = resolve
      setTimeout(() => {
        if (_riskResolve === resolve) {
          _riskResolve = null
          awaitingRiskConfirm.value = false
          resolve(false)
        }
      }, 5 * 60 * 1000)
    })
  }

  function resolveRiskConfirm(approved: boolean): void {
    awaitingRiskConfirm.value = false
    riskAction.value = null
    if (_riskResolve) {
      _riskResolve(approved)
      _riskResolve = null
    }
  }

  function pauseDagAtStep(stepNum: number, manifestId: string): void {
    acquirePausePoint('dagPaused')
    dagPausedStep.value = stepNum
    dagPausedManifestId.value = manifestId
    addSystemNotice(`⏸️ DAG执行已在步骤${stepNum}暂停，您可以修改参数或人工接管`)
  }

  function resumeDag(): void {
    dagPaused.value = false
    dagPausedStep.value = null
    dagPausedManifestId.value = null
  }

  function requestTakeover(stepNum: number): Promise<string> {
    acquirePausePoint('takeover')
    takeoverStepNum.value = stepNum
    return new Promise<string>((resolve) => {
      _takeoverResolve = resolve
      setTimeout(() => {
        if (_takeoverResolve === resolve) {
          _takeoverResolve = null
          awaitingTakeover.value = false
          resolve('')
        }
      }, 5 * 60 * 1000)
    })
  }

  function submitTakeover(result: string): void {
    awaitingTakeover.value = false
    takeoverStepNum.value = null
    if (_takeoverResolve) {
      _takeoverResolve(result)
      _takeoverResolve = null
    }
  }

  function cancelTakeover(): void {
    awaitingTakeover.value = false
    takeoverStepNum.value = null
    if (_takeoverResolve) {
      _takeoverResolve('')
      _takeoverResolve = null
    }
  }

  async function retryFactConflict(): Promise<void> {
    if (!factConflict.value) return
    addSystemNotice('🔄 尝试用mini模型重新生成...')
    const apiStore = useApiStore()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const resp = await apiStore.chatCompletion(
        [{ role: 'user', content: '请使用源文件中的原始精确数字重新生成，不要修改任何金额、日期或编号。' }],
        false, undefined, 512, controller.signal
      )
      clearTimeout(timer)
          debugStore.emitEvent('info', 'tool', `重新生成结果`, (resp.content || '').substring(0, 500))
    } catch {
      addSystemNotice('❌ 重新生成失败，请选择覆盖或保留')
      return
    }
    factConflict.value = null
    awaitingFactResolution.value = false
  }

  function insertSystemMessage(content: string) {
    addSystemNotice(content)
  }

  function loadFromStorage() {
    try {
      const saved = localStorage.getItem('holo-dialog-messages')
      if (saved) {
        const parsed = JSON.parse(saved) as DialogMessage[]
        if (parsed.length > 0) {
          messages.value = parsed
          const lastMsg = parsed[parsed.length - 1]
          const timeDiff = Date.now() - lastMsg.timestamp
          if (timeDiff > 5 * 60 * 1000) {
            const hoursAgo = Math.floor(timeDiff / 3600000)
            const timeLabel = hoursAgo < 24 ? `${hoursAgo}小时前` : `${Math.floor(hoursAgo / 24)}天前`
            messages.value.push({
              id: `msg-restore-${Date.now()}`,
              role: 'system',
              type: 'system_notice',
              content: `📖 已恢复${timeLabel}的对话（共${parsed.filter(m => m.role === 'user').length}轮），你可以继续追问之前的内容`,
              timestamp: Date.now()
            })
          }
        }
      }
    } catch { /* ignore */ }
    try {
      const savedMode = localStorage.getItem('holo-dialog-mode')
      if (savedMode) mode.value = savedMode as 'command' | 'plan' | 'teach'
    } catch { /* ignore */ }
  }

  function saveToStorage() {
    try {
      const stripped = messages.value.slice(-200).map(m => {
        const copy = { ...m }
        delete (copy as Partial<DialogMessage>).lineage
        return copy
      })
      localStorage.setItem('holo-dialog-messages', JSON.stringify(stripped))
    } catch { /* ignore */ }
    try { localStorage.setItem('holo-dialog-mode', mode.value) } catch { /* ignore */ }
    try {
      const sessionStore = useSessionStore()
      sessionStore.updateActiveMessages(messages.value)
    } catch { /* ignore */ }
  }

  function initSession(): void {
    const sessionStore = useSessionStore()
    const session = sessionStore.initOrLoad()
    if (session.messages.length > 0) {
      messages.value = session.messages
    }
  }

  function syncToSession(): void {
    const sessionStore = useSessionStore()
    sessionStore.updateActiveMessages(messages.value)
  }

  function switchSession(sessionId: string): void {
    const sessionStore = useSessionStore()
    const target = sessionStore.switchToSession(sessionId, messages.value)
    if (!target) return
    messages.value = target.messages || []
    clearAllPausePoints()
    isProcessing.value = false
    saveToStorage()
  }

  function newSession(name?: string): void {
    const sessionStore = useSessionStore()
    sessionStore.updateActiveMessages(messages.value)
    const session = sessionStore.createSession(name)
    sessionStore.switchToSession(session.id, messages.value)
    messages.value = []
    clearAllPausePoints()
    isProcessing.value = false
    saveToStorage()
    useDebugStore().unfreezeBuffer()
  }

  function clearCurrentSession(): void {
    const sessionStore = useSessionStore()
    if (!sessionStore.activeSessionId) return
    sessionStore.clearSession(sessionStore.activeSessionId)
    messages.value = []
    clearAllPausePoints()
    isProcessing.value = false
    saveToStorage()
  }

  function exportCurrentSession(mode: 'qa' | 'narrative'): void {
    const sessionStore = useSessionStore()
    sessionStore.updateActiveMessages(messages.value)
    if (sessionStore.activeSessionId) {
      sessionStore.exportAndDownload(sessionStore.activeSessionId, mode)
    }
  }

  return {
    messages,
    mode,
    isProcessing,
    currentEngine,
    pendingPlan,
    awaitingConfirmation,
    setMode,
    addUserMessage,
    addAssistantMessage,
    addSystemNotice,
    updateMessageContent,
    addToolLogMessage,
    addThoughtMessage,
    sendMessage,
    confirmPlan,
    rejectPlan,
    translatedIntent,
    awaitingIntentConfirm,
    confirmTranslatedIntent,
    rejectTranslatedIntent,
    slotClarification,
    awaitingSlotFill,
    submitSlotFill,
    cancelSlotFill,
    pendingCandidateList,
    awaitingCandidatePick,
    pickCandidate,
    factConflict,
    awaitingFactResolution,
    resolveFactConflict,
    retryFactConflict,
    riskAction,
    awaitingRiskConfirm,
    requestRiskConfirm,
    resolveRiskConfirm,
    dagPaused,
    dagPausedStep,
    dagPausedManifestId,
    pauseDagAtStep,
    resumeDag,
    awaitingTakeover,
    takeoverStepNum,
    requestTakeover,
    submitTakeover,
    cancelTakeover,
    clearAllPausePoints,
    insertSystemMessage,
    loadFromStorage,
    saveToStorage,
    initSession,
    syncToSession,
    switchSession,
    newSession,
    clearCurrentSession,
    exportCurrentSession,
    transientHint,
    showTransientHint,
    lastDecisionContext
  }
})
