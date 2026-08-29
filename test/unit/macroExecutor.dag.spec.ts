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
vi.mock('@/services/ruleEngine', () => ({
  runRuleEngine: vi.fn(() => ({ matched: false })),
  buildRuleContext: vi.fn()
}))
vi.mock('@/services/knowledgeBase', () => ({ searchKnowledge: vi.fn().mockResolvedValue(['知识1']) }))
vi.mock('@/services/secureStore', () => ({ storeGet: vi.fn().mockResolvedValue(null), storeSet: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/services/dagCheckpoint', () => ({
  saveCheckpoint: vi.fn(),
  removeCheckpoint: vi.fn(),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  createCheckpointId: vi.fn(() => 'cp-id')
}))

const { mockComputeStepPlan, mockIsManifestAutoCompiled, mockFindCachedExecution } = vi.hoisted(() => ({
  mockComputeStepPlan: vi.fn((steps: any[], dirty: any, skip: any, cached: any) => ({
    willReuse: [],
    willSkip: [],
    willExecute: steps
  })),
  mockIsManifestAutoCompiled: vi.fn(() => false),
  mockFindCachedExecution: vi.fn(() => null)
}))

vi.mock('@/services/scheduleOptimizer', () => ({
  compilePrompt: vi.fn((t: string) => ({ template: t, slots: [] })),
  fillCompiledPrompt: vi.fn((c: any, v: any) => {
    let r = c.template || ''
    for (const [k, val] of Object.entries(v || {})) r = r.replaceAll(`{{${k}}}`, String(val))
    return r
  }),
  computeInputFingerprint: vi.fn(() => 'fp'),
  findCachedExecution: mockFindCachedExecution,
  saveExecutionFingerprint: vi.fn(),
  computeStepOutputHash: vi.fn(() => 'hash'),
  findDirtySteps: vi.fn(() => new Set()),
  getTierConfig: vi.fn(() => ({ maxTokens: 4096, temperature: 0.5 })),
  computeStepPlan: mockComputeStepPlan,
  computeParallelGroups: vi.fn(() => []),
  formatStepPlanVisualization: vi.fn(() => ''),
  isManifestAutoCompiled: mockIsManifestAutoCompiled,
  simulateDataFlow: vi.fn(() => ({ ok: true, issues: [], summary: '' }))
}))

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

