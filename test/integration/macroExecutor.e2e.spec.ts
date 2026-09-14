import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { L2DagStep, L2ToolManifest } from '@/models'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

const mockDebugStore = {
  enabled: false,
  emitEvent: vi.fn(),
  recordProbe: vi.fn(),
  registerAbortController: vi.fn(),
  clearAbortController: vi.fn()
}

const mockDialogStore = {
  dagPaused: false,
  dagPausedStep: null as number | null,
  awaitingTakeover: false,
  takeoverStepNum: null as number | null,
  addSystemNotice: vi.fn(),
  requestRiskConfirm: vi.fn().mockResolvedValue(true),
  clearAllPausePoints: vi.fn(),
  awaitingRiskConfirm: false,
  riskAction: null
}

const mockFeedbackStore = {
  addSideEffectManifest: vi.fn(),
  recordFeedback: vi.fn(),
  getWeightModifier: vi.fn().mockReturnValue(0),
  computeQueryFingerprint: vi.fn(() => 'qfp')
}

vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => mockDebugStore) }))
vi.mock('@/stores/dialogStore', () => ({ useDialogStore: vi.fn(() => mockDialogStore) }))
vi.mock('@/stores/feedbackStore', () => ({ useFeedbackStore: vi.fn(() => mockFeedbackStore), computeQueryFingerprint: vi.fn(() => 'qfp') }))

vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn(() => false),
  buildActionManifest: vi.fn(),
  dualEngineValidate: vi.fn()
}))
vi.mock('@/services/errorClassifier', () => ({ classifyError: vi.fn() }))
vi.mock('@/services/factGuard', () => ({ extractEntities: vi.fn(() => []), shouldTrigger: vi.fn(() => false), runFactGuard: vi.fn(), runFactGuardV2: vi.fn() }))
vi.mock('@/services/ruleEngine', () => ({ runRuleEngine: vi.fn(() => ({ matched: false })), buildRuleContext: vi.fn() }))
vi.mock('@/services/scheduleOptimizer', () => ({
  compilePrompt: vi.fn((t: string) => ({ template: t, slots: [] })),
  fillCompiledPrompt: vi.fn((c: any, v: any) => {
    let r = c.template || ''
    for (const [k, val] of Object.entries(v || {})) r = r.replaceAll(`{{${k}}`, String(val))
    return r
  }),
  computeInputFingerprint: vi.fn(() => 'fp'),
  findCachedExecution: vi.fn(() => null),
  saveExecutionFingerprint: vi.fn(),
  computeStepOutputHash: vi.fn(() => 'hash'),
  findDirtySteps: vi.fn(() => new Set()),
  getTierConfig: vi.fn(() => ({ maxTokens: 4096, temperature: 0.5 })),
  computeStepPlan: vi.fn((steps: any[], dirty: any, skip: any, cached: any) => ({
    willReuse: [],
    willSkip: [],
    willExecute: steps
  })),
  computeParallelGroups: vi.fn(() => []),
  formatStepPlanVisualization: vi.fn(() => ''),
  isManifestAutoCompiled: vi.fn(() => false),
  simulateDataFlow: vi.fn(() => ({ ok: true, issues: [], summary: '' }))
}))
vi.mock('@/services/dagCheckpoint', () => ({
  saveCheckpoint: vi.fn(),
  removeCheckpoint: vi.fn(),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  createCheckpointId: vi.fn(() => 'cp-id')
}))
vi.mock('@/services/knowledgeBase', () => ({ searchKnowledge: vi.fn().mockResolvedValue(['知识1']) }))
vi.mock('@/services/secureStore', () => ({ storeGet: vi.fn().mockResolvedValue(null), storeSet: vi.fn().mockResolvedValue(undefined) }))

import { executeMacro } from '@/services/macroExecutor'

function makeManifest(o: Partial<L2ToolManifest> = {}): L2ToolManifest {
  return {
    identity: { id: 'e2e-test', name: 'E2E Test', version: '1.0.0', tier: 'L2', category: 'test', description: 'e2e' },
    visual: { color: '#fff', icon: '🔧', size: 1, spikes: 4, glowIntensity: 1, position: { x: 0, y: 0, z: 0 } },
    routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9 },
    execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 500, avgExecutionTime: 1000, cacheable: true },
    ...o
  }
}

