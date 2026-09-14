import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'
import type { FunnelOutcome } from '@/kernel/funnel'

// ===== 可控 mock：kernelRegistry.route 与 funnel 主路径 flag =====
const { routeMock } = vi.hoisted(() => ({ routeMock: vi.fn() }))
vi.mock('@/host/kernelRuntime', () => ({
  kernelRegistry: { route: routeMock }
}))

let funnelMainFlag: string | null = null

// ===== store mocks（沿用 dialogState.spec 基建） =====
vi.mock('@/stores/apiStore', () => ({
  useApiStore: () => ({
    chatCompletion: vi.fn().mockResolvedValue({
      content: 'mock response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    }),
    isReady: true,
    isCircuitOpen: false,
    config: { value: { isReachable: true, activeModel: 'test-model' } }
  })
}))

vi.mock('@/stores/nodeStore', () => ({
  useNodeStore: () => ({
    getL2Manifest: vi.fn().mockReturnValue(null),
    setL1Status: vi.fn(),
    l2Nodes: []
  })
}))

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: () => ({ activeSession: null })
}))

vi.mock('@/stores/memoryStore', () => ({
  useMemoryStore: () => ({
    allEmbeddings: [],
    search: vi.fn().mockResolvedValue([])
  })
}))

vi.mock('@/stores/mcpStore', () => ({
  useMcpStore: () => ({
    callTool: vi.fn().mockResolvedValue({ success: true, result: 'mock' }),
    activeConnections: []
  })
}))

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: () => ({
    emitEvent: vi.fn(),
    recordProbe: vi.fn(),
    recordStepCost: vi.fn(),
    enabled: false
  })
}))

vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: () => ({
    recordFeedback: vi.fn(),
    getWeightModifier: vi.fn().mockReturnValue(0),
    addSideEffectManifest: vi.fn()
  })
}))

// ===== service mocks =====
vi.mock('@/services/knowledgeBase', () => ({
  searchKnowledge: vi.fn().mockResolvedValue([])
}))

vi.mock('@/services/promptTranslator', () => ({
  planTask: vi.fn().mockResolvedValue({ intent: 'test', needs: [], steps: [] }),
  reflectOnResult: vi.fn().mockResolvedValue('ok'),
  saveTaskCase: vi.fn(),
  replan: vi.fn().mockResolvedValue({ intent: 'test', needs: [], steps: [] }),
  disambiguateChoice: vi.fn().mockResolvedValue({ chosenIndex: 0 }),
  translateIntent: vi.fn().mockResolvedValue(null)
}))

vi.mock('@/services/macroExecutor', () => ({
  executeMacro: vi.fn().mockResolvedValue({ results: {}, lastResult: 'mock', savedTokens: 0, lineage: [] }),
  resolveDirectPrompt: vi.fn().mockReturnValue(null),
  formatLineage: vi.fn().mockReturnValue(''),
  computeLineageSavings: vi.fn().mockReturnValue({ tokensSaved: 0, llmSteps: 0, zeroTokenSteps: 0 }),
  callToolDirectWithTier: vi.fn().mockResolvedValue('原生工具执行结果')
}))

vi.mock('@/services/resultBeautifier', () => ({
  beautify: vi.fn().mockReturnValue('beautified')
}))

vi.mock('@/services/scheduleOptimizer', () => ({
  contentHash: vi.fn().mockReturnValue('hash'),
  truncateForLog: vi.fn().mockReturnValue('truncated')
}))

vi.mock('@/services/proactiveScheduler', () => ({
  logManifestUsage: vi.fn()
}))

vi.mock('@/services/toolRetrieval', () => ({
  buildToolIndex: vi.fn().mockResolvedValue([]),
  retrieveTopTools: vi.fn().mockResolvedValue([]),
  makeSummaryToolList: vi.fn().mockReturnValue(''),
  universalMatch: vi.fn().mockResolvedValue(null),
  getTop3Candidates: vi.fn().mockReturnValue([]),
  getTop3CandidatesUniversal: vi.fn().mockReturnValue([]),
  llmFallback: vi.fn().mockResolvedValue(null),
  extractCoreKeywords: vi.fn().mockReturnValue([])
}))

