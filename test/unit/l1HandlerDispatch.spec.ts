import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * L1 能力直调分派测试（2026-09-30 深化）
 *
 * 验证 `callToolDirectWithTier` 对 `l1-*` 工具名的分派：L1 计划步骤挂的能力工具名
 * 会被路由到 pipelineExecutor 的 NodeHandler 注册表并真实执行（不是重抄一份实现）。
 *
 * mock 面参照 macroExecutor.tools.spec.ts 的既有基建；额外桩掉 memory / knowledgeBase /
 * promptTranslator —— 它们只为构造 NodeHandlerContext 而需要，不是被测对象。
 */

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
  extractEntities: vi.fn().mockReturnValue([]),
  extractEntitiesAll: vi.fn().mockReturnValue([]),
  shouldTrigger: vi.fn().mockReturnValue(false),
  runFactGuardV2: vi.fn().mockReturnValue({ ok: true, conflicts: [], hallucinatedEntities: [], severity: 'ok', correctedOutput: null, summary: 'ok' })
}))
vi.mock('@/services/ruleEngine', () => ({
  runRuleEngine: vi.fn().mockReturnValue({ matched: false, output: '' }),
  buildRuleContext: vi.fn().mockReturnValue({})
}))
vi.mock('@/services/dagCheckpoint', () => ({
  saveCheckpoint: vi.fn(),
  removeCheckpoint: vi.fn(),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  createCheckpointId: vi.fn().mockReturnValue('cp-mock')
}))
vi.mock('@/services/secureStore', () => ({
  storeGet: vi.fn().mockResolvedValue(null),
  storeSet: vi.fn().mockResolvedValue(undefined)
}))

// 只为构造 NodeHandlerContext 而需要——非被测对象
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
  compileToChain: vi.fn().mockResolvedValue({ steps: [] })
}))

import { callToolDirectWithTier } from '@/services/macroExecutor'
import { getHandler } from '@/services/pipelineExecutor'
import { globalBus } from '@/kernel/bus'

beforeEach(() => {
  vi.clearAllMocks()
  // 生产环境由 src/domains/api/handlers.ts:58 注册 'llm:get-gateway'；测试里自行注册一个可用的。
  globalBus.registerHandler('llm:get-gateway', () => ({
    chatCompletion: vi.fn().mockResolvedValue('mock-llm'),
    listModels: () => [],
    switchProvider: vi.fn(),
    switchModel: vi.fn(),
    getActiveProvider: () => null
  }))
  // callToolDirectWithTier 开头即读 window.electronAPI.platform；测试环境须提供
  ;(globalThis as any).window = {
    electronAPI: {
      platform: 'win32',
      storeRead: vi.fn().mockResolvedValue(null),
      storeWrite: vi.fn().mockResolvedValue(undefined),
      resolvePath: vi.fn().mockResolvedValue('C:\\Users\\Test')
    }
  }
})

describe('callToolDirectWithTier · L1 能力分派', () => {
  it('l1-* 工具名路由到 pipelineExecutor 的注册表（四节点 handler 均在册）', () => {
    for (const id of ['l1-task-translator', 'l1-result-beautifier', 'l1-workspace-memory', 'l1-pipeline-builder']) {
      expect(getHandler(id)).toBeTruthy()
    }
  })

  it('l1-result-beautifier：真实执行 beautify，返回格式化结果（非 JSON 包裹）', async () => {
    const out = await callToolDirectWithTier('l1-result-beautifier', { content: '# 标题\n\n正文段落', format: 'html' })
    expect(typeof out).toBe('string')
    // beautify(html) 会产出真正的 HTML 结构，而不是把 { output: ... } 原样 JSON 化
    expect(out).not.toContain('"output"')
    expect(out.length).toBeGreaterThan(0)
  })

  it('l1-workspace-memory：单 key 输出取该值本身（不 JSON 包裹）', async () => {
    const out = await callToolDirectWithTier('l1-workspace-memory', {})
    expect(typeof out).toBe('string')
    expect(out).not.toContain('"context"')
  })

  it('未注册的 l1-* 工具名 → 抛错（不静默返回空）', async () => {
    await expect(callToolDirectWithTier('l1-not-a-real-node', {}))
      .rejects.toThrow('L1 handler 未注册')
  })
})
