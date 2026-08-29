import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { L2DagStep, L2ToolManifest } from '@/models'

const mockDebugStore = {
  enabled: false,
  emitEvent: vi.fn(),
  recordProbe: vi.fn(),
  registerAbortController: vi.fn(),
  clearAbortController: vi.fn()
}

const mockApiStore = {
  config: { activeModel: 'mock-model', activeProviderId: 'mock', isReachable: true, baseUrl: 'http://mock', providers: [], models: [] },
  isReady: true,
  isCircuitOpen: false,
  chatCompletion: vi.fn().mockResolvedValue({ content: 'mocked-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  resetCircuitBreaker: vi.fn()
}

const mockMcpStore = {
  connections: [
    { id: 'test-server', name: 'Test Server', isConnected: true, tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: {} } }], config: {}, status: 'connected' as const }
  ],
  callTool: vi.fn().mockResolvedValue('mcp-tool-result'),
  mcpToolsAsNodes: []
}

const mockDialogStore = {
  dagPaused: false,
  dagPausedStep: null as number | null,
  awaitingTakeover: false,
  takeoverStepNum: null as number | null,
  addSystemNotice: vi.fn(),
  requestRiskConfirm: vi.fn().mockResolvedValue(true),
  requestTakeover: vi.fn().mockResolvedValue('takeover-result'),
  clearAllPausePoints: vi.fn(),
  awaitingRiskConfirm: false,
  riskAction: null
}

const mockFeedbackStore = {
  addSideEffectManifest: vi.fn(),
  recordFeedback: vi.fn(),
  getWeightModifier: vi.fn().mockReturnValue(0)
}

vi.mock('@/stores/apiStore', () => ({ useApiStore: vi.fn(() => mockApiStore) }))
vi.mock('@/stores/mcpStore', () => ({ useMcpStore: vi.fn(() => mockMcpStore) }))
vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => mockDebugStore) }))
vi.mock('@/stores/dialogStore', () => ({ useDialogStore: vi.fn(() => mockDialogStore) }))
vi.mock('@/stores/feedbackStore', () => ({ useFeedbackStore: vi.fn(() => mockFeedbackStore), computeQueryFingerprint: vi.fn(() => 'qfp') }))

vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn(() => false),
  buildActionManifest: vi.fn(),
  dualEngineValidate: vi.fn()
}))
vi.mock('@/services/errorClassifier', () => ({ classifyError: vi.fn() }))
vi.mock('@/services/factGuard', () => ({ extractEntities: vi.fn(() => []), shouldTrigger: vi.fn(() => false), runFactGuard: vi.fn() }))
vi.mock('@/services/ruleEngine', () => ({ runRuleEngine: vi.fn(() => ({ matched: false })), buildRuleContext: vi.fn() }))
vi.mock('@/services/scheduleOptimizer', () => ({
  compilePrompt: vi.fn((t: string) => ({ template: t, slots: [] })),
  fillCompiledPrompt: vi.fn((c: any, v: any) => {
    let r = c.template || ''
    for (const [k, val] of Object.entries(v || {})) r = r.replaceAll(`{{${k}}}`, String(val))
    return r
  }),
  computeInputFingerprint: vi.fn(() => 'fp'),
  findCachedExecution: vi.fn(() => null),
  saveExecutionFingerprint: vi.fn(),
  computeStepOutputHash: vi.fn(() => 'hash'),
  findDirtySteps: vi.fn(() => new Set()),
  getTierConfig: vi.fn(() => ({ maxTokens: 4096, temperature: 0.5 })),
  computeStepPlan: vi.fn(),
  computeParallelGroups: vi.fn(),
  formatStepPlanVisualization: vi.fn(() => ''),
  isManifestAutoCompiled: vi.fn(() => false),
  simulateDataFlow: vi.fn(() => ({ ok: true, issues: [], summary: '' }))
}))
vi.mock('@/services/dagCheckpoint', () => ({ saveCheckpoint: vi.fn(), removeCheckpoint: vi.fn(), getCheckpoint: vi.fn().mockResolvedValue(null), createCheckpointId: vi.fn(() => 'cp-id') }))
vi.mock('@/services/knowledgeBase', () => ({ searchKnowledge: vi.fn().mockResolvedValue(['知识1', '知识2']) }))
vi.mock('@/services/secureStore', () => ({ storeGet: vi.fn().mockResolvedValue(null), storeSet: vi.fn().mockResolvedValue(undefined) }))

import { executeStep } from '@/services/macroExecutor'

function makeStep(o: Partial<L2DagStep> = {}): L2DagStep {
  return { step: 1, description: 'test', tool: 'shell_exec', depends_on: [], params: { command: 'echo hello' }, expectedOutput: 'hello', ...o }
}

