import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  connections: [],
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
    identity: { id: 'test', name: 'Test', version: '1.0.0', tier: 'L2', category: 'test', description: 'test' },
    visual: { color: '#fff', icon: '🔧', size: 1, spikes: 4, glowIntensity: 1, position: { x: 0, y: 0, z: 0 } },
    routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9 },
    execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 500, avgExecutionTime: 1000, cacheable: true },
    ...o
  }
}

describe('executeMacro', () => {
  let originalWindow: any
  let shellExecFn: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockDebugStore.enabled = false
    mockDialogStore.dagPaused = false
    mockDialogStore.dagPausedStep = null
    mockDialogStore.awaitingTakeover = false
    mockApiStore.chatCompletion.mockResolvedValue({ content: 'mocked-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })

    shellExecFn = vi.fn().mockResolvedValue({ success: true, stdout: 'shell-output', stderr: '', code: 0 })
    originalWindow = (globalThis as any).window
    ;(globalThis as any).window = { electronAPI: { shellExec: shellExecFn, fileRead: vi.fn().mockResolvedValue({ success: true, content: 'file-content', size: 100, isBinary: false }), httpFetch: vi.fn().mockResolvedValue({ success: true, status: 200, body: 'http-body' }) } }
    ;(globalThis as any).process = { env: { USERPROFILE: 'C:\\Users\\Test', HOME: '/home/test', APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' } }
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
  })

  it('单步骤shell_exec执行成功', async () => {
    const steps: L2DagStep[] = [{ step: 1, description: 'run command', tool: 'shell_exec', depends_on: [], params: { command: 'echo hello' }, expectedOutput: 'hello' }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toBe('shell-output')
    expect(result.lastResult).toBe('shell-output')
    expect(result.lineage.length).toBe(1)
    expect(result.lineage[0].source).toBe('tool_call')
  })

  it('多步骤顺序执行', async () => {
    const steps: L2DagStep[] = [
      { step: 1, description: 'step1', tool: 'shell_exec', depends_on: [], params: { command: 'echo step1' }, expectedOutput: 'step1' },
      { step: 2, description: 'step2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo step2' }, expectedOutput: 'step2' }
    ]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toBe('shell-output')
    expect(result.results[2]).toBe('shell-output')
    expect(result.lineage.length).toBe(2)
  })

  it('llm_generate步骤执行成功', async () => {
    mockApiStore.chatCompletion.mockResolvedValue({ content: 'llm-output', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })
    const steps: L2DagStep[] = [{ step: 1, description: 'generate', tool: 'llm_generate', depends_on: [], params: { prompt: 'test prompt' }, expectedOutput: 'llm' }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toBe('llm-output')
    expect(result.lineage[0].source).toContain('llm_')
  })

  it('onStepStart/onStepDone回调被调用', async () => {
    const onStepStart = vi.fn()
    const onStepDone = vi.fn()
    const steps: L2DagStep[] = [{ step: 1, description: 'run', tool: 'shell_exec', depends_on: [], params: { command: 'echo hello' }, expectedOutput: 'hello' }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    await executeMacro(manifest, { inputText: 'test' }, onStepStart, onStepDone)
    expect(onStepStart).toHaveBeenCalledWith(1, 'shell_exec')
    expect(onStepDone).toHaveBeenCalledWith(1, 'shell-output')
  })

  it('onPlanPreview回调被调用', async () => {
    const onPlanPreview = vi.fn()
    const steps: L2DagStep[] = [{ step: 1, description: 'run', tool: 'shell_exec', depends_on: [], params: { command: 'echo hello' }, expectedOutput: 'hello' }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    await executeMacro(manifest, { inputText: 'test' }, undefined, undefined, undefined, undefined, undefined, onPlanPreview)
    expect(onPlanPreview).toHaveBeenCalled()
  })

  it('无步骤返回空结果', async () => {
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(Object.keys(result.results).length).toBe(0)
    expect(result.lastResult).toBe('执行完成')
  })

  it('parallel步骤并行执行', async () => {
    const steps: L2DagStep[] = [
      { step: 1, description: 'parallel1', tool: 'shell_exec', depends_on: [], params: { command: 'echo a' }, expectedOutput: 'a' },
      { step: 2, description: 'parallel2', tool: 'shell_exec', depends_on: [], params: { command: 'echo b' }, expectedOutput: 'b' }
    ]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toBe('shell-output')
    expect(result.results[2]).toBe('shell-output')
    expect(result.lineage.length).toBe(2)
  })

  it('replayPriorResults跳过已完成步骤', async () => {
    const steps: L2DagStep[] = [
      { step: 1, description: 'step1', tool: 'shell_exec', depends_on: [], params: { command: 'echo a' }, expectedOutput: 'a' },
      { step: 2, description: 'step2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo b' }, expectedOutput: 'b' }
    ]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' }, undefined, undefined, undefined, undefined, undefined, undefined, { 1: 'replayed-result' })
    expect(result.results[1]).toBe('replayed-result')
    expect(result.results[2]).toBe('shell-output')
    expect(result.savedTokens).toBeGreaterThan(0)
    expect(result.lineage[0].source).toBe('replay_reuse')
  })

  it('direct模式直接调用LLM', async () => {
    mockApiStore.chatCompletion.mockResolvedValue({ content: 'direct-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })
    const manifest = makeManifest({
      execution: {
        mode: 'direct',
        directCall: { promptTemplate: '分析: {{input}}', maxTokens: 2048 },
        paramMapping: { slots: [], bindings: [] },
        dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 }
      }
    })
    const result = await executeMacro(manifest, { inputText: 'hello' })
    expect(result.lastResult).toBe('direct-llm-response')
  })

  it('条件跳过步骤不执行', async () => {
    const steps: L2DagStep[] = [
      { step: 1, description: 'step1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 500' }, expectedOutput: '500' },
      { step: 2, description: 'step2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo skip-me' }, expectedOutput: 'skip' }
    ]
    const manifest = makeManifest({
      execution: {
        mode: 'macro',
        paramMapping: { slots: [], bindings: [] },
        dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 },
        conditions: [{ fromStep: 1, toStep: 2, expr: "$.output.contains('NO_MATCH')", onFailure: 'skip' }]
      }
    })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toBe('shell-output')
    expect(result.results[2]).toBeUndefined()
  })

  it('knowledge_search步骤执行成功', async () => {
    const steps: L2DagStep[] = [{ step: 1, description: 'search', tool: 'knowledge_search', depends_on: [], params: { query: 'test' }, expectedOutput: 'knowledge' }]
    const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
    const result = await executeMacro(manifest, { inputText: 'test' })
    expect(result.results[1]).toContain('知识1')
  })
})
