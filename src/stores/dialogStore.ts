import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DialogMessage, ThoughtStep, TaskPlan, TaskCase, WorkflowCard, ToolCallLog } from '@/models'
import type { DecisionContext, RewriteStrategy, DisambigStrategy, DetectedDomain, L2ToolManifest } from '@/models'
import { globalBus } from '@/kernel/bus'
import { searchKnowledge, SearchScope } from '@/services/knowledgeBase'
import { planTask, reflectOnResult, saveTaskCase, replan, disambiguateChoice, translateIntent } from '@/services/promptTranslator'
import { executeMacro, resolveDirectPrompt, formatLineage, computeLineageSavings } from '@/services/macroExecutor'
import type { MacroLineage } from '@/services/macroExecutor'
import { beautify } from '@/services/resultBeautifier'
import { contentHash, truncateForLog } from '@/services/scheduleOptimizer'
import { logManifestUsage } from '@/services/proactiveScheduler'
import { selectRewriteStrategy, selectDisambigStrategy, extractStrategyContext } from '@/services/strategySelector'
import { extractEntities } from '@/services/nerExtractor'
import {
  indexConversationRound,
  searchConversationContext,
  getLatestSummary,
  getAllSummaries,
  savePeriodSummary,
  shouldCompress,
  detectChallenge
} from '@/services/convMemory'
import { buildToolIndex, retrieveTopTools, makeSummaryToolList, universalMatch, getTop3Candidates, llmFallback, getTop3CandidatesUniversal, extractCoreKeywords } from '@/services/toolRetrieval'
import type { RaapMatchResult, UniversalMatchResult, MatchableItem } from '@/services/toolRetrieval'
import { tryL0Skill, buildExplorePlan, classifyDomain, tryL05QuickMatch, checkL1Capability } from '@/services/l0SkillRouter'
import type { L0DirectPlan } from '@/services/l0SkillRouter'
import { vault } from '@/vault'
import { registerExamTrace } from '@/exam/examRegistry'
import { kernelRegistry } from '@/host/kernelRuntime'
import type { DefaultKernelContext } from '@/kernels/default'
import { FEEDBACK_RE, SHORT_FEEDBACK_RE } from '@/kernels/default'
import type { DefaultKernelPlugin } from '@/kernels/default/plugin'
import type { CompetitionRecord, FunnelBaseContext, FunnelOutcome } from '@/kernel/funnel'
import {
  runShadowEvaluation,
  qualityEmaStore,
  EMA_OUTCOME_SUCCESS,
  EMA_OUTCOME_FAILURE,
  EMA_OUTCOME_NEGATIVE_FEEDBACK,
  type ShadowAuditEntry
} from '@/kernel/competition'

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

function mapToDetectedDomain(domains: string[]): DetectedDomain {
  if (domains.includes('legal')) return 'legal'
  if (domains.includes('finance')) return 'finance'
  if (domains.includes('hr')) return 'hr'
  return 'general'
}

function userRequestedFile(input: string): boolean {
  return /发送(文件|文档)|发(文件|文档)|word|docx|导出(文件|文档)|保存(为|到)(文件|文档)|写成文件|输出文件/.test(input)
}

import { useSessionStore } from './sessionStore'
import { debugLog } from '@/services/debugLog'
import { newTraceId } from '@/services/trace'
import { NATIVE_TOOL_NAMES } from '@/services/toolRegistry'