vi.mock('@/services/convMemory', () => ({
  indexConversationRound: vi.fn(),
  searchConversationContext: vi.fn().mockResolvedValue(''),
  getLatestSummary: vi.fn().mockReturnValue(null),
  getAllSummaries: vi.fn().mockReturnValue([]),
  savePeriodSummary: vi.fn(),
  shouldCompress: vi.fn().mockReturnValue(false),
  detectChallenge: vi.fn().mockReturnValue(false)
}))

vi.mock('@/services/nerExtractor', () => ({
  extractEntities: vi.fn().mockReturnValue([])
}))

vi.mock('@/services/strategySelector', () => ({
  selectRewriteStrategy: vi.fn().mockReturnValue('none'),
  selectDisambigStrategy: vi.fn().mockReturnValue('show_candidates'),
  extractStrategyContext: vi.fn().mockReturnValue({})
}))

vi.mock('@/services/l0SkillRouter', () => ({
  tryL0Skill: vi.fn().mockResolvedValue(null),
  classifyDomain: vi.fn().mockReturnValue(['general']),
  tryL05QuickMatch: vi.fn().mockReturnValue(null),
  checkL1Capability: vi.fn().mockReturnValue({ canHandle: false, confidence: 0 }),
  buildExplorePlan: vi.fn().mockResolvedValue({ intent: '探索', steps: [{ step: 1, description: '探索第一步', tool: 'llm_generate', params: {}, expectedOutput: '结果' }] })
}))

vi.stubGlobal('window', {
  electronAPI: {
    shellExec: vi.fn().mockResolvedValue({ success: true, code: 0, stdout: 'mock', stderr: '' }),
    fileRead: vi.fn().mockResolvedValue({ success: true, content: 'mock' }),
    httpFetch: vi.fn().mockResolvedValue({ success: true, status: 200, body: 'mock' }),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    storeRead: vi.fn().mockResolvedValue(null),
    safeStorageEncrypt: vi.fn().mockResolvedValue('enc'),
    safeStorageDecrypt: vi.fn().mockResolvedValue('dec'),
    vectorWriteBin: vi.fn().mockResolvedValue(true),
    vectorReadBin: vi.fn().mockResolvedValue(null),
    vaultRead: vi.fn().mockImplementation((ns: string, key: string) =>
      Promise.resolve(ns === 'config' && key === 'holo-funnel-main' ? funnelMainFlag : null)),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
})

vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { setTimeout(() => cb(0), 0); return 0 })

import { useDialogStore } from '@/stores/dialogStore'
import { tryL0Skill } from '@/services/l0SkillRouter'

function makePlan(overrides?: Partial<{ intent: string; tool: string }>): {
  intent: string
  needs: string[]
  steps: Array<{ step: number; description: string; tool: string; depends_on: number[]; params: Record<string, string>; expectedOutput: string }>
} {
  return {
    intent: overrides?.intent ?? '测试意图',
    needs: ['general'],
    steps: [{
      step: 1,
      description: '执行测试步骤',
      tool: overrides?.tool ?? 'llm_generate',
      depends_on: [],
      params: { prompt: 'test' },
      expectedOutput: '结果'
    }]
  }
}

function setupBus(connections: unknown[] = []) {
  globalBus.registerHandler('api:is-ready', () => true)
  globalBus.registerHandler('api:get-config', () => ({ activeModel: 'test-model', activeProviderId: 'p1' }))
  globalBus.registerHandler('api:chat-completion', async () => ({ content: '工具直调结果', toolCalls: [] }))
  globalBus.registerHandler('node:get-selected-node', () => null)
  globalBus.registerHandler('node:get-all-l2-manifests', () => [])
  globalBus.registerHandler('node:get-visible-l2-ids', () => [])
  globalBus.registerHandler('node:get-selected-role', () => null)
  globalBus.registerHandler('node:get-nodes', () => [])
  globalBus.registerHandler('mcp:get-connections', () => connections)
  globalBus.registerHandler('mcp:get-tools-as-nodes', () => [])
  globalBus.registerHandler('debug:is-enabled', () => false)
}