describe('E2E 冒烟测试 - macroExecutor 真实链路', () => {
  let originalWindow: any
  let httpFetchFn: any
  let shellExecFn: any
  let llmChatCompletionFn: ReturnType<typeof vi.fn>
  let sideEffectEvents: any[]
  let _takeoverResolve: ((v: string) => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    vault.clearCache()
    mockDebugStore.enabled = false
    mockDialogStore.dagPaused = false
    mockDialogStore.dagPausedStep = null
    mockDialogStore.awaitingTakeover = false
    mockDialogStore.takeoverStepNum = null
    _takeoverResolve = null
    llmChatCompletionFn = vi.fn().mockResolvedValue({ content: 'mocked-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })
    sideEffectEvents = []

    httpFetchFn = vi.fn().mockResolvedValue({ success: true, status: 200, body: '{"login":"octocat","id":1}' })
    shellExecFn = vi.fn().mockResolvedValue({ success: true, stdout: 'OK', stderr: '', code: 0 })

    originalWindow = (globalThis as any).window
    ;(globalThis as any).window = {
      electronAPI: {
        shellExec: shellExecFn,
        fileRead: vi.fn().mockResolvedValue({ success: true, content: 'file-content', size: 100, isBinary: false }),
        httpFetch: httpFetchFn,
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    }
    ;(globalThis as any).process = { env: { USERPROFILE: 'C:\\Users\\Test', HOME: '/home/test', APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' } }

    globalBus.registerHandler('debug:get-step-cost', () => undefined)
    globalBus.on('debug:log-probe', () => {})
    globalBus.on('debug:register-abort', () => {})
    globalBus.on('debug:clear-abort', () => {})
    globalBus.registerHandler('api:chat-completion', (data: any) => llmChatCompletionFn(data))
    globalBus.registerHandler('dialog:confirm-risk', () => true)
    globalBus.on('feedback:add-side-effect', (data: any) => { sideEffectEvents.push(data) })

    let pausedState = { paused: false, pausedStep: null as number | null, awaitingTakeover: false, takeoverStepNum: null as number | null }
    globalBus.registerHandler('dialog:get-paused-state', () => pausedState)
    globalBus.registerHandler('dialog:request-takeover', () => {
      pausedState.awaitingTakeover = true
      return new Promise<string>((resolve) => { _takeoverResolve = resolve })
    })
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
    globalBus.clear()
  })

  it('http_request GET 返回 status:200', async () => {
    const steps: L2DagStep[] = [{
      step: 1, description: 'fetch github', tool: 'http_request', depends_on: [],
      params: { url: 'https://api.github.com/users/octocat', method: 'GET' },
      expectedOutput: 'http-response'
    }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })

    const start = Date.now()
    const result = await executeMacro(manifest, { inputText: '获取用户信息' })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(httpFetchFn).toHaveBeenCalledTimes(1)
    expect(httpFetchFn).toHaveBeenCalledWith({
      url: 'https://api.github.com/users/octocat',
      method: 'GET',
      headers: undefined,
      body: undefined,
      timeout: 30000
    })
    expect(result.results[1]).toContain('HTTP 200')
    expect(result.results[1]).toContain('octocat')
    expect(result.lineage.length).toBe(1)
    expect(result.lineage[0].tool).toBe('http_request')
  })

  it('shell_exec 写文件触发 sideEffectSteps 记录', async () => {
    const writeCmd = 'const fs = require("fs"); fs.writeFileSync("test.txt", "Hello")'
    shellExecFn.mockResolvedValue({ success: true, stdout: 'OK', stderr: '', code: 0 })

    const steps: L2DagStep[] = [{
      step: 1, description: 'write file', tool: 'shell_exec', depends_on: [],
      params: { command: writeCmd },
      expectedOutput: 'written'
    }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })

    const start = Date.now()
    const result = await executeMacro(manifest, { inputText: '写入文件' })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(shellExecFn).toHaveBeenCalledTimes(1)
    expect(shellExecFn).toHaveBeenCalledWith(expect.objectContaining({ command: writeCmd }))
    expect(result.results[1]).toBeDefined()
    expect(sideEffectEvents.length).toBeGreaterThan(0)
    expect(sideEffectEvents[0].sideEffects.length).toBeGreaterThan(0)
    expect(sideEffectEvents[0].sideEffects[0].operation).toBe('create')
    expect(sideEffectEvents[0].sideEffects[0].filePath).toContain('test.txt')
  })

  it('awaitingTakeover 人工接管 Promise 在 submitTakeover 之前 pending', async () => {
    const steps: L2DagStep[] = [{
      step: 1, description: 'manual step', tool: 'shell_exec', depends_on: [],
      params: { command: 'echo before-takeover' },
      expectedOutput: 'manual'
    }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })

    const pausedHandler = globalBus.handlers.get('dialog:get-paused-state')
    let pausedState = { paused: true, pausedStep: 1 as number | null, awaitingTakeover: false, takeoverStepNum: null as number | null }
    globalBus.handlers.set('dialog:get-paused-state', () => pausedState)

    let settled = false
    const execPromise = executeMacro(manifest, { inputText: '需要人工接管' })
    execPromise.then(() => { settled = true })

    await new Promise(r => setTimeout(r, 700))
    expect(settled).toBe(false)

    pausedState = { paused: false, pausedStep: null, awaitingTakeover: true, takeoverStepNum: 1 }

    await new Promise(r => setTimeout(r, 600))
    expect(settled).toBe(false)

    if (_takeoverResolve) _takeoverResolve('人工确认结果')

    const start = Date.now()
    const result = await execPromise
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(result.results[1]).toBe('人工确认结果')
    expect(result.lineage[0].source).toBe('tool_call')
  })
})