function loadSummaries(): { period: string; summary: string; from: number; to: number }[] {
  const raw = vault.readCache('dialog', 'holo-conv-summaries')
  if (raw) {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

const FIXED_SYSTEM_PROMPT = `你是 HoloStarmap 全息星图助手，一个拥有真实工具能力的 AI。

【核心规则 - 必须严格遵守】
1. 你拥有通过 function calling 调用 MCP 工具和 shell_exec 工具的能力。当用户请求需要实际操作时，你【必须】调用对应工具执行，绝不许编造结果。
2. 严禁在没有实际调用工具的情况下声称"已完成"某个操作。如果工具调用失败，如实报告失败原因。
3. 禁止不思考就调用工具。每次调用前必须有明确的理由。
4. 如果用户提供了附件（文件内容已包含在消息中的"=== 文件: xxx ==="标记内），【直接阅读消息中的内容即可】，【不要】再去用 read_file 工具从磁盘读取文件。附件内容已经在你的上下文中了。
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

  // §5.2 统一 traceId：每次用户请求入口生成，随 bus payload 传播至 probe/cost/audit/log-event
  const activeTraceId = ref('')

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
  // B-06：进入候选暂停点时记录触发候选的原始用户输入（完整未截断），
  // pickCandidate 回退用它，不再依赖 slice(-2) 反推（首条消息时 undefined/取到截断内容）
  let _candidateOriginalInput = ''

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

  // B-02：风险确认期间到达的输入排队，确认结束后自动重发（期间不强制解锁 isProcessing）
  const _riskQueuedInputs: string[] = []
  let _riskQueueFlushTimer: ReturnType<typeof setTimeout> | null = null
  let _riskQueueRetries = 0

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

  // B-01：所有暂停点必须经 acquirePausePoint 互斥获取，禁止对 awaiting* 直接置 true
  function acquirePausePoint(point: 'confirmation' | 'intentConfirm' | 'slotFill' | 'candidatePick' | 'factResolution' | 'riskConfirm' | 'dagPaused' | 'takeover'): void {
    clearAllPausePoints()
    switch (point) {
      case 'confirmation': awaitingConfirmation.value = true; break
      case 'intentConfirm': awaitingIntentConfirm.value = true; break
      case 'slotFill': awaitingSlotFill.value = true; break
      case 'candidatePick': awaitingCandidatePick.value = true; break
      case 'factResolution': awaitingFactResolution.value = true; break
      case 'riskConfirm': awaitingRiskConfirm.value = true; break
      case 'dagPaused': dagPaused.value = true; break
      case 'takeover': awaitingTakeover.value = true; break
    }
    // EXAM-2：监考信号——每次暂停点获取即一次用户干预机会
    // （考试器订阅 dialog:pause-acquired 计干预数，见 ACCEPTANCE-SPEC「监考记录字段」）
    try {
      globalBus.emit('dialog:pause-acquired', { point, traceId: activeTraceId.value || undefined, ts: Date.now() })
    } catch { /* non-critical */ }
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

    globalBus.emit('memory:add-dialog-message', {
      role: 'user',
      type: 'text',
      content,
      traceId: activeTraceId.value || undefined
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

    globalBus.emit('memory:add-dialog-message', {
      role: 'assistant',
      type: card ? 'workflow_card' : log ? 'tool_log' : 'text',
      content,
      workflowCard: card,
      toolLog: log,
      traceId: activeTraceId.value || undefined
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
        globalBus.emit('debug:log-probe', { level: 'warn', domain: 'tool', message: '自动docx生成失败', detail: result?.error || '未知错误' })
      }
    } catch (e: unknown) {
      msg.content = content + '\n\n⚠️ 文件导出失败，完整内容如上'
      saveToStorage()
      globalBus.emit('debug:log-probe', { level: 'warn', domain: 'tool', message: '自动docx生成失败', detail: e instanceof Error ? e.message : String(e) })
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
    const selectedNode = globalBus.request('node:get-selected-node', {})
    const selectedInfo = selectedNode
      ? `当前选中节点：${selectedNode.name}(${selectedNode.level})，可用 MCP 工具：${(globalBus.request('mcp:get-tools-as-nodes', {}) as any[]).length} 个`
      : '未选中任何节点'

    currentEngine.value = (globalBus.request('api:get-config', {}) as any)?.activeModel || '未配置'

    globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: 'working' })
    const sessionStore3 = useSessionStore()
    const scope: SearchScope | undefined = sessionStore3.activeSession?.knowledgeGroupId
      ? { groupIds: [sessionStore3.activeSession.knowledgeGroupId] }
      : undefined
    const kbResults = await searchKnowledge(userContent, 5, scope)
    globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: kbResults.length > 0 ? 'success' : 'idle' })
    let kbContext = ''
    if (kbResults.length > 0) {
      kbContext = '\n\n【知识库检索结果 - 以下是与用户问题相关的已投喂文档片段】\n' + kbResults.map((r, i) => `[${i + 1}] ${r}`).join('\n\n')
    }

    const mcpTools = (globalBus.request('mcp:get-tools-as-nodes', {}) as any[]).map(t => ({ name: t.name, description: t.description }))

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
- 当前引擎：${(globalBus.request('api:get-config', {}) as any)?.activeModel || '未配置'} (${globalBus.request('api:is-ready', {}) ? '已连接' : '离线'})
- 已连接 MCP：${(globalBus.request('mcp:get-connections', {}) as any[]).filter(c => c.isConnected).length} 个
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

  function buildMcpTools(): ToolDef[] {
    const tools: ToolDef[] = []
    for (const conn of (globalBus.request('mcp:get-connections', {}) as any[])) {
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
      const localSummary = vault.readCache('dialog', 'holo-history-summary') || ''
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
      const recentMsgs = messages.value.filter(m => m.role === 'user' || (m.role === 'assistant' && m.type === 'text'))
      if (recentMsgs.length < 4) return
      const summaryPrompt = '请用3-5句话概括以下对话的关键信息、用户需求和AI给出的结论。保留具体细节（文件名、数据、结论等），以便后续追问时可以关联：\n'
        + recentMsgs.slice(-20).map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.content.substring(0, 200)}`).join('\n')
      try {
        const result = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: summaryPrompt }], stream: false, tools: undefined, maxTokens: 512 })
        if (result.content) {
          vault.writeThrough('dialog', 'holo-history-summary', result.content)
        }
      } catch { /* ignore */ }
    }
    summaryGenPromise = run().finally(() => { summaryGenPromise = null })
    await summaryGenPromise
  }

  async function executeToolCall(
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
      globalBus.emit('debug:log-probe', { level: 'error', domain: 'shell', message: `命令执行失败(exit code ${result.code})`, detail: result.stderr || result.stdout || '' })
      return `命令执行失败（退出码${result.code}）`
    }

    const sepIdx = fullName.indexOf('___')
    if (sepIdx < 0) throw new Error(`无效工具名: ${fullName}`)
    const mcpIdRaw = fullName.substring(0, sepIdx)
    const toolName = fullName.substring(sepIdx + 3)
    const conn = (globalBus.request('mcp:get-connections', {}) as any[]).find(c => {
      const safeId = c.id.replace(/[^a-zA-Z0-9_-]/g, '_')
      return safeId === mcpIdRaw
    })
    if (!conn) throw new Error(`MCP连接未找到: ${mcpIdRaw}`)
    const result = await globalBus.requestAsync('mcp:call-tool', { connectionId: conn.id, toolName: toolName, args: args })
    return result
  }

  /**
   * P1-25：MCP 直达快速路径的 toolCalls 执行器。
   * 此前三条快速路径只发一次带 tools 的 chat-completion 即展示，从不执行返回的
   * toolCalls（apiStore 不代执行）→ 用户恒见 "(无输出)"。
   * 与主执行循环同口径：逐个 executeToolCall，汇总为可读结果；无 toolCalls 返回 null。
   */
  async function executeMcpToolCalls(toolCalls: { id: string; name: string; arguments: string }[]): Promise<string | null> {
    if (!toolCalls || toolCalls.length === 0) return null
    const outputs: string[] = []
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.arguments) } catch { args = {} }
      const shortName = tc.name.replace(/.*___/, '')
      try {
        const toolResult = await executeToolCall(tc.name, args)
        outputs.push(`【${shortName}】\n${toolResult}`)
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err)
        outputs.push(`【${shortName}】\n❌ 工具调用失败（${classifyError(errStr)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `工具${shortName}调用失败: ${errStr}`, detail: errStr })
      }
      await yieldToUI()
    }
    return outputs.join('\n\n')
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

  // ===== Phase 3 灰度：六层漏斗 shadow 对照（vault 配置 config:holo-funnel-shadow = '1' 开启）=====
  let funnelShadowEnabled: boolean | null = null

  /** 旧路径 debug:log-probe 层信号 → 终点判定（仅层命中级别；暂停点/notice 类终点无法自动判定） */
  function legacyEndpointFromTrail(trail: string[]): string {
    for (let i = trail.length - 1; i >= 0; i--) {
      const m = trail[i]
      if (m.includes('探索模式')) return 'L4'
      if (m.includes('LLM仲裁选中')) return m.includes('MCP工具') ? 'mcp-direct' : 'L3'
      if (m.includes('[Router] RaaP命中') || m.includes('[Router] RaaP直调')) return 'L2'
      if (m.includes('[Router] L1命中')) return 'L1'
      if (m.includes('[Router] L0.5命中')) return 'L0.5'
      if (m.includes('[Router] L0命中')) return 'L0'
    }
    return 'unknown'
  }

  function funnelEndpointOf(outcome: FunnelOutcome): string {
    if (outcome.kind === 'plan') return outcome.source
    return outcome.kind
  }

  /**
   * shadow 对照：与旧六层内联路由并行跑 funnel（kernelRegistry.route），
   * 通过 debug:log-probe 事件流收集旧路径层信号做终点对照，差异 emit `funnel:shadow-diff`。
   * 全程 try/catch + finally 解绑，任何失败不影响主路径。
   */
  async function runFunnelShadow(content: string, allMcpTools: { name: string; description: string }[], recentUserMsg: string): Promise<void> {
    try {
      if (funnelShadowEnabled === null) {
        funnelShadowEnabled = (await vault.read('config', 'holo-funnel-shadow')) === '1'
      }
      if (!funnelShadowEnabled) return

      const started = Date.now()
      const legacyTrail: string[] = []
      const dispose = globalBus.on('debug:log-probe', (payload: { message?: string }) => {
        if (payload?.message) legacyTrail.push(String(payload.message))
      })
      try {
        const allL2 = globalBus.request('node:get-all-l2-manifests', {}) as L2ToolManifest[]
        const lastAssistantMsgs = messages.value.filter(m => m.role === 'assistant')
        const lastAssistantContent = lastAssistantMsgs.length > 0 ? lastAssistantMsgs[lastAssistantMsgs.length - 1].content : ''
        const ctx: DefaultKernelContext = {
          allL2Manifests: allL2,
          mcpTools: allMcpTools.map(t => ({ name: t.name, description: t.description })),
          visibleL2Ids: globalBus.request('node:get-visible-l2-ids', {}) as string[],
          selectedRole: globalBus.request('node:get-selected-role', {}) ?? undefined,
          lastAssistantContent,
          recentUserMsg,
          chatCompletion: async (msgs) => {
            const r = await globalBus.requestAsync('api:chat-completion', { messages: msgs, stream: false, tools: undefined, maxTokens: 128 })
            return { content: (r as { content?: string }).content || '' }
          }
        }
        const outcome = await kernelRegistry.route(content, ctx)
        const legacyEndpoint = legacyEndpointFromTrail(legacyTrail)
        const funnelEndpoint = funnelEndpointOf(outcome)
        // 暂停点类终点旧侧走 system notice（无 log-probe），无法自动判定 → match=null 人工核对
        const unjudgeable = legacyEndpoint === 'unknown' || ['candidates', 'intent-confirm', 'slot-fill'].includes(funnelEndpoint)
        const match = unjudgeable ? null : legacyEndpoint === funnelEndpoint
        const report = {
          input: content.substring(0, 80),
          funnel: {
            kind: outcome.kind,
            source: outcome.kind === 'plan' ? outcome.source : undefined,
            intent: outcome.kind === 'plan' ? outcome.plan.intent : undefined
          },
          legacyEndpoint,
          funnelEndpoint,
          match,
          durationMs: Date.now() - started,
          // C-11：对照报告携带请求级 traceId，浸泡期可与 probe/cost 记录按请求归因
          traceId: activeTraceId.value || undefined
        }
        debugLog(`[funnel:shadow] ${JSON.stringify(report)}`)
        globalBus.emit('funnel:shadow-diff', { ...report, legacyTrail: legacyTrail.slice(-30) })
      } finally {
        dispose()
      }
    } catch (e) {
      debugLog(`[funnel:shadow] 对照失败（不影响主路径）: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ===== Phase 3 灰度第二步（R14/R15）：funnel 主路径适配层（默认开启；vault config:holo-funnel-main = '0' 显式回滚旧路径）=====
  let funnelMainEnabled: boolean | null = null

  async function isFunnelMainEnabled(): Promise<boolean> {
    if (funnelMainEnabled === null) {
      try {
        // R15：默认翻转——未配置（null）即走 funnel 主路径；'0' 为回滚开关（旧六层内联保留为回滚目标 + error 兜底）
        funnelMainEnabled = (await vault.read('config', 'holo-funnel-main')) !== '0'
      } catch {
        funnelMainEnabled = true
      }
    }
    return funnelMainEnabled
  }

  /** R16：工作台导航开关调用——vault 写入后清除闭包缓存，下一条消息即按新值路由 */
  function refreshFunnelMainFlag(): void {
    funnelMainEnabled = null
  }

  // ===== A2-9 / 规格 9.2：pre-output 严格否决 flag（vault config:holo-strict-veto = '1' 开，默认关，无 UI）=====
  let strictVetoEnabled: boolean | null = null

  async function isStrictVetoEnabled(): Promise<boolean> {
    if (strictVetoEnabled === null) {
      try {
        strictVetoEnabled = (await vault.read('config', 'holo-strict-veto')) === '1'
      } catch {
        strictVetoEnabled = false
      }
    }
    return strictVetoEnabled
  }

  /** 开发者经 vault 改写后清除闭包缓存 */
  function refreshStrictVetoFlag(): void {
    strictVetoEnabled = null
  }

  // ===== M16 竞争模式 flag（vault config:holo-competitive-mode = '1' 开，默认关，无 UI——规格 9.1 普通用户不可见）=====
  let competitiveModeEnabled: boolean | null = null

  async function isCompetitiveModeEnabled(): Promise<boolean> {
    if (competitiveModeEnabled === null) {
      try {
        competitiveModeEnabled = (await vault.read('config', 'holo-competitive-mode')) === '1'
      } catch {
        competitiveModeEnabled = false
      }
    }
    return competitiveModeEnabled
  }

  /** 开发者经 vault 改写后清除闭包缓存 */
  function refreshCompetitiveModeFlag(): void {
    competitiveModeEnabled = null
  }

  // ===== M16：请求级竞争记录（生命周期：consumeFunnelOutcome 置位 → EMA 更新消费 / rejectPlan / 下轮消息清理）=====
  let pendingCompetitionRecord: CompetitionRecord | null = null

  /** EMA 更新接线点：执行成功=1.0 / 执行失败=0.0 / 用户负反馈=0.2；消费后记录即清 */
  function applyCompetitionOutcome(outcome: number): void {
    if (!pendingCompetitionRecord) return
    const record = pendingCompetitionRecord
    pendingCompetitionRecord = null
    try {
      qualityEmaStore.update(record.winnerPackId, outcome)
    } catch (err) {
      debugLog(`[competition] EMA 更新失败（不影响主流程）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * M16 影子评估（规格 9.1）：败者 pack 对最终产出只读 wouldVeto 判定。
   * fire-and-forget：不阻塞呈现；内部全捕获，绝不影响主流程。
   * 审计经 bus 桥落 memoryStore.addAuditLog（action: shadow-eval）。
   */
  function dispatchShadowEvaluation(record: CompetitionRecord, payload: unknown): void {
    void (async () => {
      try {
        const kernel = kernelRegistry.getActive() as DefaultKernelPlugin | undefined
        const vetoes = kernel && typeof kernel.getHooks === 'function'
          ? kernel.getHooks().getVetoes('pre-output')
          : []
        await runShadowEvaluation(record.loserPackIds, payload, {
          vetoes,
          auditSink: (entry: ShadowAuditEntry) => {
            globalBus.emit('memory:add-audit-log', {
              userId: 'local',
              action: 'shadow-eval',
              toolId: 'kernel-competition',
              details: JSON.stringify({ packId: entry.packId, wouldVeto: entry.wouldVeto, ...(entry.severity ? { severity: entry.severity } : {}), ...(entry.reason ? { reason: entry.reason } : {}), ts: entry.ts })
            })
          }
        })
      } catch (err) {
        debugLog(`[competition] 影子评估异常（不影响主流程）: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  /**
   * A2-9 / M6.5：执行输出统一呈现点（pre-output 否决门）。
   * 拦截 → 复用 blocked UI（⛔ 否决门拦截），不 addAssistantMessage——blocked 输出自然不入会话记忆；
   * 放行 → addAssistantMessage。返回 true = 已呈现；false = 被拦截。
   * 无 runPreOutputGate 方法的内核（前向兼容）与门自身异常（fail-open）均直接放行。
   */
  async function presentExecutionOutput(finalText: string, lineage?: MacroLineage): Promise<boolean> {
    try {
      const kernel = kernelRegistry.getActive() as DefaultKernelPlugin | undefined
      if (kernel && typeof kernel.runPreOutputGate === 'function') {
        const gateCtx: FunnelBaseContext = { strictVeto: await isStrictVetoEnabled() }
        const report = kernel.runPreOutputGate(finalText, gateCtx)
        for (const w of report.warnings) console.warn(`[dialog] pre-output ${w}`)
        if (report.blocked || report.humanJudgmentPrompts.length > 0) {
          const reasons = report.entries.filter(e => e.severity === 'block').map(e => e.reason)
            .concat(report.humanJudgmentPrompts).join('；')
          addSystemNotice(`⛔ 否决门拦截：${reasons || '人工复核'}`)
          return false
        }
      }
    } catch (err) {
      debugLog(`[funnel:main] pre-output 门异常（fail-open 放行）: ${err instanceof Error ? err.message : String(err)}`)
    }
    addAssistantMessage(finalText, undefined, undefined, undefined, undefined, lineage)
    // M16：竞争胜者执行成功 → EMA outcome = 1.0（无竞争记录时无操作）
    applyCompetitionOutcome(EMA_OUTCOME_SUCCESS)
    return true
  }

  /** 旧各层确认摘要文案复刻（matchMethod/gate/置信度等 FunnelOutcome 不携带的字段已简化，偏差记录于 R14） */
  function funnelPlanSummary(source: string, plan: TaskPlan, macroManifestId: string | null): string {
    const stepsText = plan.steps.map(s => `${s.step}. ${s.description} → ${s.tool}`).join('\n')
    if (source === 'L0') return `📋 **L0 Skill直通 (简单任务)**\n意图：${plan.intent}\n\n**执行计划：**\n${stepsText}\n\n确认执行？`
    if (source === 'L0.5') return `📋 **L0.5快速匹配 (单步manifest)**\n意图：${plan.intent}\nManifest：${macroManifestId ?? ''}\n\n**执行计划：**\n${stepsText}\n\n确认执行？`
    if (source === 'L1') return `📋 **L1管道直通 (单节点)**\n意图：${plan.intent}\n节点：${plan.needs[0] ?? ''}\n\n**执行计划：**\n${stepsText}\n\n确认执行？`
    if (source === 'L4') return `📋 **探索模式 (L1临时编排)**\n意图：${plan.intent}\n\n**执行计划：**\n${stepsText}\n\n确认执行？`
    const depsText = plan.steps.map(s => {
      const deps = s.depends_on.length > 0 ? `（依赖步骤${s.depends_on.join(',')}）` : ''
      return `${s.step}. ${s.description} → ${s.tool} ${deps}`
    }).join('\n')
    return `📋 **任务分析 (DAG)**\n意图：${plan.intent}\n需要：${plan.needs.join('、')}\n\n**执行计划：**\n${depsText}\n\n请确认是否按此计划执行？`
  }

  /**
   * FunnelOutcome → UI 动作分派（通知/暂停点状态机/执行）。
   * 返回 true = 已接管本轮消息；false = 回退旧六层内联路径（error 兜底）。
   */
  async function consumeFunnelOutcome(content: string, outcome: FunnelOutcome, allMcpTools: ToolDef[]): Promise<boolean> {
    if (outcome.kind === 'error') {
      debugLog(`[funnel:main] 未接管（${outcome.error}），回退旧六层内联路由`)
      return false
    }
    if (outcome.kind === 'blocked') {
      const reasons = outcome.veto.entries.filter(e => e.severity === 'block').map(e => e.reason)
        .concat(outcome.veto.humanJudgmentPrompts).join('；')
      addSystemNotice(`⛔ 否决门拦截：${reasons || '人工复核'}`)
      isProcessing.value = false
      return true
    }
    if (outcome.kind === 'budget-blocked') {
      addSystemNotice(`⛔ LLM 预算受限：${outcome.reason}`)
      isProcessing.value = false
      return true
    }
    if (outcome.kind === 'candidates') {
      const candList = outcome.candidates.map((c, i) => `${i + 1}. ${c.name}（${(c.score * 100).toFixed(0)}%）`).join('\n')
      addSystemNotice(`🟡 匹配到多个候选，请选择：\n${candList}\n\n输入编号选择，或重新描述你的需求`)
      pendingCandidateList.value = outcome.candidates.map(c => ({ manifestId: c.id, manifestName: c.name, score: c.score }))
      _candidateOriginalInput = content
      acquirePausePoint('candidatePick')
      isProcessing.value = false
      return true
    }
    if (outcome.kind === 'intent-confirm') {
      const params: Record<string, string> = {}
      for (const [k, v] of Object.entries(outcome.params)) params[k] = String(v)
      const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')
      translatedIntent.value = { intent: outcome.intent, manifestId: outcome.manifestId, params, originalInput: outcome.originalInput }
      acquirePausePoint('intentConfirm')
      addSystemNotice(`🟡 Agent翻译：你的意图是"${outcome.intent}"${paramStr ? '，参数：' + paramStr : ''}\n\n确认执行？`)
      isProcessing.value = false
      return true
    }
    if (outcome.kind === 'slot-fill') {
      const missing = outcome.slots.filter(s => s.required && !s.value)
      slotClarification.value = { manifestId: outcome.manifestId, manifestName: outcome.manifestName, slots: outcome.slots }
      acquirePausePoint('slotFill')
      addSystemNotice(`🔴 缺少必填参数：${missing.map(s => s.name).join('、')}\n请填写以下信息：`)
      isProcessing.value = false
      return true
    }
    if (outcome.kind === 'mcp-direct') {
      const matched = allMcpTools.find(t => t.name === outcome.toolName)
      if (matched) {
        if (outcome.source === 'L2') {
          addSystemNotice(`🎯 自动匹配工具：**${matched.name.replace(/.*___/, '')}**`)
        }
        try {
          const apiResult = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content }], stream: true, tools: [matched] }) as { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }
          if (apiResult) {
            // P1-25：执行模型返回的 toolCalls（此前从不执行 → 恒显"(无输出)"）
            const toolOutput = await executeMcpToolCalls(apiResult.toolCalls || [])
            if (toolOutput != null) {
              await presentExecutionOutput(toolOutput)
            } else {
              await presentExecutionOutput(apiResult.content || '(模型未发起工具调用)')
            }
          }
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e)
          addAssistantMessage(`❌ 工具调用失败（${classifyError(errStr)}）`)
          globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `工具调用失败: ${errStr}`, detail: errStr })
        }
      } else {
        // B-15：工具名未命中 allMcpTools 时不能静默——用户消息被消费却无任何回复
        addAssistantMessage(`❌ 工具 ${outcome.toolName} 当前不可用（未连接或已被移除），请重试或换个描述`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `[Router] mcp-direct 未命中工具: ${outcome.toolName}` })
      }
      isProcessing.value = false
      return true
    }

    // ===== kind === 'plan'：层来源通知 + 自检/thought（L2/L3）+ 确认暂停/自动执行 =====
    const { plan, macroManifestId, autoExecutable, source } = outcome
    // M16：捕获竞争记录（请求级隔离：仅本轮 plan 携带时置位；影子评估用最终 plan 作 payload）
    pendingCompetitionRecord = outcome.competition ?? null
    if (outcome.competition) {
      dispatchShadowEvaluation(outcome.competition, plan)
    }
    globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] funnel(${source}) → ${plan.intent} | macro=${macroManifestId ?? '无'} | auto=${autoExecutable}${outcome.competition ? ` | competition: winner=${outcome.competition.winnerPackId} losers=${outcome.competition.loserPackIds.join(',')}` : ''}` })
    globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
    if (source !== 'L1') {
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
    }

    if (source === 'L0') {
      addSystemNotice(`⚡ L0 Skill直通：${plan.intent}（${plan.needs.join('/')}域，${plan.steps.length}步L1执行）`)
    } else if (source === 'L0.5') {
      const allL2 = globalBus.request('node:get-all-l2-manifests', {}) as L2ToolManifest[]
      const m = allL2.find(x => x.identity.id === macroManifestId)
      addSystemNotice(`⚡ L0.5快速匹配：${m?.identity.name ?? plan.intent}（置信≥80%）`)
      if (autoExecutable) addSystemNotice('⚡ L0.5高置信自动执行（无shell操作）')
    } else if (source === 'L1') {
      addSystemNotice(`🔧 L1管道直通：${plan.needs[0] ?? ''}（置信≥60%）`)
    } else if (source === 'L4') {
      addSystemNotice(`🤔 RaaP未命中，进入探索模式：${plan.intent}`)
      if (autoExecutable) addSystemNotice('⚡ L0 Skill自动执行（无shell操作）')
    } else if (macroManifestId) {
      const allL2 = globalBus.request('node:get-all-l2-manifests', {}) as L2ToolManifest[]
      const m = allL2.find(x => x.identity.id === macroManifestId)
      addSystemNotice(`🟢 RaaP匹配：${m?.identity.name ?? plan.intent}（${source === 'L3' ? 'LLM仲裁' : '检索'}）`)
    }

    // L2/L3 → 与旧路径一致：计划自检 + 思维链（L0/L0.5/L1/L4 早退不加）
    if (source === 'L2' || source === 'L3') {
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
      await yieldToUI()
    }

    pendingPlan.value = plan
    pendingContent.value = content
    pendingMacroManifestId.value = macroManifestId

    if (autoExecutable) {
      isProcessing.value = false
      await confirmPlan()
      return true
    }

    acquirePausePoint('confirmation')
    isProcessing.value = false
    addSystemNotice(funnelPlanSummary(source, plan, macroManifestId))
    return true
  }

  /**
   * 主路径：六层路由经 kernelRegistry.route，outcome 由适配层消费（通知/暂停点/执行）。
   * 返回 true = 已接管；false = 回退旧六层内联路径（funnel error 或适配层异常兜底）。
   */
  async function routeViaFunnel(content: string, allMcpTools: ToolDef[], recentUserMsg: string): Promise<boolean> {
    try {
      const allL2 = globalBus.request('node:get-all-l2-manifests', {}) as L2ToolManifest[]
      const lastAssistantMsgs = messages.value.filter(m => m.role === 'assistant')
      const lastAssistantContent = lastAssistantMsgs.length > 0 ? lastAssistantMsgs[lastAssistantMsgs.length - 1].content : ''
      const ctx: DefaultKernelContext = {
        allL2Manifests: allL2,
        mcpTools: allMcpTools.map(t => ({ name: t.name, description: t.description })),
        visibleL2Ids: globalBus.request('node:get-visible-l2-ids', {}) as string[],
        selectedRole: globalBus.request('node:get-selected-role', {}) ?? undefined,
        lastAssistantContent,
        recentUserMsg,
        isEmptyInput: content.trim() === '',
        // A2-9：pre-execute 门（funnel :201）与 pre-output 门共用严格否决 flag
        strictVeto: await isStrictVetoEnabled(),
        // M16：竞争模式 flag（默认关）——L2 跨 pack 歧义候选竞标分竞争
        competitiveMode: await isCompetitiveModeEnabled(),
        chatCompletion: async (msgs) => {
          const r = await globalBus.requestAsync('api:chat-completion', { messages: msgs, stream: false, tools: undefined, maxTokens: 128 })
          return { content: (r as { content?: string }).content || '' }
        }
      }
      const outcome = await kernelRegistry.route(content, ctx)
      const handled = await consumeFunnelOutcome(content, outcome, allMcpTools)
      // 观测事件（R16）：工作台运行时面板订阅渲染最近路由结果
      // C-11：携带请求级 traceId（数据层归因，显示渲染不做）
      globalBus.emit('funnel:routed', {
        handled,
        kind: outcome.kind,
        source: outcome.kind === 'plan' ? outcome.source : undefined,
        intent: outcome.kind === 'plan' ? outcome.plan.intent : undefined,
        autoExecutable: outcome.kind === 'plan' ? outcome.autoExecutable : undefined,
        ts: Date.now(),
        traceId: activeTraceId.value || undefined
      })
      return handled
    } catch (e) {
      debugLog(`[funnel:main] 主路径异常，回退旧六层内联路由: ${e instanceof Error ? e.message : String(e)}`)
      globalBus.emit('funnel:routed', { handled: false, kind: 'exception', ts: Date.now(), traceId: activeTraceId.value || undefined })
      return false
    }
  }

  async function sendMessage(content: string, isQueuedReplay = false, opts?: { taskType?: 'exam' }): Promise<string> {
    if (content.trim() === '/debug') {
      if (globalBus.request('debug:is-enabled', {})) {
        globalBus.emit('debug:deactivate', {})
        addSystemNotice('🔍 调试模式已关闭')
      } else {
        globalBus.emit('debug:activate', {})
        globalBus.emit('debug:update-environment', { environment: {
          model: (globalBus.request('api:get-config', {}) as any)?.activeModel || '',
          provider: (globalBus.request('api:get-config', {}) as any)?.activeProviderId || '',
          apiReachable: globalBus.request('api:is-ready', {}),
          nodeCount: (globalBus.request('node:get-nodes', {}) as any[]).length,
          manifestCount: Object.keys(globalBus.request('node:get-all-l2-manifests', {}) || {}).length
        } })
        addSystemNotice('🔍 调试模式已开启 — 输入 /debug 关闭')
      }
      isProcessing.value = false
      return ''
    }
    // §5.2：用户请求入口生成 traceId（须在 addUserMessage 之前，消息落记忆时携带）
    activeTraceId.value = newTraceId()
    // EXAM-1：考试发题入口——traceId 注册进 exam 注册表，
    // apiStore 反查识别 exam 流量做学习回路隔离（record-cost 照常记账供监考归因）
    if (opts?.taskType === 'exam') registerExamTrace(activeTraceId.value)
    // M16：上一轮存在竞争记录时——负反馈消息 → EMA outcome = 0.2；其余新消息 → 记录作废
    if (pendingCompetitionRecord) {
      if (FEEDBACK_RE.test(content) || (content.length < 30 && SHORT_FEEDBACK_RE.test(content))) {
        applyCompetitionOutcome(EMA_OUTCOME_NEGATIVE_FEEDBACK)
      } else {
        pendingCompetitionRecord = null
      }
    }
    // B-02：排队重发时消息已在首次入队时 addUserMessage，跳过避免重复
    if (!isQueuedReplay) addUserMessage(content)
    try {
      globalBus.emit('debug:log-probe', { level: 'info', domain: 'dialog', message: `[Dialog] 用户发送消息: ${content.substring(0, 100)}`, traceId: activeTraceId.value })
    } catch { /* non-critical */ }
    if (awaitingRiskConfirm.value) {
      // B-02：不再强制 isProcessing=false——那会解锁输入框并发第二条 sendMessage，
      // 造成并行计划执行、消息数组交错、DAG 状态污染；改为排队，确认结束后自动重发
      _riskQueuedInputs.push(content)
      showTransientHint('⏳ 请先在确认条上裁决风险操作，这条消息已排队')
      return ''
    }
    // P1-46：候选工具选择期无专属输入通道——纯数字输入映射候选编号；其他输入则放弃候选、按新请求处理
    if (awaitingCandidatePick.value) {
      const trimmed = content.trim()
      const num = Number(trimmed)
      if (trimmed !== '' && !Number.isNaN(num)) {
        isProcessing.value = false
        // B-06：用暂停点记录的完整原始输入，不再从消息数组 slice(-2) 反推
        // （首条消息时 undefined 回退空串、且取到的是截断后的展示内容）。
        // 若状态被外部直接设置（如恢复/持久化场景）导致未采集，退回历史倒数第二条还原
        let originalInput = _candidateOriginalInput
        _candidateOriginalInput = ''
        if (!originalInput) {
          const prevMsg = messages.value[messages.value.length - 2]
          if (prevMsg && prevMsg.role === 'user') originalInput = prevMsg.content
        }
        return pickCandidate(num - 1, originalInput)
      }
      awaitingCandidatePick.value = false
      pendingCandidateList.value = []
      _candidateOriginalInput = ''
      addSystemNotice('ℹ️ 已放弃候选选择，按新请求处理')
    }
    isProcessing.value = true

    await yieldToUI()

    if (!globalBus.request('api:is-ready', {})) {
      if ((globalBus.request('api:get-config', {}) as any)?.activeProviderId && (globalBus.request('api:get-config', {}) as any)?.activeModel) {
        const ok = await globalBus.requestAsync('api:check-connection', {})
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
      const allMcpTools = buildMcpTools()
      await yieldToUI()

      const variableContext = await buildVariableContext(content)
      await yieldToUI()

      // ===== Phase A: Plan =====
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'working' })

      const mcpToolNames = allMcpTools.map(t => t.name.replace(/.*___/, ''))
      const recentUserMsgs = messages.value.filter(m => m.role === 'user')
      const recentUserMsg = recentUserMsgs.length > 1 ? recentUserMsgs[recentUserMsgs.length - 2].content : ''

      // Phase 3 灰度第二步（R14/R15）：默认走 funnel 主路径（'0' 回滚旧内联）；error/异常回退下方旧路径兜底
      if (await isFunnelMainEnabled()) {
        if (await routeViaFunnel(content, allMcpTools, recentUserMsg)) return ''
      } else {
        // 回滚模式（config:holo-funnel-main='0'）：仅跑 shadow 对照；emit 路由事件供工作台观测（handled=false 表示走旧路径）
        globalBus.emit('funnel:routed', { handled: false, kind: 'funnel-disabled', ts: Date.now(), traceId: activeTraceId.value || undefined })
        void runFunnelShadow(content, allMcpTools, recentUserMsg)
      }

      let plan: TaskPlan | undefined = undefined
      let macroManifestId: string | null = null

      // ===== L0 Skill: 简单命令直通L1，跳过RaaP =====
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'working' })
      const l0Plan = await tryL0Skill(content)
      if (l0Plan) {
        const domains = classifyDomain(content)
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
        addSystemNotice(`⚡ L0 Skill直通：${l0Plan.intent}（${domains.join('/')}域，${l0Plan.steps.length}步L1执行）`)

        globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] L0命中 → ${l0Plan.intent} | ${domains.join('/')}域 | ${l0Plan.steps.length}步` })

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

      globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] L0未命中 → 进入L0.5检查 | input="${content.substring(0, 50)}"` })

      // ===== L0.5 Quick Match: 关键词快照直通单步manifest =====
      const allL2 = globalBus.request('node:get-all-l2-manifests', {})
      const l05Result = tryL05QuickMatch(content, allL2)
      if (l05Result && l05Result.confidence >= 0.8) {
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
        const m = l05Result.manifest
        addSystemNotice(`⚡ L0.5快速匹配：${m.identity.name}（关键词${l05Result.matchedKeywords.join(',')}命中，置信${(l05Result.confidence * 100).toFixed(0)}%）`)

        globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] L0.5命中 → ${m.identity.id} | 置信${(l05Result.confidence * 100).toFixed(0)}% | 关键词: ${l05Result.matchedKeywords.join(',')}` })

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
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
        addSystemNotice(`🔧 L1管道直通：${l1Check.nodeName}（置信${(l1Check.confidence * 100).toFixed(0)}%）`)

        globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] L1命中 → ${l1Check.nodeId} | 置信${(l1Check.confidence * 100).toFixed(0)}%` })

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

      globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] L0.5/L1均未命中 → 进入RaaP | input="${content.substring(0, 50)}"` })

      // ===== RaaP: Retrieval-as-Planning (zero LLM for matching) =====
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'working' })
      const toolIndex = await buildToolIndex(allMcpTools.map(t => ({
        name: t.name,
        description: t.description
      })), allL2)

      const retrievalFilter = {
        visibleL2Ids: globalBus.request('node:get-visible-l2-ids', {}) as string[],
        selectedRole: globalBus.request('node:get-selected-role', {}) ?? undefined
      }

      let raapResult: RaapMatchResult | null = null
      let universalResult: UniversalMatchResult | null = null

      const lastAssistantMsgs = messages.value.filter(m => m.role === 'assistant')
      const lastAssistantContent = lastAssistantMsgs.length > 0 ? lastAssistantMsgs[lastAssistantMsgs.length - 1].content : ''
      const isLikelyFeedback = lastAssistantContent.length > 50 && /没有|不存在|找不到|不行|错误|失败|没看到|没找到|搞错了|不对|不是/i.test(content)
      const isShortFeedback = content.length < 30 && /没有|不行|不对|错误|失败|找不到|不是/i.test(content)

      debugLog(`[Dialog] sendMessage: "${content.substring(0, 80)}"`)
      debugLog(`[Dialog] isLikelyFeedback=${isLikelyFeedback} isShortFeedback=${isShortFeedback} lastAssistantLen=${lastAssistantContent.length}`)

      const detectedDomain = mapToDetectedDomain(classifyDomain(content))

      if (isLikelyFeedback || isShortFeedback) {
        debugLog('[Dialog] 跳过RaaP，作为反馈处理')
        raapResult = null
      } else {
        try {
          let rewriteStrategy: RewriteStrategy = 'none'
          let activeQuery = content
          let wasRewritten = false
          let rewrittenQuery: string | undefined

          universalResult = await universalMatch(content, toolIndex, retrievalFilter)

          const strategyCtx = extractStrategyContext({
            content,
            entities: extractEntities(content),
            constraintResults: [],
            detectedDomain,
            initialMatchFailed: !universalResult,
            keywordCount: extractCoreKeywords(content).length
          })

          if (!universalResult) {
            rewriteStrategy = selectRewriteStrategy(strategyCtx)
            if (rewriteStrategy === 'keyword_extract') {
              const keywords = extractCoreKeywords(content)
              if (keywords.length > 0) {
                activeQuery = keywords.join(' ')
                wasRewritten = true
                rewrittenQuery = activeQuery
                globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: `关键词提取: "${content.substring(0, 40)}" → "${activeQuery}"` })
                universalResult = await universalMatch(activeQuery, toolIndex, retrievalFilter)
              }
            }
          }

          lastDecisionContext.value = {
            rewriteStrategy,
            wasRewritten,
            originalQuery: content,
            rewrittenQuery,
            matchResult: universalResult?.item.name || '',
            gate: universalResult?.gate || 'red',
            detectedDomain,
            strategyContextSnapshot: {
              contentLength: strategyCtx.contentLength,
              keywordCount: strategyCtx.keywordCount,
              lawArticleCount: strategyCtx.lawArticleCount,
              financeTermCount: strategyCtx.financeTermCount
            }
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
                _candidateOriginalInput = content
                acquirePausePoint('candidatePick')
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
                  const apiResult = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content }], stream: true, tools: [matchedMcpTool] }) as { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }
                  if (apiResult) {
                    // P1-25：此前把整个 result 对象当 content 存库，且从不执行 toolCalls
                    const toolOutput = await executeMcpToolCalls(apiResult.toolCalls || [])
                    if (toolOutput != null) {
                      addAssistantMessage(toolOutput)
                    } else {
                      addAssistantMessage(apiResult.content || '(模型未发起工具调用)')
                    }
                  }
                } catch (e) {
                  const errStr = e instanceof Error ? e.message : String(e)
                  addAssistantMessage(`❌ 工具调用失败（${classifyError(errStr)}）`)
                  globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `工具调用失败: ${errStr}`, detail: errStr })
                }
                isProcessing.value = false
                return ''
              }
            }
          }
        } catch (e) {
          const errStr = e instanceof Error ? e.message : String(e)
          debugLog(`[Dialog] RaaP retrieval failed: ${errStr}`)
          globalBus.emit('debug:log-probe', { level: 'error', domain: 'raap', message: `混合检索异常: ${errStr}`, detail: errStr })
        }
      }

      if (raapResult && raapResult.isAmbiguous) {
        if (raapResult.gate === 'yellow') {
          const cands = raapResult.candidates || []
          const disambigCtx = extractStrategyContext({
            content,
            entities: [],
            constraintResults: [],
            detectedDomain,
            initialMatchFailed: true,
            candidates: cands.map(c => ({ score: c.score, targetRoles: c.manifest.routing.targetRoles }))
          })
          const disambigStrategy = selectDisambigStrategy(disambigCtx)
          if (lastDecisionContext.value) {
            lastDecisionContext.value.disambigStrategy = disambigStrategy
          }

          switch (disambigStrategy) {
            case 'show_candidates': {
              if (cands.length > 1) {
                const candList = cands.slice(0, 5).map((c, i) => `${i + 1}. ${c.manifest.identity.name}（${(c.score * 100).toFixed(0)}%，${c.method === 'keyword' ? '关键词' : '向量'}）`).join('\n')
                addSystemNotice(`🟡 RaaP匹配到多个候选，请选择：\n${candList}\n\n输入编号选择，或重新描述你的需求`)
                pendingCandidateList.value = cands.slice(0, 5).map(c => ({ manifestId: c.manifest.identity.id, manifestName: c.manifest.identity.name, score: c.score }))
                _candidateOriginalInput = content
                acquirePausePoint('candidatePick')
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
            case 'auto_pick': {
              const top = cands[0]
              if (top) {
                raapResult = {
                  manifest: top.manifest,
                  confidence: top.score,
                  matchMethod: top.method === 'keyword' ? 'keyword' : top.method === 'vector' ? 'vector' : 'model',
                  isAmbiguous: false,
                  gate: 'green'
                }
                globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: `ZOL策略auto_pick选中: ${top.manifest.identity.name}` })
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
                _candidateOriginalInput = content
                acquirePausePoint('candidatePick')
                isProcessing.value = false
                return ''
              }
              raapResult = null
              break
            }
            case 'fallback_l1': {
              const l1Cap = checkL1Capability(content)
              if (l1Cap) {
                globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: 'MAB选择降级到L1管道' })
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
              globalBus.emit('debug:log-probe', { level: 'warn', domain: 'raap', message: `RaaP红色gate，尝试LLM仲裁（${fbCandidates.length}个候选）` })
              const fbItem = await llmFallback(content, fbCandidates, async (msgs) => {
                const r = await globalBus.requestAsync('api:chat-completion', { messages: msgs as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null }[], stream: false, tools: undefined, maxTokens: 128 })
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
                  globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: `LLM仲裁选中: ${fbItem.name}` })
                } else if (fbItem.source === 'mcp') {
                  const mcpToolName = fbItem.id
                  const matchedMcpTool = allMcpTools.find(t => t.name === mcpToolName)
                  if (matchedMcpTool) {
                    globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: `LLM仲裁选中MCP工具: ${fbItem.name}，直接调用` })
                    try {
                      const apiResult = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content }], stream: true, tools: [matchedMcpTool] }) as { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }
                      if (apiResult) {
                        // P1-25：执行 LLM 仲裁选中的 MCP 工具调用（此前从不执行）
                        const toolOutput = await executeMcpToolCalls(apiResult.toolCalls || [])
                        if (toolOutput != null) {
                          addAssistantMessage(toolOutput)
                        } else {
                          addAssistantMessage(apiResult.content || '(模型未发起工具调用)')
                        }
                      }
                    } catch (e) {
                      const errStr = e instanceof Error ? e.message : String(e)
                      addAssistantMessage(`❌ 工具调用失败（${classifyError(errStr)}）`)
                      globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `工具调用失败: ${errStr}`, detail: errStr })
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
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] RaaP+LLM仲裁均未命中 → 探索模式 | input="${content.substring(0, 50)}"` })
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
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
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
        globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] RaaP命中 → ${raapResult.manifest.identity.id} | ${methodLabel} | gate=${raapResult.gate} | 置信${(raapResult.confidence * 100).toFixed(0)}% | 节省~${raapResult.manifest.cacheMeta.estimatedTokenSaving} tokens` })
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
        globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `[Router] RaaP直调 → ${raapResult.manifest.identity.id} | ${methodLabel} | gate=${raapResult.gate} | 置信${(raapResult.confidence * 100).toFixed(0)}%` })
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

      if (!plan) {
        isProcessing.value = false
        return ''
      }

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
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
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
      globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `执行失败: ${errMsg}`, detail: errMsg })
      globalBus.emit('node:set-l0-red-flash', { value: true })
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
      globalBus.emit('debug:log-probe', { level: 'info', domain: 'dialog', message: `[Dialog] 确认执行计划: macroId=${macroId || 'none'}, steps=${plan.steps?.length || 0}` })
    } catch { /* non-critical */ }

    // ===== Native tools fast path (0 LLM tokens) =====
    // P1-17：统一走 toolRegistry 的原生工具表（新增 list_directory）
    const NATIVE_TOOLS = NATIVE_TOOL_NAMES
    const isAllNative = plan.steps.length > 0 && plan.steps.every(s => NATIVE_TOOLS.has(s.tool))
    if (isAllNative) {
      addSystemNotice('✅ 用户确认，直接执行原生工具...')
      const stepResults: Record<number, string> = {}
      let lastResult = ''
      let allOk = true

      for (const s of plan.steps) {
        const depsOk = s.depends_on.every(d => stepResults[d] !== undefined)
        if (!depsOk) {
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `跳过步骤${s.step}: 依赖未满足` })
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
          const result = await callToolDirectWithTier(s.tool, resolvedParams, undefined, undefined, undefined, stepResults, { inputText: content }, activeTraceId.value)
          stepResults[s.step] = result
          lastResult = result
          addSystemNotice(`✓ 步骤${s.step}完成`)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          addSystemNotice(`✗ 步骤${s.step}失败（${classifyError(errMsg)}）: ${errMsg.substring(0, 120)}`)
          globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `步骤${s.step}失败: ${errMsg}`, detail: errMsg })
          allOk = false
          break
        }
      }

      if (allOk && lastResult) {
        const finalText = stripHtml(beautify(lastResult))
        await presentExecutionOutput(finalText)
      } else if (!allOk) {
        // M16：竞争胜者执行失败（步骤 break）→ EMA outcome = 0.0
        applyCompetitionOutcome(EMA_OUTCOME_FAILURE)
      }
      globalBus.emit('node:mark-task-chain-complete', {})
      isProcessing.value = false
      return lastResult || ''
    }

    // ===== Direct mode shortcut =====
    const macroManifest = macroId ? globalBus.request<L2ToolManifest | null>('node:get-l2-manifest', { id: macroId }) : null
    if (macroManifest && macroManifest.execution.mode === 'direct' && macroManifest.execution.directCall) {
      addSystemNotice('✅ 用户确认，执行直调模式...')
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })
      try {
        const directInfo = resolveDirectPrompt(macroManifest, {
          inputText: content,
          context: content
        })
        if (directInfo) {
          const resp = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: directInfo.prompt }], stream: true, tools: undefined, maxTokens: directInfo.maxTokens })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'success' })
          const finalText = stripHtml(beautify(resp.content || '(无输出)'))
          await presentExecutionOutput(finalText)
          globalBus.emit('node:mark-task-chain-complete', {})
          isProcessing.value = false
          return finalText
        }
      } catch (err) {
        const errStr = String(err)
        addSystemNotice(`❌ 直调失败（${classifyError(errStr)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `直调失败: ${errStr}`, detail: errStr })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'error' })
        // M16：竞争胜者执行失败（直调抛错）→ EMA outcome = 0.0
        applyCompetitionOutcome(EMA_OUTCOME_FAILURE)
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
      const l2Nodes = (globalBus.request('node:get-nodes', {}) as any[]).filter(n => n.level === 'L2')
      globalBus.emit('node:set-dag-chain', { steps: dagSteps.map(s => ({
        nodeId: l2Nodes.find(n => n.id === macroManifest.identity.id)?.id || macroManifest.identity.id,
        stepNum: s.step,
        status: 'pending' as const
      })), dependsOnMap: dependsOnMap })

      try {
        const macroResult = await executeMacro(
          macroManifest,
          { inputText: content, context: content },
          (stepNum, tool) => {
            globalBus.emit('node:update-dag-step', { stepNum: stepNum, status: 'running' })
            addSystemNotice(`▶ 步骤${stepNum}: ${tool}`)
          },
          (stepNum, result) => {
            globalBus.emit('node:update-dag-step', { stepNum: stepNum, status: 'done' })
            addSystemNotice(`✓ 步骤${stepNum}完成`)
          },
          (stepNum, error) => {
            globalBus.emit('node:update-dag-step', { stepNum: stepNum, status: 'failed' })
            addSystemNotice(`✗ 步骤${stepNum}失败（${classifyError(error)}）: ${String(error).substring(0, 120)}`)
            globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `步骤${stepNum}失败: ${error}`, detail: error })
          },
          (stepNum) => {
            globalBus.emit('node:update-dag-step', { stepNum: stepNum, status: 'reuse' })
            globalBus.emit('debug:log-probe', { level: 'info', domain: 'cache', message: `步骤${stepNum}复用缓存结果` })
            // node:visual-event 频道随星图冻结移除（A2-5），事件契约待 UI 插件化后重新定义
          },
          (stepNum) => {
            globalBus.emit('node:update-dag-step', { stepNum: stepNum, status: 'skip' })
            globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `步骤${stepNum}条件短路跳过` })
          },
          (preview) => {
            globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `执行计划预览`, detail: preview })
          },
          undefined,
          activeTraceId.value
        )

        if (macroResult.savedTokens > 0) {
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'cache', message: `调度优化节省 ~${macroResult.savedTokens} tokens（缓存复用+条件短路）` })
        }

        if (macroResult.lineage && macroResult.lineage.length > 0) {
          const savings = computeLineageSavings(macroResult.lineage)
          const lineageText = formatLineage(macroResult.lineage)
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'cache', message: `执行血缘：零token步骤 ${savings.zeroTokenSteps}/${savings.llmSteps + savings.zeroTokenSteps}，预估节省 ${savings.tokensSaved} tokens`, detail: lineageText })
        }

        logManifestUsage(macroManifest.identity.id)

        const finalText = stripHtml(beautify(macroResult.lastResult || '(执行完成)'))
        await presentExecutionOutput(finalText, macroResult.lineage)
        globalBus.emit('node:mark-task-chain-complete', {})
        setTimeout(() => { globalBus.emit('node:clear-dag-chain', {}) }, 3000)
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
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `宏执行失败，回退到普通模式: ${errMsg}`, detail: errMsg })
        globalBus.emit('node:clear-dag-chain', {})
        // M16：竞争胜者执行失败（宏/链抛错）→ EMA outcome = 0.0
        applyCompetitionOutcome(EMA_OUTCOME_FAILURE)
        // Fall through to normal execution
      }
    }

    try {
      addSystemNotice('✅ 用户确认，开始执行...')
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-workspace-memory', status: 'working' })

      const allMcpTools = buildMcpTools()

      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'working' })
      const planFiltered = filterToolsByPlan(allMcpTools, plan)
      const toolIndex = await buildToolIndex(planFiltered.map(t => ({
        name: t.name,
        description: t.description
      })))
      const topCandidates = await retrieveTopTools(content, toolIndex, 5)
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })

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
        const l2Nodes = (globalBus.request('node:get-nodes', {}) as any[]).filter(n => n.level === 'L2')
        return l2Nodes.find(n => n.id.includes(mcpPrefix) || t.shortName.includes(n.id.split('-').pop() || ''))?.id
      }).filter(Boolean) as string[]
      globalBus.emit('node:highlight-l2-candidates', { ids: candidateL2Ids })
      if (candidateL2Ids.length > 0) {
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'raap', message: `RAG检索到${topCandidates.length}个候选工具，已高亮L2节点` })
      }

      // ===== Map plan steps to L2 nodes for DAG chain =====
      const stepToNodeMap = new Map<number, string>()
      const l2Nodes = (globalBus.request('node:get-nodes', {}) as any[]).filter(n => n.level === 'L2')
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
      globalBus.emit('node:set-dag-chain', { steps: dagStepNodes.map(s => ({
        nodeId: s.nodeId,
        stepNum: s.stepNum,
        status: 'pending' as const
      })), dependsOnMap: dependsOnMap })

      // ===== Mark root steps (no deps) as ready =====

      globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })

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
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: 'working' })
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'dialog', message: '检测到质疑，正在检索原始对话记录...' })
        const ragResults = await searchConversationContext(content, 3)
        if (ragResults.length > 0) {
          chatHistory.push({
            role: 'system',
            content: `【系统自动注入 - 原始对话记录】用户质疑了你之前的回答，以下是最相关的历史对话原文，请据此纠正：\n${ragResults.join('\n---\n')}`
          })
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'dialog', message: '已检索到相关历史记录并注入上下文' })
        }
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: ragResults.length > 0 ? 'success' : 'idle' })
      }

      globalBus.emit('node:set-l1-status', { nodeId: 'l1-workspace-memory', status: 'success' })

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

        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })
        await yieldToUI()

        let stepHint = ''
        if (nextStepIdx >= 0) {
          const step = currentPlanSteps[nextStepIdx]
          globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'running' })
          stepHint = `\n【当前执行第${step.step}步：${step.description}，期望输出：${step.expectedOutput}】先简述思考(1-2句)再调工具。`
        } else if (isAutoRound) {
          stepHint = '\n请根据用户需求选择合适的工具执行任务。如果需要读取文件用read_file，需要执行命令用shell_exec。先简述思考再调工具。'
        }

        if (stepHint && chatHistory.length > 0) {
          const lastMsg = chatHistory[chatHistory.length - 1]
          if (lastMsg.role === 'user' && !(lastMsg.content || '').includes('【当前执行第')) {
            lastMsg.content = (lastMsg.content || '') + stepHint
          } else {
            chatHistory.push({ role: 'user', content: stepHint })
          }
        }

        let result: { content: string; toolCalls: { id: string; name: string; arguments: string }[] }
        try {
          // G-8：主路径记账归因——traceId 经 routingOptions 贯穿 record-cost（仅 traceId，路由行为不变）
          result = await globalBus.requestAsync('api:chat-completion', { messages: chatHistory, stream: true, tools: activeTools.length > 0 ? activeTools : undefined, routingOptions: { traceId: activeTraceId.value || undefined } })
        } catch (callErr) {
          const e = String(callErr)
          addSystemNotice(`❌ 请求失败（${classifyError(e)}）`)
          globalBus.emit('debug:log-probe', { level: 'error', domain: 'llm', message: `请求失败: ${e}`, detail: e })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'error' })
          hasErrors = true
          if (nextStepIdx >= 0) {
            const step = currentPlanSteps[nextStepIdx]
            stepFailed.set(step.step, true)
            globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'failed' })
          }
          break
        }
        await yieldToUI()

        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'success' })

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
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: 'working' })
            }
            if (toolLower.includes('shell') || toolLower.includes('exec')) {
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'working' })
            }
            if (toolLower.includes('write')) {
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'working' })
            }
            await yieldToUI()

            let toolResult: string
            try {
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.arguments) } catch { args = {} }
              toolResult = await executeToolCall(tc.name, args)

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
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: 'success' })
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'success' })
            } catch (err) {
              const errStr = String(err)
              toolResult = `工具调用失败: ${errStr}`
              toolCallSummary.push(`✗ ${shortName}`)
              globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `工具${shortName}调用失败: ${errStr}`, detail: errStr })
              hasErrors = true
              stepHadError = true
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-knowledge-feeder', status: 'error' })
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'error' })
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
              globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'failed' })

              // ===== Re-Plan: local patch for remaining steps =====
              addSystemNotice(`🔄 步骤${step.step}失败，触发重规划...`)
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'working' })
              const remainingSteps = currentPlanSteps.filter(s => !stepDone.has(s.step) && !stepFailed.has(s.step))
              // Mark failed step as done (with error) so dependent steps can proceed
              stepDone.set(step.step, true)
              completedStepResults[step.step] = `步骤执行失败，已触发重规划`
              globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'replanned' })
              try {
                const truncatedResults: Record<number, string> = {}
                for (const [k, v] of Object.entries(completedStepResults)) {
                  truncatedResults[Number(k)] = v.substring(0, 200) + (v.length > 200 ? '...(已截断)' : '')
                }
                const patchedSteps = await replan(step.step, '步骤执行失败', remainingSteps, truncatedResults)
                const maxStepNum = currentPlanSteps.reduce((max, cs) => Math.max(max, cs.step), 0)
                // B-03：LLM 补丁里的 depends_on 用的是原计划编号，重编号后必须重映射，
                // 否则依赖悬空 → depsOk 永不满足 → 补丁步骤被静默跳过（任务看似成功实则缺步）
                const stepRemap = new Map<number, number>()
                const newSteps = patchedSteps.map((s, i) => {
                  const newNum = maxStepNum + i + 1
                  stepRemap.set(Number(s.step), newNum)
                  return { ...s, step: newNum }
                })
                for (const ns of newSteps) {
                  // 已完成步骤保留原编号（stepDone 里有记录），补丁内部依赖映射到新编号，
                  // 既不是已完成步骤也映射不到的依赖视为悬空，剔除以免永久阻塞
                  ns.depends_on = ns.depends_on
                    .map(d => stepRemap.get(d) ?? (stepDone.has(d) ? d : undefined))
                    .filter((d): d is number => d !== undefined)
                }
                // Keep done steps + failed step (now marked done) + new replanned steps
                currentPlanSteps = [...currentPlanSteps.filter(s => stepDone.has(s.step)), ...newSteps]
                // Add new steps to DAG chain state
                for (const ns of newSteps) {
                  const nsNode = stepToNodeMap.get(ns.step) || 'l1-model-gateway'
                  globalBus.emit('node:dag-chain-push-step', {
                    step: {
                    nodeId: nsNode,
                    stepNum: ns.step,
                    status: 'replanned' as const
                  }
                  })
                  // Update dependsOnMap for 3D visualization
                  globalBus.emit('node:dag-chain-set-deps', { stepNum: ns.step, dependsOn: ns.depends_on })
                }
                globalBus.emit('debug:log-probe', { level: 'info', domain: 'schedule', message: `重规划完成，剩余${newSteps.length}步已调整` })
              } catch {
                addSystemNotice('⚠️ 重规划失败，继续尝试原有步骤')
              }
              globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
            } else {
              stepDone.set(step.step, true)
              globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'done' })
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
              globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'done' })
              completedStepResults[step.step] = finalContent.substring(0, 1000)
            } else {
              stepFailed.set(step.step, true)
              globalBus.emit('node:update-dag-step', { stepNum: step.step, status: 'failed' })
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
          const supplementResult = await globalBus.requestAsync('api:chat-completion', { messages: chatHistory, stream: true, tools: allMcpTools.length > 0 ? allMcpTools : undefined, routingOptions: { traceId: activeTraceId.value || undefined } })
          if (supplementResult.toolCalls.length > 0) {
            const supplementMsg: ChatMessage = {
              role: 'assistant',
              content: supplementResult.content || null,
              tool_calls: supplementResult.toolCalls.map((tc: { id: string; name: string; arguments: string }) => ({
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
                toolResult = await executeToolCall(tc.name, args)
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
          const summaryResult = await globalBus.requestAsync('api:chat-completion', { messages: chatHistory, stream: true, tools: undefined, routingOptions: { traceId: activeTraceId.value || undefined } })
          finalContent = summaryResult.content || '(模型未返回总结)'
        } catch {
          finalContent = '(模型总结请求失败，但工具已执行完毕)'
        }
      }

      if (toolCallSummary.length > 0) {
        addSystemNotice(`🔧 ${toolCallSummary.join(' | ')}`)
      }

      if (finalContent && hasToolCalls) {
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'working' })
        finalContent = beautify(finalContent)
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-result-beautifier', status: 'success' })
      }

      finalContent = stripHtml(finalContent)

      addAssistantMessage(finalContent || '(空回复)')

      if (!hasErrors && executedTools.length > 0) {
        globalBus.emit('node:mark-task-chain-complete', {})
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
      setTimeout(() => { globalBus.emit('node:clear-dag-chain', {}) }, 3000)

      generateHistorySummary()

      indexConversationRound(messages.value).catch(() => {})

      if (shouldCompress(messages.value)) {
        const lastSummaryTime = loadSummaries()[loadSummaries().length - 1]?.to || 0
        const newMsgs = messages.value.filter(m => m.timestamp > lastSummaryTime && (m.role === 'user' || (m.role === 'assistant' && m.type === 'text')))
        if (newMsgs.length >= 8) {
          // B-05：generateHistorySummary 异步未等待就读缓存，读到的系统性错位为上一轮
          // 旧摘要——必须 await 后再读
          await generateHistorySummary()
          const summary = vault.readCache('dialog', 'holo-history-summary') || ''
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
      globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `执行失败: ${errMsg}`, detail: errMsg })
      globalBus.emit('node:set-l0-red-flash', { value: true })
      isProcessing.value = false
      return ''
    }
  }

  function rejectPlan() {
    pendingPlan.value = null
    pendingContent.value = ''
    awaitingConfirmation.value = false
    pendingMacroManifestId.value = null
    // M16：用户取消 → 竞争记录作废（不产生 EMA 更新）
    pendingCompetitionRecord = null
    addSystemNotice('❌ 用户取消了执行计划')
  }

  async function confirmTranslatedIntent(): Promise<string> {
    const ti = translatedIntent.value
    if (!ti) return ''
    awaitingIntentConfirm.value = false
    isProcessing.value = true
    addSystemNotice(`✅ 用户确认，执行：${ti.intent}`)
    const manifest = globalBus.request<L2ToolManifest | null>('node:get-l2-manifest', { id: ti.manifestId })
    translatedIntent.value = null

    if (manifest && (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') && manifest.execution.dagPlan) {
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
      try {
        const macroResult = await executeMacro(manifest, { inputText: ti.originalInput, context: ti.params ? JSON.stringify(ti.params) : '' }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, activeTraceId.value)
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
          // B-01：走互斥获取，清掉其它暂停点标志，防止双暂停态卡死输入循环
          acquirePausePoint('factResolution')
          isProcessing.value = false
          addSystemNotice(`🔴 事实一致性校验失败：${errMsg.replace('FactGuard: ', '')}`)
          return ''
        }
        addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `执行失败: ${errMsg}`, detail: errMsg })
        isProcessing.value = false
        return ''
      }
    }

    // A5-9：直调模式此前为死路（仅 confirmPlan 有直调分支）——补齐 resolveDirectPrompt + chat-completion
    if (manifest && manifest.execution.mode === 'direct' && manifest.execution.directCall) {
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })
      try {
        const directInfo = resolveDirectPrompt(manifest, {
          inputText: ti.originalInput,
          context: ti.params ? JSON.stringify(ti.params) : ti.originalInput
        })
        if (directInfo) {
          const resp = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: directInfo.prompt }], stream: true, tools: undefined, maxTokens: directInfo.maxTokens })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'success' })
          const finalText = stripHtml(beautify(resp.content || '(无输出)'))
          addAssistantMessage(finalText)
          globalBus.emit('node:mark-task-chain-complete', {})
          isProcessing.value = false
          return finalText
        }
        addSystemNotice('❌ 直调模板无法解析（必填槽位未满足），请重新描述需求')
      } catch (err) {
        const errStr = String(err)
        addSystemNotice(`❌ 直调失败（${classifyError(errStr)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `直调失败: ${errStr}`, detail: errStr })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'error' })
      }
      isProcessing.value = false
      return ''
    }

    // 兜底：manifest 缺失或执行模式未覆盖时明示失败，不再静默无响应
    if (!manifest) {
      addSystemNotice('❌ 工具未找到，请重新描述需求')
    } else {
      addSystemNotice(`❌ 工具 ${manifest.identity.name} 的执行模式 ${manifest.execution.mode} 暂不支持确认后执行`)
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
    const manifest = globalBus.request<L2ToolManifest | null>('node:get-l2-manifest', { id: sc.manifestId })
    slotClarification.value = null

    if (manifest && (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') && manifest.execution.dagPlan) {
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
      const lastUserMsg = messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
      try {
        const macroResult = await executeMacro(manifest, { inputText: lastUserMsg, context: filledSlots ? JSON.stringify(filledSlots) : '' }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, activeTraceId.value)
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
          // B-01：走互斥获取，清掉其它暂停点标志，防止双暂停态卡死输入循环
          acquirePausePoint('factResolution')
          isProcessing.value = false
          addSystemNotice(`🔴 事实一致性校验失败：${errMsg.replace('FactGuard: ', '')}`)
          return ''
        }
        addSystemNotice(`❌ 执行失败（${classifyError(errMsg)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `执行失败: ${errMsg}`, detail: errMsg })
        isProcessing.value = false
        return ''
      }
    }

    // A5-9：直调模式此前为死路——补齐 resolveDirectPrompt + chat-completion
    if (manifest && manifest.execution.mode === 'direct' && manifest.execution.directCall) {
      const lastUserMsg = messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })
      try {
        const directInfo = resolveDirectPrompt(manifest, {
          inputText: lastUserMsg,
          context: filledSlots ? JSON.stringify(filledSlots) : lastUserMsg
        })
        if (directInfo) {
          const resp = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: directInfo.prompt }], stream: true, tools: undefined, maxTokens: directInfo.maxTokens })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'success' })
          const finalText = stripHtml(beautify(resp.content || '(无输出)'))
          addAssistantMessage(finalText)
          globalBus.emit('node:mark-task-chain-complete', {})
          isProcessing.value = false
          return finalText
        }
        addSystemNotice('❌ 直调模板无法解析（必填槽位未满足），请重新描述需求')
      } catch (err) {
        const errStr = String(err)
        addSystemNotice(`❌ 直调失败（${classifyError(errStr)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `直调失败: ${errStr}`, detail: errStr })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'error' })
      }
      isProcessing.value = false
      return ''
    }

    // 兜底：manifest 缺失或执行模式未覆盖时明示失败，不再静默无响应
    if (!manifest) {
      addSystemNotice('❌ 工具未找到，请重新描述需求')
    } else {
      addSystemNotice(`❌ 工具 ${manifest.identity.name} 的执行模式 ${manifest.execution.mode} 暂不支持填参后执行`)
    }
    isProcessing.value = false
    return ''
  }

  function cancelSlotFill() {
    slotClarification.value = null
    awaitingSlotFill.value = false
    addSystemNotice('❌ 已取消，请重新描述需求')
  }

  async function pickCandidate(index: number, originalInput?: string): Promise<string> {
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

    const manifest = globalBus.request<L2ToolManifest | null>('node:get-l2-manifest', { id: picked.manifestId })
    if (!manifest) {
      addSystemNotice('❌ 工具未找到，请重新描述需求')
      isProcessing.value = false
      return ''
    }

    if (manifest.execution.mode === 'macro' || manifest.execution.mode === 'chain') {
      if (manifest.execution.dagPlan) {
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
        addSystemNotice(`🟢 RaaP匹配：${manifest.identity.name}（用户选择，置信度${(picked.score * 100).toFixed(0)}%）`)
        // P1-46：编号拦截路径传入原始请求；按钮点击路径回退最后一条用户消息
        const lastUserMsg = originalInput || messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
        try {
          const macroResult = await executeMacro(manifest, { inputText: lastUserMsg }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, activeTraceId.value)
          addSystemNotice('✅ 执行完成')
          globalBus.emit('debug:log-probe', { level: 'info', domain: 'tool', message: `执行完成: ${macroResult.lastResult.substring(0, 500)}`, detail: macroResult.lastResult })
          isProcessing.value = false
          return macroResult.lastResult
        } catch (err) {
          const errStr = String(err)
          addSystemNotice(`❌ 执行失败（${classifyError(errStr)}）`)
          globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `执行失败: ${errStr}`, detail: errStr })
          isProcessing.value = false
          return ''
        }
      }
    } else if (manifest.execution.mode === 'direct' && manifest.execution.directCall) {
      // A5-9：用户已明确选择候选，无需再走 pendingPlan 确认回合——直接 resolveDirectPrompt + chat-completion
      const lastUserMsg = originalInput || messages.value.filter(m => m.role === 'user').slice(-1)[0]?.content || ''
      addSystemNotice(`🟢 RaaP直调：${manifest.identity.name}（用户选择，置信度${(picked.score * 100).toFixed(0)}%）`)
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-task-translator', status: 'success' })
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-pipeline-builder', status: 'success' })
      globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'working' })
      try {
        const directInfo = resolveDirectPrompt(manifest, { inputText: lastUserMsg, context: lastUserMsg })
        if (directInfo) {
          const resp = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: directInfo.prompt }], stream: true, tools: undefined, maxTokens: directInfo.maxTokens })
          globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'success' })
          const finalText = stripHtml(beautify(resp.content || '(无输出)'))
          addAssistantMessage(finalText)
          globalBus.emit('node:mark-task-chain-complete', {})
          isProcessing.value = false
          return finalText
        }
        addSystemNotice('❌ 直调模板无法解析（必填槽位未满足），请重新描述需求')
      } catch (err) {
        const errStr = String(err)
        addSystemNotice(`❌ 直调失败（${classifyError(errStr)}）`)
        globalBus.emit('debug:log-probe', { level: 'error', domain: 'tool', message: `直调失败: ${errStr}`, detail: errStr })
        globalBus.emit('node:set-l1-status', { nodeId: 'l1-model-gateway', status: 'error' })
      }
      isProcessing.value = false
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

  // B-02：确认结束后重发排队消息；若前台仍忙（宏收尾中/其它暂停点），500ms 轮询等待
  function flushRiskQueuedInputs(): void {
    if (_riskQueueFlushTimer) { clearTimeout(_riskQueueFlushTimer); _riskQueueFlushTimer = null }
    if (_riskQueuedInputs.length === 0) { _riskQueueRetries = 0; return }
    const busy = isProcessing.value || awaitingRiskConfirm.value || awaitingConfirmation.value
      || awaitingIntentConfirm.value || awaitingSlotFill.value || awaitingCandidatePick.value
      || awaitingFactResolution.value || dagPaused.value || awaitingTakeover.value
    if (busy) {
      if (++_riskQueueRetries > 600) {
        _riskQueuedInputs.length = 0
        _riskQueueRetries = 0
        addSystemNotice('⚠️ 风险确认期间排队的消息等待超时，已丢弃')
        return
      }
      _riskQueueFlushTimer = setTimeout(flushRiskQueuedInputs, 500)
      return
    }
    _riskQueueRetries = 0
    const next = _riskQueuedInputs.shift()
    if (next !== undefined) {
      void sendMessage(next, true)
      if (_riskQueuedInputs.length > 0) _riskQueueFlushTimer = setTimeout(flushRiskQueuedInputs, 500)
    }
  }

  function requestRiskConfirm(action: import('@/models').ActionManifest): Promise<boolean> {
    // A5-4：被新请求顶替时必须先结算旧 Promise（按拒绝，fail-closed），
    // 否则首个调用方的 await 永久悬挂（singleton resolver 覆盖孤儿化）。
    if (_riskResolve) {
      const superseded = _riskResolve
      _riskResolve = null
      superseded(false)
    }
    riskAction.value = action
    acquirePausePoint('riskConfirm')
    return new Promise<boolean>((resolve) => {
      _riskResolve = resolve
      setTimeout(() => {
        if (_riskResolve === resolve) {
          _riskResolve = null
          awaitingRiskConfirm.value = false
          riskAction.value = null
          resolve(false)
          // B-02：超时按拒绝后同样尝试重发排队消息
          flushRiskQueuedInputs()
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
    // B-02：重发风险确认期间排队的输入（flush 内部会等前台空闲）
    flushRiskQueuedInputs()
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
    // A5-4：被新请求顶替时先结算旧 Promise（空结果=未接管），避免永久悬挂
    if (_takeoverResolve) {
      const superseded = _takeoverResolve
      _takeoverResolve = null
      superseded('')
    }
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await globalBus.requestAsync('api:chat-completion', { messages: [{ role: 'user', content: '请使用源文件中的原始精确数字重新生成，不要修改任何金额、日期或编号。' }], stream: false, tools: undefined, maxTokens: 512, signal: controller.signal })
      // B-07：重生成结果必须展示给用户——原实现只写 debug 日志，用户完全看不到内容
      if (resp.content) {
        addAssistantMessage(resp.content)
      } else {
        addSystemNotice('⚠️ 模型未返回内容，请选择覆盖或保留')
        return
      }
      globalBus.emit('debug:log-probe', { level: 'info', domain: 'tool', message: `重新生成结果`, detail: (resp.content || '').substring(0, 500) })
    } catch {
      addSystemNotice('❌ 重新生成失败，请选择覆盖或保留')
      return
    } finally {
      // B-07：原 catch 路径不清 timer，15s 定时器泄漏
      clearTimeout(timer)
    }
    factConflict.value = null
    awaitingFactResolution.value = false
  }

  function insertSystemMessage(content: string) {
    addSystemNotice(content)
  }

  function loadFromStorage() {
    const saved = vault.readCache('dialog', 'holo-dialog-messages')
    if (saved) {
      try {
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
      } catch { /* ignore */ }
    }
    const savedMode = vault.readCache('dialog', 'holo-dialog-mode')
    if (savedMode) mode.value = savedMode as 'command' | 'plan' | 'teach'
  }

  function saveToStorage() {
    const stripped = messages.value.slice(-200).map(m => {
      const copy = { ...m }
      delete (copy as Partial<DialogMessage>).lineage
      return copy
    })
    vault.writeThrough('dialog', 'holo-dialog-messages', JSON.stringify(stripped))
    vault.writeThrough('dialog', 'holo-dialog-mode', mode.value)
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
    // B-17：拷贝断开与 session.messages 的数组别名——直接赋值会让后续 push
    // 直接改写会话存储的数组，与"存入会话的永远是拷贝"语义矛盾
    messages.value = target.messages ? target.messages.map(m => ({ ...m })) : []
    clearAllPausePoints()
    isProcessing.value = false
    saveToStorage()
  }

  // P0-8：删除会话必须经 dialogStore 路由——直接调 sessionStore.deleteSession 时，
  // messages 仍持有被删会话的消息数组引用，下一次 saveToStorage 会把旧数组
  // 按引用注入新指向的相邻会话并持久化（历史被覆盖）。
  function deleteSession(sessionId: string): void {
    const sessionStore = useSessionStore()
    const wasActive = sessionStore.activeSessionId === sessionId
    sessionStore.deleteSession(sessionId)
    if (wasActive) {
      const next = sessionStore.activeSession
      // 显式拷贝断别名：绝不与被删会话的旧数组共享引用
      messages.value = next?.messages ? next.messages.map(m => ({ ...m })) : []
      clearAllPausePoints()
      isProcessing.value = false
    }
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
    globalBus.emit('debug:unfreeze-buffer', {})
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
    activeTraceId,
    refreshFunnelMainFlag,
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
    refreshStrictVetoFlag,
    refreshCompetitiveModeFlag,
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
    deleteSession,
    newSession,
    clearCurrentSession,
    exportCurrentSession,
    transientHint,
    showTransientHint,
    lastDecisionContext
  }
})
