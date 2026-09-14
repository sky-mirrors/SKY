import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ProbeSnapshot, DebugSession, ConsoleLogEntry, ConsoleLogLevel, ConsoleCategory, BudgetStatus, CostRecord, ModelTier } from '@/models'
import { debugLog } from '@/services/debugLog'
import { recordLlmCost, getBudgetStatus as getBudgetStatusFromService, initBudgetSystem, getCostBreakdownByTier, getCostBreakdownByCategory } from '@/services/tokenBudget'
import { calculateCost } from '@/services/tokenPricing'

const MAX_PROBES = 200
const FREEZE_HARD_LIMIT = 500
const MAX_CONSOLE_LOGS = 500
const LOG_FILE_KEY = 'debug-probe-log'

const TAG_EXTRACT = /^\[([^\]]+)\]/

// 模块加载时绑定原始 console（capture 启动前），dev 下 emitEvent 镜像到真实 console 供主进程 console-message 钩子落盘
const meta = import.meta as unknown as { env?: Record<string, unknown> }
const DEV_MIRROR = meta.env?.DEV === true
const RAW_CONSOLE: Record<string, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

function extractTag(text: string): string | undefined {
  const m = TAG_EXTRACT.exec(text)
  return m ? m[1] : undefined
}

function formatArgs(args: unknown[]): string {
  return args.map(a => {
    if (a === undefined) return 'undefined'
    if (a === null) return 'null'
    if (typeof a === 'object') {
      try { return JSON.stringify(a).substring(0, 500) } catch { return String(a) }
    }
    return String(a)
  }).join(' ')
}

