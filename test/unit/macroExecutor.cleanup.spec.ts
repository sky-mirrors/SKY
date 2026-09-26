import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { L2DagStep, L2ToolManifest } from '@/models'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

/**
 * P1 收口验收：H-4（单步就绪路径条件求值须传 fromStep）+ H-6（executeMacro 异常路径保底收口）。
 * 单列一个 spec，避免给既有 macroExecutor.macro.spec 引入 workflowLogStore mock 而改变其行为。
 */

const { mockCompleteLog, mockCreateLog, mockUpdateNodeStatus } = vi.hoisted(() => ({
  mockCompleteLog: vi.fn(),
  mockCreateLog: vi.fn(() => ({ id: 'wf-log-1' })),
  mockUpdateNodeStatus: vi.fn()
}))

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

vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => mockDebugStore) }))
vi.mock('@/stores/dialogStore', () => ({ useDialogStore: vi.fn(() => mockDialogStore) }))
vi.mock('@/stores/feedbackStore', () => ({ useFeedbackStore: vi.fn(() => mockFeedbackStore), computeQueryFingerprint: vi.fn(() => 'qfp') }))
vi.mock('@/stores/workflowLogStore', () => ({
  useWorkflowLogStore: vi.fn(() => ({
    createLog: mockCreateLog,
    updateNodeStatus: mockUpdateNodeStatus,
    completeLog: mockCompleteLog
  }))
}))
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
    for (const [k, val] of Object.entries(v || {})) r = r.replaceAll(`{{${k}}}`, String(val))
    return r
  }),
  computeInputFingerprint: vi.fn(() => 'fp'),
  findCachedExecution: vi.fn(() => null),
  saveExecutionFingerprint: vi.fn(),
  computeStepOutputHash: vi.fn(() => 'hash'),
  findDirtySteps: vi.fn(() => new Set()),
  getTierConfig: vi.fn(() => ({ maxTokens: 4096, temperature: 0.5 })),
  computeStepPlan: vi.fn((steps: any[]) => ({ willReuse: [], willSkip: [], willExecute: steps })),
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
    identity: { id: 'test-cleanup', name: 'Test', version: '1.0.0', tier: 'L2', category: 'test', description: 'test' },
    visual: { color: '#fff', icon: '🔧', size: 1, spikes: 4, glowIntensity: 1, position: { x: 0, y: 0, z: 0 } },
    routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9 },
    execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 500, avgExecutionTime: 1000, cacheable: true },
    ...o
  } as L2ToolManifest
}

const step = (n: number, tool: string, deps: number[], params: Record<string, string>): L2DagStep =>
  ({ step: n, description: `s${n}`, tool, depends_on: deps, params, expectedOutput: `s${n}` })

describe('P1 收口：H-4 / H-6', () => {
  let originalWindow: any
  let shellExecFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vault.clearCache()
    mockCreateLog.mockReturnValue({ id: 'wf-log-1' })
    shellExecFn = vi.fn().mockResolvedValue({ success: true, stdout: 'shell-output', stderr: '', code: 0 })
    originalWindow = (globalThis as any).window
    ;(globalThis as any).window = {
      electronAPI: {
        shellExec: shellExecFn,
        fileRead: vi.fn().mockResolvedValue({ success: true, content: 'c', size: 1, isBinary: false, encoding: 'utf-8' }),
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
    globalBus.registerHandler('api:chat-completion', () => ({ content: 'x', toolCalls: [], usage: {} }))
    globalBus.registerHandler('dialog:confirm-risk', () => true)
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
    globalBus.clear()
  })

  it('H-4：单步就绪路径的条件求值只扫来源步骤（不扫无关步骤里的数字）', async () => {
    // step1 产出纯数字、step2 产出无数字的文本；条件挂在 step2 上（fromStep=2）。
    // 修复前 evaluateCondition 漏传 fromStep ⇒ 扫全部结果 ⇒ 命中 step1 的 999999 而误判为真、不跳过；
    // 修复后只扫 step2 的 'no-digits' ⇒ 判假 ⇒ 正确跳过 step3。
    let call = 0
    shellExecFn.mockImplementation(async () => {
      call++
      return { success: true, stdout: call === 1 ? '999999' : 'no-digits', stderr: '', code: 0 }
    })
    const steps: L2DagStep[] = [
      step(1, 'shell_exec', [], { command: 'echo 999999' }),
      step(2, 'shell_exec', [1], { command: 'echo no-digits' }),
      step(3, 'shell_exec', [2], { command: 'echo should-be-skipped' })
    ]
    const manifest = makeManifest({
      execution: {
        mode: 'macro',
        paramMapping: { slots: [], bindings: [] },
        dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 },
        conditions: [{ fromStep: 2, toStep: 3, expr: '$.output.amount > 100', onFailure: 'skip' }]
      }
    } as Partial<L2ToolManifest>)

    const result = await executeMacro(manifest, { inputText: 'test' })

    expect(result.results[1]).toBe('999999')
    expect(result.results[2]).toBe('no-digits')
    expect(result.results[3]).toBeUndefined()
  })

  it('H-6：执行中抛出异常时仍保底注销 abort 控制器、并把时间线标 failed', async () => {
    const cleared: unknown[] = []
    globalBus.on('debug:clear-abort', (p: unknown) => cleared.push(p))

    const steps: L2DagStep[] = [step(1, 'shell_exec', [], { command: 'echo hi' })]
    const manifest = makeManifest({
      execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } }
    } as Partial<L2ToolManifest>)
    // onStepStart 在 executeStep 的 try 之外被调用 ⇒ 抛出会一路逃出 executeMacro
    const onStepStart = vi.fn(() => { throw new Error('boom-from-callback') })

    await expect(executeMacro(manifest, { inputText: 'test' }, onStepStart)).rejects.toThrow('boom-from-callback')

    expect(cleared.length).toBe(1)
    expect(mockCompleteLog).toHaveBeenCalledWith('wf-log-1', 'failed')
  })

  it('H-6：正常收口路径不被 finally 二次改写（仍报 completed）', async () => {
    const steps: L2DagStep[] = [step(1, 'shell_exec', [], { command: 'echo ok' })]
    const manifest = makeManifest({
      execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps, fallbackStrategy: 'retry', maxRetries: 1 } }
    } as Partial<L2ToolManifest>)

    await executeMacro(manifest, { inputText: 'test' })

    expect(mockCompleteLog).toHaveBeenCalledTimes(1)
    expect(mockCompleteLog).toHaveBeenCalledWith('wf-log-1', 'completed')
  })
})