function noticeTexts(store: ReturnType<typeof useDialogStore>): string {
  return store.messages.map(m => m.content).join('\n')
}

describe('灰度第二步：funnel 主路径适配层（config:holo-funnel-main）', () => {
  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    routeMock.mockReset()
    routeMock.mockResolvedValue({ kind: 'error', error: 'unset' } as FunnelOutcome)
    vi.mocked(tryL0Skill).mockReset()
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    const pinia = createPinia()
    setActivePinia(pinia)
    store = useDialogStore()
  })

  afterEach(() => {
    globalBus.clear()
  })

  it("flag='0'（显式回滚）→ kernelRegistry.route 不被调用，走旧内联路径", async () => {
    funnelMainFlag = '0'
    setupBus()
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '旧路径任务',
      steps: [{ step: 1, description: '旧路径步骤', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    })

    await store.sendMessage('测试消息')

    expect(routeMock).not.toHaveBeenCalled()
    expect(store.awaitingConfirmation).toBe(true)
    expect(noticeTexts(store)).toContain('⚡ L0 Skill直通：旧路径任务')
  })

  it('flag 未配置（null，R15 默认）→ 默认走 funnel 主路径', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '默认主路径任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome)

    await store.sendMessage('测试消息')

    expect(routeMock).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tryL0Skill)).not.toHaveBeenCalled()
    expect(store.awaitingConfirmation).toBe(true)
    expect(noticeTexts(store)).toContain('⚡ L0 Skill直通：默认主路径任务')
  })

  it('plan(L0, 非自动) → 确认暂停点 + L0 文案；旧层服务未被调用', async () => {
    funnelMainFlag = null
    setupBus()
    const routed: Array<Record<string, unknown>> = []
    globalBus.on('funnel:routed', (p: unknown) => routed.push(p as Record<string, unknown>))
    const plan = makePlan({ intent: 'funnel任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome)

    await store.sendMessage('测试消息')

    expect(routeMock).toHaveBeenCalledTimes(1)
    const [input, ctx] = routeMock.mock.calls[0]
    expect(input).toBe('测试消息')
    expect(ctx.mcpTools.some((t: { name: string }) => t.name === 'shell_exec')).toBe(true)
    expect(ctx.isEmptyInput).toBe(false)
    expect(vi.mocked(tryL0Skill)).not.toHaveBeenCalled()
    expect(store.awaitingConfirmation).toBe(true)
    expect(store.pendingPlan?.intent).toBe('funnel任务')
    expect(store.isProcessing).toBe(false)
    expect(noticeTexts(store)).toContain('⚡ L0 Skill直通：funnel任务')
    expect(noticeTexts(store)).toContain('📋 **L0 Skill直通 (简单任务)**')
    // R16：funnel:routed 观测事件
    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({ handled: true, kind: 'plan', source: 'L0', intent: 'funnel任务', autoExecutable: false })
    expect(typeof routed[0]['ts']).toBe('number')
  })

  it('plan(L4, 自动执行) → confirmPlan 直通执行，无暂停点', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '探索量子计算' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('探索一下量子计算')

    expect(noticeTexts(store)).toContain('🤔 RaaP未命中，进入探索模式：探索量子计算')
    expect(noticeTexts(store)).toContain('⚡ L0 Skill自动执行（无shell操作）')
    expect(store.awaitingConfirmation).toBe(false)
    expect(store.isProcessing).toBe(false)
    expect(store.messages.some(m => m.role === 'assistant' && m.content.length > 0)).toBe(true)
  })

  it('plan(L2, 确认) → 计划自检思维链 + 任务分析(DAG) 文案', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '检索类任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L2' } as FunnelOutcome)

    await store.sendMessage('帮我检索')

    expect(store.awaitingConfirmation).toBe(true)
    expect(noticeTexts(store)).toContain('📋 **任务分析 (DAG)**')
    expect(noticeTexts(store)).toContain('请确认是否按此计划执行？')
    const thought = store.messages.find(m => (m.thoughtChain ?? []).some(t => t.content.includes('步计划')))
    expect(thought).toBeTruthy()
  })

  it('candidates → 候选选择暂停点', async () => {
    funnelMainFlag = null
    setupBus()
    routeMock.mockResolvedValue({
      kind: 'candidates',
      candidates: [
        { id: 'srv___t1', name: '工具一', score: 0.91 },
        { id: 'srv___t2', name: '工具二', score: 0.85 }
      ],
      source: 'L2'
    } as FunnelOutcome)

    await store.sendMessage('查数据')

    expect(store.awaitingCandidatePick).toBe(true)
    expect(store.pendingCandidateList).toHaveLength(2)
    expect(store.pendingCandidateList[0].manifestId).toBe('srv___t1')
    expect(store.isProcessing).toBe(false)
    expect(noticeTexts(store)).toContain('🟡 匹配到多个候选，请选择：')
    expect(noticeTexts(store)).toContain('1. 工具一（91%）')
  })

  it('intent-confirm → 意图确认暂停点', async () => {
    funnelMainFlag = null
    setupBus()
    routeMock.mockResolvedValue({
      kind: 'intent-confirm',
      intent: '生成周报',
      manifestId: 'm-weekly',
      params: { period: '2024-W37' },
      originalInput: '帮我写周报',
      source: 'L2'
    } as FunnelOutcome)

    await store.sendMessage('帮我写周报')

    expect(store.awaitingIntentConfirm).toBe(true)
    expect(store.translatedIntent).not.toBeNull()
    expect(store.translatedIntent?.params['period']).toBe('2024-W37')
    expect(store.isProcessing).toBe(false)
    expect(noticeTexts(store)).toContain('🟡 Agent翻译：你的意图是"生成周报"，参数：period=2024-W37')
  })

  it('slot-fill → 槽位填充暂停点', async () => {
    funnelMainFlag = null
    setupBus()
    routeMock.mockResolvedValue({
      kind: 'slot-fill',
      manifestId: 'm-contract',
      manifestName: '合同审查',
      slots: [
        { name: 'file', description: '合同文件', required: true, value: '' },
        { name: 'note', description: '备注', required: false, value: '' }
      ],
      source: 'L2'
    } as FunnelOutcome)

    await store.sendMessage('审查合同')

    expect(store.awaitingSlotFill).toBe(true)
    expect(store.slotClarification?.manifestId).toBe('m-contract')
    expect(store.isProcessing).toBe(false)
    expect(noticeTexts(store)).toContain('🔴 缺少必填参数：file')
  })

  it('mcp-direct(L2) → MCP 工具直调 + 助手消息，无暂停点', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)

    await store.sendMessage('算一下')

    expect(noticeTexts(store)).toContain('🎯 自动匹配工具：**calc**')
    expect(store.messages.some(m => m.content.includes('工具直调结果'))).toBe(true)
    expect(store.awaitingConfirmation).toBe(false)
    expect(store.isProcessing).toBe(false)
  })

  it('error outcome → 回退旧六层内联路径', async () => {
    funnelMainFlag = null
    setupBus()
    routeMock.mockResolvedValue({ kind: 'error', error: 'all-layers-failed' } as FunnelOutcome)
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '回退任务',
      steps: [{ step: 1, description: '回退步骤', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    })

    await store.sendMessage('测试回退')

    expect(routeMock).toHaveBeenCalledTimes(1)
    expect(store.awaitingConfirmation).toBe(true)
    expect(noticeTexts(store)).toContain('⚡ L0 Skill直通：回退任务')
  })

  it('route 抛异常 → 适配层兜底回退旧路径', async () => {
    funnelMainFlag = null
    setupBus()
    const routed: Array<Record<string, unknown>> = []
    globalBus.on('funnel:routed', (p: unknown) => routed.push(p as Record<string, unknown>))
    routeMock.mockRejectedValue(new Error('kernel-boom'))
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '异常回退任务',
      steps: [{ step: 1, description: '回退步骤', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    })

    await store.sendMessage('测试异常回退')

    expect(store.awaitingConfirmation).toBe(true)
    expect(noticeTexts(store)).toContain('⚡ L0 Skill直通：异常回退任务')
    // R16：异常也发观测事件（handled=false, kind=exception）
    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({ handled: false, kind: 'exception' })
  })
})