describe('executeMacro DAG编排', () => {
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

  describe('依赖解析-拓扑排序', () => {
    it('Step2依赖Step1,Step1完成前Step2不启动', async () => {
      const execOrder: number[] = []
      shellExecFn.mockImplementation(async () => {
        execOrder.push(execOrder.length + 1)
        return { success: true, stdout: `step${execOrder.length}-output`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'first', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 'second', tool: 'shell_exec', depends_on: [1], params: { command: 'echo 2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.results[1]).toBeDefined()
      expect(result.results[2]).toBeDefined()
      expect(execOrder).toEqual([1, 2])
    })

    it('3步链式依赖A→B→C,严格顺序执行', async () => {
      const execOrder: string[] = []
      shellExecFn.mockImplementation(async (arg: any) => {
        execOrder.push(arg.command)
        return { success: true, stdout: `${arg.command}-done`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'A', tool: 'shell_exec', depends_on: [], params: { command: 'A' }, expectedOutput: 'A' },
        { step: 2, description: 'B', tool: 'shell_exec', depends_on: [1], params: { command: 'B' }, expectedOutput: 'B' },
        { step: 3, description: 'C', tool: 'shell_exec', depends_on: [2], params: { command: 'C' }, expectedOutput: 'C' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(execOrder).toEqual(['A', 'B', 'C'])
      expect(result.results[1]).toContain('A')
      expect(result.results[2]).toContain('B')
      expect(result.results[3]).toContain('C')
    })

    it('菱形依赖: D依赖B和C, B和C依赖A', async () => {
      const execOrder: string[] = []
      shellExecFn.mockImplementation(async (arg: any) => {
        execOrder.push(arg.command)
        return { success: true, stdout: `${arg.command}-done`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'A', tool: 'shell_exec', depends_on: [], params: { command: 'A' }, expectedOutput: 'A' },
        { step: 2, description: 'B', tool: 'shell_exec', depends_on: [1], params: { command: 'B' }, expectedOutput: 'B' },
        { step: 3, description: 'C', tool: 'shell_exec', depends_on: [1], params: { command: 'C' }, expectedOutput: 'C' },
        { step: 4, description: 'D', tool: 'shell_exec', depends_on: [2, 3], params: { command: 'D' }, expectedOutput: 'D' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(execOrder[0]).toBe('A')
      expect(execOrder.indexOf('B')).toBeLessThan(execOrder.indexOf('D'))
      expect(execOrder.indexOf('C')).toBeLessThan(execOrder.indexOf('D'))
      expect(result.results[4]).toContain('D')
    })
  })

  describe('并行执行', () => {
    it('3个互不依赖步骤全部执行完成', async () => {
      const callTimestamps: number[] = []
      shellExecFn.mockImplementation(async () => {
        callTimestamps.push(Date.now())
        return { success: true, stdout: 'parallel-output', stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'p1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 'p2', tool: 'shell_exec', depends_on: [], params: { command: 'echo 2' }, expectedOutput: '2' },
        { step: 3, description: 'p3', tool: 'shell_exec', depends_on: [], params: { command: 'echo 3' }, expectedOutput: '3' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })

      const startTime = Date.now()
      const result = await executeMacro(manifest, { inputText: 'test' })
      const elapsed = Date.now() - startTime

      expect(result.results[1]).toBe('parallel-output')
      expect(result.results[2]).toBe('parallel-output')
      expect(result.results[3]).toBe('parallel-output')
      expect(callTimestamps.length).toBe(3)
      expect(elapsed).toBeLessThan(2000)
    })

    it('并行步骤通过Promise.all同时启动(时间戳接近)', async () => {
      const startTimestamps: number[] = []
      shellExecFn.mockImplementation(async () => {
        startTimestamps.push(Date.now())
        return { success: true, stdout: 'parallel-output', stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'p1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 'p2', tool: 'shell_exec', depends_on: [], params: { command: 'echo 2' }, expectedOutput: '2' },
        { step: 3, description: 'p3', tool: 'shell_exec', depends_on: [], params: { command: 'echo 3' }, expectedOutput: '3' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      await executeMacro(manifest, { inputText: 'test' })

      const maxSpread = Math.max(...startTimestamps) - Math.min(...startTimestamps)
      expect(maxSpread).toBeLessThan(50)
    })

    it('并行+顺序混合: A先执行, B和C并行, D最后', async () => {
      const execOrder: string[] = []
      shellExecFn.mockImplementation(async (arg: any) => {
        execOrder.push(arg.command)
        return { success: true, stdout: `${arg.command}-done`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 'A', tool: 'shell_exec', depends_on: [], params: { command: 'A' }, expectedOutput: 'A' },
        { step: 2, description: 'B', tool: 'shell_exec', depends_on: [1], params: { command: 'B' }, expectedOutput: 'B' },
        { step: 3, description: 'C', tool: 'shell_exec', depends_on: [1], params: { command: 'C' }, expectedOutput: 'C' },
        { step: 4, description: 'D', tool: 'shell_exec', depends_on: [2, 3], params: { command: 'D' }, expectedOutput: 'D' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(execOrder[0]).toBe('A')
      expect(execOrder.indexOf('B')).toBeLessThan(execOrder.indexOf('D'))
      expect(execOrder.indexOf('C')).toBeLessThan(execOrder.indexOf('D'))
      expect(result.results[4]).toContain('D')
    })
  })

  describe('失败快速中断', () => {
    it('Step2失败时Step3(依赖Step2)不执行', async () => {
      const { classifyError } = await import('@/services/errorClassifier')
      vi.mocked(classifyError).mockResolvedValue({ category: 'fatal', action: 'abort', fixHint: '' })

      let callCount = 0
      shellExecFn.mockImplementation(async () => {
        callCount++
        if (callCount === 2) return Promise.reject(new Error('step2 crashed'))
        return { success: true, stdout: `step${callCount}-ok`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 's1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 's2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo 2' }, expectedOutput: '2' },
        { step: 3, description: 's3', tool: 'shell_exec', depends_on: [2], params: { command: 'echo 3' }, expectedOutput: '3' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.results[1]).toBeDefined()
      expect(result.results[3]).toBeUndefined()
      expect(callCount).toBeLessThan(3)
    })

    it('ask_user策略下失败立即中断DAG', async () => {
      const { classifyError } = await import('@/services/errorClassifier')
      vi.mocked(classifyError).mockResolvedValue({ category: 'fatal', action: 'abort', fixHint: '' })

      let callCount = 0
      shellExecFn.mockImplementation(async () => {
        callCount++
        if (callCount <= 2) return Promise.reject(new Error('fatal error'))
        return { success: true, stdout: 'should-not-run', stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 's1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 's2', tool: 'shell_exec', depends_on: [], params: { command: 'echo 2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'ask_user', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.lastResult).toBe('执行中断')
    })

    it('Step2失败→Step3标记为未执行,结果不含Step3', async () => {
      const { classifyError } = await import('@/services/errorClassifier')
      vi.mocked(classifyError).mockResolvedValue({ category: 'fatal', action: 'abort', fixHint: '' })

      let callCount = 0
      shellExecFn.mockImplementation(async () => {
        callCount++
        if (callCount === 1) return { success: true, stdout: 'step1-ok', stderr: '', code: 0 }
        return Promise.reject(new Error('step2 failed'))
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 's1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 's2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo 2' }, expectedOutput: '2' },
        { step: 3, description: 's3', tool: 'shell_exec', depends_on: [2], params: { command: 'echo 3' }, expectedOutput: '3' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.results[1]).toBe('step1-ok')
      expect(result.results[2]).toBeUndefined()
      expect(result.results[3]).toBeUndefined()
      expect(result.lineage.filter(l => l.step === 3).length).toBe(0)
    })
  })

  describe('结果聚合', () => {
    it('stepResults包含每步输出且顺序与输入一致', async () => {
      shellExecFn.mockImplementation(async (arg: any) => {
        return { success: true, stdout: `output-for-${arg.command}`, stderr: '', code: 0 }
      })

      const steps: L2DagStep[] = [
        { step: 1, description: 's1', tool: 'shell_exec', depends_on: [], params: { command: 'cmd-a' }, expectedOutput: 'a' },
        { step: 2, description: 's2', tool: 'shell_exec', depends_on: [1], params: { command: 'cmd-b' }, expectedOutput: 'b' },
        { step: 3, description: 's3', tool: 'shell_exec', depends_on: [1], params: { command: 'cmd-c' }, expectedOutput: 'c' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.results[1]).toBe('output-for-cmd-a')
      expect(result.results[2]).toBe('output-for-cmd-b')
      expect(result.results[3]).toBe('output-for-cmd-c')
      expect(result.lastResult).toBeDefined()
    })

    it('lineage包含每步来源且顺序与执行一致', async () => {
      const steps: L2DagStep[] = [
        { step: 1, description: 's1', tool: 'shell_exec', depends_on: [], params: { command: 'echo 1' }, expectedOutput: '1' },
        { step: 2, description: 's2', tool: 'shell_exec', depends_on: [1], params: { command: 'echo 2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.lineage.length).toBe(2)
      expect(result.lineage[0].step).toBe(1)
      expect(result.lineage[1].step).toBe(2)
      expect(result.lineage[0].source).toBe('tool_call')
    })

    it('混合工具类型结果正确聚合', async () => {
      mockApiStore.chatCompletion.mockResolvedValue({ content: 'llm-analysis', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })

      const steps: L2DagStep[] = [
        { step: 1, description: 'shell', tool: 'shell_exec', depends_on: [], params: { command: 'echo data' }, expectedOutput: 'data' },
        { step: 2, description: 'llm', tool: 'llm_generate', depends_on: [1], params: { prompt: 'analyze' }, expectedOutput: 'analysis' }
      ]
      const manifest = makeManifest({ execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } } })
      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(result.results[1]).toBe('shell-output')
      expect(result.results[2]).toBe('llm-analysis')
    })
  })

  describe('RaaP零LLM路径', () => {
    it('规则引擎全部命中时chatCompletion未被调用(Token=0)', async () => {
      const { runRuleEngine } = await import('@/services/ruleEngine')
      vi.mocked(runRuleEngine).mockReturnValue({ matched: true, output: 'rule-output-1', matchedRuleId: 'r1' })

      const steps: L2DagStep[] = [
        { step: 1, description: 'llm1', tool: 'llm_generate', depends_on: [], params: { prompt: 'test1' }, expectedOutput: '1' },
        { step: 2, description: 'llm2', tool: 'llm_generate', depends_on: [1], params: { prompt: 'test2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({
        ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false },
        execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } }
      })

      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(mockApiStore.chatCompletion).not.toHaveBeenCalled()
      expect(result.results[1]).toBe('rule-output-1')
      expect(result.lineage.every(l => l.source === 'rule_engine')).toBe(true)
    })

    it('规则引擎部分命中时仅未命中的步骤调LLM', async () => {
      const { runRuleEngine } = await import('@/services/ruleEngine')
      vi.mocked(runRuleEngine)
        .mockReturnValueOnce({ matched: true, output: 'rule-output-1', matchedRuleId: 'r1' })
        .mockReturnValueOnce({ matched: false })

      mockApiStore.chatCompletion.mockResolvedValue({ content: 'llm-fallback', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })

      const steps: L2DagStep[] = [
        { step: 1, description: 'llm1', tool: 'llm_generate', depends_on: [], params: { prompt: 'test1' }, expectedOutput: '1' },
        { step: 2, description: 'llm2', tool: 'llm_generate', depends_on: [1], params: { prompt: 'test2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({
        ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false },
        execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } }
      })

      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(mockApiStore.chatCompletion).toHaveBeenCalledTimes(1)
      expect(result.results[1]).toBe('rule-output-1')
      expect(result.results[2]).toBe('llm-fallback')
      expect(result.lineage[0].source).toBe('rule_engine')
      expect(result.lineage[1].source).toContain('llm_')
    })

    it('规则引擎全部未命中时所有步骤走LLM', async () => {
      const { runRuleEngine } = await import('@/services/ruleEngine')
      vi.mocked(runRuleEngine).mockReturnValue({ matched: false })

      mockApiStore.chatCompletion.mockResolvedValue({ content: 'llm-response', toolCalls: [], usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } })

      const steps: L2DagStep[] = [
        { step: 1, description: 'llm1', tool: 'llm_generate', depends_on: [], params: { prompt: 'test1' }, expectedOutput: '1' },
        { step: 2, description: 'llm2', tool: 'llm_generate', depends_on: [1], params: { prompt: 'test2' }, expectedOutput: '2' }
      ]
      const manifest = makeManifest({
        ruleBasedFallback: { enabled: true, coverage: 1, rules: [], fallbackToLLM: false },
        execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } }
      })

      const result = await executeMacro(manifest, { inputText: 'test' })

      expect(mockApiStore.chatCompletion).toHaveBeenCalledTimes(2)
      expect(result.lineage.every(l => l.source.includes('llm_'))).toBe(true)
    })
  })
})
