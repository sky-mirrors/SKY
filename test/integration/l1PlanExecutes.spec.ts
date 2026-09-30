import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * L1 用户级验收（2026-09-30 深化）：把「漏斗产出」与「工具真实执行」串成一条链。
 *
 * 前两个 spec 各验一半：
 *   · l1RoutingEndToEnd.spec.ts —— 真实漏斗（不 mock l0SkillRouter）产出 l1-* 计划；
 *   · l1HandlerDispatch.spec.ts —— callToolDirectWithTier 对 l1-* 的分派执行。
 * 本文件验**组合**：用户输入 → 漏斗停在 L1 → 用该计划的步骤去执行 → 拿到真实结果。
 * 这正是 dialogStore 原生快路径（isAllNative）走的那条链。
 */

const mockDebugStore = {
  enabled: false, emitEvent: vi.fn(), recordProbe: vi.fn(),
  registerAbortController: vi.fn(), clearAbortController: vi.fn()
}
const mockDialogStore = {
  dagPaused: false, dagPausedStep: null as number | null, awaitingTakeover: false,
  takeoverStepNum: null as number | null, addSystemNotice: vi.fn(),
  requestRiskConfirm: vi.fn().mockResolvedValue(true), requestTakeover: vi.fn().mockResolvedValue('takeover-result'),
  clearAllPausePoints: vi.fn(), awaitingRiskConfirm: false, riskAction: null
}
const mockFeedbackStore = {
  addSideEffectManifest: vi.fn(), recordFeedback: vi.fn(), getWeightModifier: vi.fn().mockReturnValue(0)
}

vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => mockDebugStore) }))
vi.mock('@/stores/dialogStore', () => ({ useDialogStore: vi.fn(() => mockDialogStore) }))
vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: vi.fn(() => mockFeedbackStore),
  computeQueryFingerprint: vi.fn().mockReturnValue('mock-fingerprint')
}))
vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn().mockReturnValue(false),
  buildActionManifest: vi.fn().mockReturnValue({}),
  dualEngineValidate: vi.fn().mockResolvedValue({ intent_match: true, parameter_sane: true, risk_level: 'low' }),
  isPathUnsafe: vi.fn().mockReturnValue(false)
}))
vi.mock('@/services/errorClassifier', () => ({
  classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'abort', fixHint: '' })
}))
vi.mock('@/services/factGuard', () => ({
  extractEntities: vi.fn().mockReturnValue([]), extractEntitiesAll: vi.fn().mockReturnValue([]),
  shouldTrigger: vi.fn().mockReturnValue(false),
  runFactGuardV2: vi.fn().mockReturnValue({ ok: true, conflicts: [], hallucinatedEntities: [], severity: 'ok', correctedOutput: null, summary: 'ok' })
}))
vi.mock('@/services/ruleEngine', () => ({
  runRuleEngine: vi.fn().mockReturnValue({ matched: false, output: '' }),
  buildRuleContext: vi.fn().mockReturnValue({})
}))
vi.mock('@/services/dagCheckpoint', () => ({
  saveCheckpoint: vi.fn(), removeCheckpoint: vi.fn(),
  getCheckpoint: vi.fn().mockResolvedValue(null), createCheckpointId: vi.fn().mockReturnValue('cp-mock')
}))
vi.mock('@/services/secureStore', () => ({
  storeGet: vi.fn().mockResolvedValue(null), storeSet: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/kernel/plugins/llm', () => ({
  getLLM: () => ({ chatCompletion: vi.fn().mockResolvedValue({ content: 'DEFAULT' }) })
}))
vi.mock('@/services/knowledgeBase', () => ({
  knowledgeAdapter: { search: vi.fn().mockResolvedValue([]) },
  searchKnowledge: vi.fn().mockResolvedValue([]),
  hybridSearch: vi.fn().mockResolvedValue([])
}))
vi.mock('@/services/memory', () => ({
  memoryAdapter: { getContext: vi.fn().mockResolvedValue('') },
  getContextWindow: vi.fn().mockReturnValue({ messages: [], summary: null }),
  addMessage: vi.fn()
}))
vi.mock('@/services/promptTranslator', () => ({
  compileToChain: vi.fn().mockResolvedValue({ steps: [] }),
  translateIntent: vi.fn().mockResolvedValue(null),
  planTask: vi.fn().mockResolvedValue({ intent: 'x', needs: [], steps: [] })
}))
vi.mock('@/services/toolRetrieval', () => ({
  buildToolIndex: vi.fn().mockResolvedValue([]),
  universalMatch: vi.fn().mockResolvedValue(null),
  getTop3CandidatesUniversal: vi.fn().mockReturnValue([]),
  llmFallback: vi.fn().mockResolvedValue(null),
  extractCoreKeywords: vi.fn().mockReturnValue([])
}))

import { runFunnel, type LayerResult } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import { createDefaultLayers, type DefaultKernelContext } from '@/kernels/default'
import { callToolDirectWithTier } from '@/services/macroExecutor'
import { globalBus } from '@/kernel/bus'
import l2Manifests from '@/data/l2Manifests'

function makeCtx(): DefaultKernelContext {
  return {
    allL2Manifests: l2Manifests,
    mcpTools: [],
    visibleL2Ids: [],
    lastAssistantContent: '',
    recentUserMsg: '',
    chatCompletion: vi.fn().mockResolvedValue({ content: '' })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalBus.registerHandler('llm:get-gateway', () => ({
    chatCompletion: vi.fn().mockResolvedValue('mock-llm'),
    listModels: () => [], switchProvider: vi.fn(), switchModel: vi.fn(), getActiveProvider: () => null
  }))
  ;(globalThis as any).window = {
    electronAPI: {
      platform: 'win32',
      storeRead: vi.fn().mockResolvedValue(null),
      storeWrite: vi.fn().mockResolvedValue(undefined),
      resolvePath: vi.fn().mockResolvedValue('C:\\Users\\Test')
    }
  }
})

describe('L1 用户级验收：漏斗产出 → 工具真实执行', () => {
  it('「把这段内容排版一下」→ L1 命中 → 执行该计划步骤 → 拿到 beautify 结果', async () => {
    // ---- 前半：真实漏斗（不 mock l0SkillRouter / createDefaultLayers）----
    const outcome = await runFunnel(
      { layers: createDefaultLayers(), hooks: new HookRunner<LayerResult>() },
      '把这段内容排版一下',
      makeCtx()
    )
    expect(outcome.kind).toBe('plan')
    expect(outcome.source).toBe('L1')
    if (outcome.kind !== 'plan') return

    const step = outcome.plan.steps[0]
    expect(step.tool).toBe('l1-result-beautifier')

    // ---- 后半：把漏斗产出的步骤交给真实 dispatch 执行（dialogStore 原生快路径同款调用）----
    const result = await callToolDirectWithTier(step.tool, step.params)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    // 真实 beautify(html) 的产物，不是 { output: ... } 的 JSON 包裹
    expect(result).not.toContain('"output"')
  })
})