export const useDebugStore = defineStore('debug', () => {
  const enabled = ref(false)
  const recording = ref(true)
  const frozen = ref(false)
  const sessions = ref<DebugSession[]>([])
  const selectedProbeId = ref<string | null>(null)
  const abortController = ref<AbortController | null>(null)
  const currentSession = ref<DebugSession | null>({
    id: `debug-${Date.now()}`,
    startedAt: Date.now(),
    probes: [],
    environment: { model: '', provider: '', apiReachable: false, nodeCount: 0, manifestCount: 0 }
  })

  const consoleLogs = ref<ConsoleLogEntry[]>([])
  const consoleFilterTag = ref<string>('')
  const consoleFilterLevel = ref<ConsoleLogLevel | ''>('')
  const consoleFilterCategory = ref<ConsoleCategory | ''>('')
  const totalTokenUsage = ref({ promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostCny: 0 })
  const stepCosts = ref<Record<number, { durationMs: number; promptTokens: number; completionTokens: number; estimatedCostCny: number }>>({})
  const budgetStatus = ref<BudgetStatus | null>(null)
  const costByTier = ref<Record<string, { cost: number; callCount: number; totalTokens: number }>>({})
  const costByCategory = ref<Record<string, { cost: number; callCount: number }>>({})

  const CATEGORY_ICONS: Record<ConsoleCategory, string> = {
    system: '⚙️', raap: '🎯', llm: '🤖', shell: '💻', cache: '♻️',
    rule: '📋', dialog: '💬', feedback: '👍', factguard: '🛡️', tool: '🔌', schedule: '📊'
  }

  const filteredConsoleLogs = computed(() => {
    let logs = consoleLogs.value
    if (consoleFilterLevel.value) {
      logs = logs.filter(l => l.level === consoleFilterLevel.value)
    }
    if (consoleFilterCategory.value) {
      logs = logs.filter(l => l.category === consoleFilterCategory.value)
    }
    if (consoleFilterTag.value) {
      const tag = consoleFilterTag.value.toLowerCase()
      logs = logs.filter(l => l.tag && l.tag.toLowerCase().includes(tag))
    }
    return logs
  })

  function emitEvent(level: ConsoleLogLevel, category: ConsoleCategory, text: string, detail?: string, traceId?: string) {
    const entry: ConsoleLogEntry = {
      id: `ev-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      level,
      text,
      timestamp: Date.now(),
      tag: extractTag(text),
      category,
      detail,
      traceId,
    }
    consoleLogs.value.push(entry)
    if (DEV_MIRROR) {
      const fn = RAW_CONSOLE[level] ?? RAW_CONSOLE.log
      fn(`[probe][${level}][${category}] ${text}`, detail ?? '')
    }
    if (level === 'error' && !frozen.value) {
      frozen.value = true
    }
    if (consoleLogs.value.length > MAX_CONSOLE_LOGS) {
      consoleLogs.value.splice(0, consoleLogs.value.length - MAX_CONSOLE_LOGS)
    }
  }

  function recordStepCost(stepNum: number, durationMs: number, promptTokens: number, completionTokens: number) {
    const cost = calculateCost(promptTokens, completionTokens, 0)
    stepCosts.value[stepNum] = {
      durationMs,
      promptTokens,
      completionTokens,
      estimatedCostCny: cost.totalCost
    }
  }

  let _skipNextCapture = false

  function toModelTier(tier?: string): ModelTier {
    if (tier === 'nano' || tier === 'mini' || tier === 'pro') return tier
    return 'standard'
  }

  function recordTokenUsage(promptTokens: number, completionTokens: number, totalTokens: number, category?: string, tier?: string, traceId?: string) {
    _skipNextCapture = true
    totalTokenUsage.value.promptTokens += promptTokens
    totalTokenUsage.value.completionTokens += completionTokens
    totalTokenUsage.value.totalTokens += totalTokens
    const cost = calculateCost(promptTokens, completionTokens, 0)
    totalTokenUsage.value.estimatedCostCny += cost.totalCost
    emitEvent('info', 'llm', `[TokenUsage] prompt=${promptTokens}, completion=${completionTokens}, total=${totalTokens}, cost=${cost.totalCost.toFixed(4)}CNY${traceId ? ` [traceId=${traceId.substring(0, 8)}]` : ''}`, undefined, traceId)
    recordLlmCost(toModelTier(tier), promptTokens, completionTokens, 0, category || 'llm')
    refreshBudgetStatus()
  }

  let _origConsole: Record<ConsoleLogLevel, (...args: unknown[]) => void> | null = null
  let _captureActive = false

  function captureConsole() {
    if (_captureActive) return
    _captureActive = true
    _origConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console), // unavoidable: dynamic console method capture
      error: console.error.bind(console), // unavoidable: dynamic console method capture
      info: console.info.bind(console),
    }
    const levels: ConsoleLogLevel[] = ['log', 'warn', 'error', 'info']
    const tagToCategory = (text: string): ConsoleCategory | undefined => {
      if (text.includes('[RaaP]') || text.includes('[toolRetrieval]')) return 'raap'
      if (text.includes('[chatCompletion]') || text.includes('[LLM]') || text.includes('[Pipeline]')) return 'llm'
      if (text.includes('[shell]') || text.includes('[shellExec]') || text.includes('DEBUG_USER_INPUT') || text.includes('DEBUG_CONTENT')) return 'shell'
      if (text.includes('[cache]') || text.includes('[Cache]') || text.includes('缓存')) return 'cache'
      if (text.includes('[Rule]') || text.includes('[rule]')) return 'rule'
      if (text.includes('[Dialog]') || text.includes('[dialog]')) return 'dialog'
      if (text.includes('[Feedback]') || text.includes('[feedback]')) return 'feedback'
      if (text.includes('[FactGuard]')) return 'factguard'
      if (text.includes('[Schedule]') || text.includes('[schedule]') || text.includes('[macroExec]')) return 'schedule'
      if (text.includes('[MCP]') || text.includes('[mcp]')) return 'tool'
      return undefined
    }
    const extractUsage = (text: string) => {
      if (_skipNextCapture) {
        _skipNextCapture = false
        return
      }
      const m = text.match(/usage:\s*prompt=(\d+),\s*completion=(\d+),\s*total=(\d+)/)
      if (m) {
        const pt = Number(m[1]), ct = Number(m[2]), tt = Number(m[3])
        totalTokenUsage.value.promptTokens += pt
        totalTokenUsage.value.completionTokens += ct
        totalTokenUsage.value.totalTokens += tt
        const cost = calculateCost(pt, ct, 0)
        totalTokenUsage.value.estimatedCostCny += cost.totalCost
      }
    }
    for (const level of levels) {
      const orig = _origConsole[level]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(console as any)[level] = (...args: unknown[]) => {
        orig(...args)
        const text = formatArgs(args)
        const entry: ConsoleLogEntry = {
          id: `cl-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          level,
          text,
          timestamp: Date.now(),
          tag: extractTag(text),
          category: tagToCategory(text),
        }
        extractUsage(text)
        consoleLogs.value.push(entry)
        if (consoleLogs.value.length > MAX_CONSOLE_LOGS) {
          consoleLogs.value.splice(0, consoleLogs.value.length - MAX_CONSOLE_LOGS)
        }
      }
    }
  }

  function releaseConsole() {
    if (!_captureActive || !_origConsole) return
    const levels: ConsoleLogLevel[] = ['log', 'warn', 'error', 'info']
    for (const level of levels) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(console as any)[level] = _origConsole[level]
    }
    _origConsole = null
    _captureActive = false
  }

  const activeProbes = computed(() => {
    if (!currentSession.value) return []
    return currentSession.value.probes
  })

  const selectedProbe = computed(() => {
    if (!selectedProbeId.value || !currentSession.value) return null
    return currentSession.value.probes.find(p => p.id === selectedProbeId.value) || null
  })

  const errorProbes = computed(() => {
    if (!currentSession.value) return []
    return currentSession.value.probes.filter(p => p.source === 'error')
  })

  function activate() {
    enabled.value = true
    if (!recording.value) {
      recording.value = true
      captureConsole()
    }
    if (!currentSession.value) {
      currentSession.value = {
        id: `debug-${Date.now()}`,
        startedAt: Date.now(),
        probes: [],
        environment: { model: '', provider: '', apiReachable: false, nodeCount: 0, manifestCount: 0 }
      }
    }
  }

  function deactivate() {
    enabled.value = false
    if (currentSession.value && currentSession.value.probes.length > 0) {
      sessions.value.push(currentSession.value)
      if (sessions.value.length > 10) sessions.value.splice(0, sessions.value.length - 10)
      persistSession(currentSession.value)
    }
  }

  function recordProbe(snapshot: ProbeSnapshot) {
    if (!currentSession.value) return
    currentSession.value.probes.push(snapshot)
    if (frozen.value) {
      if (currentSession.value.probes.length > FREEZE_HARD_LIMIT) {
        currentSession.value.probes.splice(0, currentSession.value.probes.length - FREEZE_HARD_LIMIT)
      }
    } else {
      if (currentSession.value.probes.length > MAX_PROBES) {
        currentSession.value.probes.splice(0, currentSession.value.probes.length - MAX_PROBES)
      }
    }
    if (snapshot.source === 'error' && !frozen.value) {
      frozen.value = true
    }
    writeProbeToFile(snapshot)
  }

  function selectProbe(id: string) {
    selectedProbeId.value = id
  }

  function freezeBuffer() {
    frozen.value = true
  }

  function unfreezeBuffer() {
    frozen.value = false
    if (currentSession.value && currentSession.value.probes.length > MAX_PROBES) {
      currentSession.value.probes.splice(0, currentSession.value.probes.length - MAX_PROBES)
    }
  }

  function terminateExecution() {
    if (abortController.value) {
      abortController.value.abort()
      abortController.value = null
    }
  }

  function registerAbortController(ac: AbortController) {
    abortController.value = ac
  }

  function clearAbortController() {
    abortController.value = null
  }

  function updateEnvironment(env: DebugSession['environment']) {
    if (currentSession.value) {
      currentSession.value.environment = env
    }
  }

  async function exportDebugPackage(): Promise<string | null> {
    if (!currentSession.value) return null
    const data = JSON.stringify(currentSession.value, null, 2)
    try {
      if (window.electronAPI?.fileWrite) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const fileName = `holo-debug-${ts}.json`
        const home = process.env?.USERPROFILE || process.env?.HOME || 'C:\\Users\\Default'
        const filePath = `${home}/Desktop/${fileName}`
        const result = await window.electronAPI.fileWrite({ filePath, content: data })
        if (result.success) return `Desktop/${fileName}`
      }
    } catch { /* fallback */ }
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `holo-debug-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    return null
  }

  async function writeProbeToFile(probe: ProbeSnapshot) {
    try {
      if (window.electronAPI?.storeWrite) {
        const log = await window.electronAPI.storeRead(LOG_FILE_KEY) as ProbeSnapshot[] | null
        const entries = Array.isArray(log) ? log : []
        entries.push(probe)
        if (entries.length > MAX_PROBES) entries.splice(0, entries.length - MAX_PROBES)
        await window.electronAPI.storeWrite(LOG_FILE_KEY, entries)
      }
    } catch { /* non-critical */ }
  }

  async function persistSession(session: DebugSession) {
    try {
      if (window.electronAPI?.storeWrite) {
        const key = `debug-session-${session.id}`
        await window.electronAPI.storeWrite(key, session)
      }
    } catch { /* non-critical */ }
  }

  async function loadPersistedProbes() {
    try {
      if (window.electronAPI?.storeRead) {
        const log = await window.electronAPI.storeRead(LOG_FILE_KEY) as ProbeSnapshot[] | null
        if (log && Array.isArray(log) && log.length > 0 && currentSession.value) {
          currentSession.value.probes = log.slice(-MAX_PROBES)
        }
      }
    } catch { /* non-critical */ }
  }

  async function replayFromProbe(probe: ProbeSnapshot): Promise<{ success: boolean; message: string }> {
    if (!currentSession.value) return { success: false, message: '无活跃调试会话' }
    if (probe.manifestId.startsWith('pipeline-')) return { success: false, message: '管道探针不支持重放，请选择宏执行探针' }
    const manifestId = probe.manifestId
    const fromStep = probe.stepNum
    const priorProbes = currentSession.value.probes.filter(
      p => p.manifestId === manifestId && p.stepNum < fromStep && p.source !== 'error' && p.source !== 'skip'
    )
    const priorResults: Record<number, string> = {}
    for (const p of priorProbes) {
      if (p.outputSnapshot && typeof p.outputSnapshot === 'string') {
        priorResults[p.stepNum] = p.outputSnapshot
      }
    }
    try {
      const { getManifestById } = await import('@/data/l2Manifests')
      const manifest = getManifestById(manifestId)
      if (!manifest) return { success: false, message: `清单 ${manifestId} 不存在` }
      const userInput = (probe.inputSnapshot && typeof probe.inputSnapshot === 'object')
        ? probe.inputSnapshot as { filePath?: string; inputText?: string; context?: string }
        : { inputText: String(probe.inputSnapshot || '') }
      const { executeMacro } = await import('@/services/macroExecutor')
      const result = await executeMacro(
        manifest,
        userInput,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        priorResults
      )
      return { success: true, message: `重放完成，最后结果: ${result.lastResult.substring(0, 100)}` }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { success: false, message: `重放失败: ${msg}` }
    }
  }

  function clearConsoleLogs() {
    consoleLogs.value = []
  }

  function refreshBudgetStatus() {
    budgetStatus.value = getBudgetStatusFromService()
    costByTier.value = getCostBreakdownByTier()
    costByCategory.value = getCostBreakdownByCategory()
  }

  captureConsole()

  emitEvent('info', 'system', '[DebugCenter] 调试中心已自动激活，将记录所有操作和token计数')

  initBudgetSystem()
  refreshBudgetStatus()

  return {
    enabled,
    recording,
    frozen,
    currentSession,
    sessions,
    selectedProbeId,
    activeProbes,
    selectedProbe,
    errorProbes,
    consoleLogs,
    consoleFilterTag,
    consoleFilterLevel,
    consoleFilterCategory,
    filteredConsoleLogs,
    CATEGORY_ICONS,
    clearConsoleLogs,
    emitEvent,
    totalTokenUsage,
    stepCosts,
    budgetStatus,
    costByTier,
    costByCategory,
    recordStepCost,
    recordTokenUsage,
    refreshBudgetStatus,
    activate,
    deactivate,
    recordProbe,
    selectProbe,
    freezeBuffer,
    unfreezeBuffer,
    terminateExecution,
    registerAbortController,
    clearAbortController,
    updateEnvironment,
    exportDebugPackage,
    loadPersistedProbes,
    replayFromProbe
  }
})