function makeManifest(o: Partial<L2ToolManifest> = {}): L2ToolManifest {
  return {
    identity: { id: 'test', name: 'Test', version: '1.0.0', tier: 'L2', category: 'test', description: 'test' },
    visual: { color: '#fff', icon: '🔧', size: 1, spikes: 4, glowIntensity: 1, position: { x: 0, y: 0, z: 0 } },
    routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9 },
    execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 500, avgExecutionTime: 1000, cacheable: true },
    ...o
  }
}

describe('executeStep', () => {
  const userInput = { inputText: 'hello', filePath: undefined, context: undefined }
  const stepResults: Record<number, string> = {}
  let originalWindow: any
  let shellExecFn: any
  let fileReadFn: any
  let httpFetchFn: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockDebugStore.enabled = false
    mockDialogStore.dagPaused = false
    mockDialogStore.dagPausedStep = null
    mockDialogStore.awaitingTakeover = false

    shellExecFn = vi.fn().mockResolvedValue({ success: true, stdout: 'shell-output', stderr: '', code: 0 })
    fileReadFn = vi.fn().mockResolvedValue({ success: true, content: 'file-content', size: 100, isBinary: false, encoding: 'utf-8' })
    httpFetchFn = vi.fn().mockResolvedValue({ success: true, status: 200, body: 'http-body' })
    mockApiStore.chatCompletion.mockResolvedValue({ content: 'mocked-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })

    originalWindow = (globalThis as any).window
    ;(globalThis as any).window = { electronAPI: { shellExec: shellExecFn, fileRead: fileReadFn, httpFetch: httpFetchFn } }
    ;(globalThis as any).process = { env: { USERPROFILE: 'C:\\Users\\Test', HOME: '/home/test', APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' } }
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
  })

  it('正常执行shell_exec成功', async () => {
    const onSideEffect = vi.fn()
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, undefined, onSideEffect)
    expect(result.done).toBe(true)
    expect(result.result).toBe('shell-output')
  })

  it('shell_exec writeFileSync触发onSideEffect', async () => {
    shellExecFn.mockResolvedValueOnce({ success: true, stdout: 'written', stderr: '', code: 0 })
    const onSideEffect = vi.fn()
    const step = makeStep({ params: { command: "writeFileSync('/tmp/out.txt','data')" } })
    await executeStep(step, makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, undefined, onSideEffect)
    expect(onSideEffect).toHaveBeenCalledWith(1, 'shell_exec', 'create', '/tmp/out.txt')
  })

  it('read_file触发onSideEffect(read)', async () => {
    const onSideEffect = vi.fn()
    await executeStep(makeStep({ tool: 'read_file', params: { path: '/tmp/readme.md' } }), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, undefined, onSideEffect)
    expect(onSideEffect).toHaveBeenCalledWith(1, 'read_file', 'read', '/tmp/readme.md')
  })

  it('read_file file_path参数也触发onSideEffect', async () => {
    const onSideEffect = vi.fn()
    await executeStep(makeStep({ tool: 'read_file', params: { file_path: '/tmp/data.json' } }), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, undefined, onSideEffect)
    expect(onSideEffect).toHaveBeenCalledWith(1, 'read_file', 'read', '/tmp/data.json')
  })

  it('llm_generate不触发onSideEffect', async () => {
    const onSideEffect = vi.fn()
    await executeStep(makeStep({ tool: 'llm_generate', params: { prompt: 'test' } }), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, undefined, onSideEffect)
    expect(onSideEffect).not.toHaveBeenCalled()
  })

  it('macroSignal已aborted直接返回done:false', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, undefined, ac.signal)
    expect(result.done).toBe(false)
  })

  it('onStepStart和onStepDone被调用', async () => {
    const onStepStart = vi.fn()
    const onStepDone = vi.fn()
    await executeStep(makeStep({ step: 3 }), makeManifest(), userInput, stepResults, mockMcpStore, onStepStart, onStepDone)
    expect(onStepStart).toHaveBeenCalledWith(3, 'shell_exec')
    expect(onStepDone).toHaveBeenCalledWith(3, 'shell-output')
  })

  it('shell_exec失败时onStepFailed被调用', async () => {
    shellExecFn.mockRejectedValueOnce(new Error('exec failed'))
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockResolvedValueOnce({ category: 'logic', action: 'abort', fixHint: '' })
    const onStepFailed = vi.fn()
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, onStepFailed)
    expect(result.done).toBe(false)
    expect(onStepFailed).toHaveBeenCalledWith(1, expect.stringContaining('exec failed'))
  })

  it('规则引擎命中返回fromRule:true', async () => {
    const { runRuleEngine } = await import('@/services/ruleEngine')
    vi.mocked(runRuleEngine).mockReturnValueOnce({ matched: true, output: 'rule-output', matchedRuleId: 'r1' })
    const manifest = makeManifest({ ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false } })
    const result = await executeStep(makeStep({ tool: 'llm_generate', params: { prompt: 'test' } }), manifest, userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.result).toBe('rule-output')
    expect(result.fromRule).toBe(true)
    expect(result.ruleMatchedId).toBe('r1')
  })

  it('规则引擎不匹配走正常执行', async () => {
    const { runRuleEngine } = await import('@/services/ruleEngine')
    vi.mocked(runRuleEngine).mockReturnValueOnce({ matched: false })
    mockApiStore.chatCompletion.mockResolvedValueOnce({ content: 'normal-result', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })
    const manifest = makeManifest({ ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false } })
    const result = await executeStep(makeStep({ tool: 'llm_generate', params: { prompt: 'test' } }), manifest, userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.fromRule).toBeUndefined()
  })

  it('targetStep不匹配时跳过规则', async () => {
    const { runRuleEngine } = await import('@/services/ruleEngine')
    const manifest = makeManifest({ ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false, targetStep: 2 } })
    await executeStep(makeStep({ step: 1, tool: 'llm_generate' }), manifest, userInput, stepResults, mockMcpStore)
    expect(runRuleEngine).not.toHaveBeenCalled()
  })

  it('shell_exec不走规则引擎', async () => {
    const { runRuleEngine } = await import('@/services/ruleEngine')
    await executeStep(makeStep({ tool: 'shell_exec' }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(runRuleEngine).not.toHaveBeenCalled()
  })

  it('llm_generate正常执行', async () => {
    mockApiStore.chatCompletion.mockResolvedValueOnce({ content: 'llm-result', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })
    const result = await executeStep(makeStep({ tool: 'llm_generate', params: { prompt: 'test' } }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.result).toBe('llm-result')
  })

  it('http_request正常执行', async () => {
    const result = await executeStep(makeStep({ tool: 'http_request', params: { url: 'https://example.com' } }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
  })

  it('knowledge_search正常执行', async () => {
    const result = await executeStep(makeStep({ tool: 'knowledge_search', params: { query: 'test' } }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
  })

  it('retry_with_fix自动npm install后重试成功', async () => {
    let callCount = 0
    shellExecFn.mockImplementation((arg: any) => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error("cannot find module 'lodash'"))
      if (callCount === 2) return Promise.resolve({ success: true, stdout: 'installed', stderr: '', code: 0 })
      return Promise.resolve({ success: true, stdout: 'retry-output', stderr: '', code: 0 })
    })
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockResolvedValueOnce({ category: 'resource_missing', action: 'retry_with_fix', fixHint: 'install lodash' })
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.result).toBe('retry-output')
  })

  it('retry action重试成功', async () => {
    let callCount = 0
    shellExecFn.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('transient'))
      return Promise.resolve({ success: true, stdout: 'retry-ok', stderr: '', code: 0 })
    })
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockResolvedValueOnce({ category: 'network', action: 'retry', fixHint: '' })
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.result).toBe('retry-ok')
  })

  it('abort action返回done:false', async () => {
    shellExecFn.mockRejectedValueOnce(new Error('fatal'))
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockResolvedValueOnce({ category: 'permission', action: 'abort', fixHint: '' })
    const onStepFailed = vi.fn()
    const result = await executeStep(makeStep(), makeManifest(), userInput, stepResults, mockMcpStore, undefined, undefined, onStepFailed)
    expect(result.done).toBe(false)
    expect(onStepFailed).toHaveBeenCalled()
  })

  it('fallback步骤执行成功', async () => {
    shellExecFn.mockRejectedValueOnce(new Error('primary failed'))
    mockApiStore.chatCompletion.mockResolvedValueOnce({ content: 'fallback-ok', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockResolvedValue({ category: 'logic', action: 'switch_tool', fixHint: '' })
    const result = await executeStep(makeStep({ fallback: 'llm_generate', params: { command: 'echo hello', prompt: 'test' } }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.usedFallback).toBe(true)
  })

  it('分类器异常fallthrough到fallback', async () => {
    shellExecFn.mockRejectedValueOnce(new Error('some error'))
    mockApiStore.chatCompletion.mockResolvedValueOnce({ content: 'fallback-ok', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })
    const { classifyError } = await import('@/services/errorClassifier')
    vi.mocked(classifyError).mockRejectedValueOnce(new Error('classifier crashed'))
    const result = await executeStep(makeStep({ fallback: 'llm_generate', params: { command: 'echo hello', prompt: 'test' } }), makeManifest(), userInput, stepResults, mockMcpStore)
    expect(result.done).toBe(true)
    expect(result.usedFallback).toBe(true)
  })
})
