import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'
import type { FunnelOutcome } from '@/kernel/funnel'
import { resetWriteGrantCache } from '@/services/writeGate'

// ===== 可控 mock：kernelRegistry.route / getActive 与 funnel 主路径 flag =====
const { routeMock, getActiveMock } = vi.hoisted(() => ({ routeMock: vi.fn(), getActiveMock: vi.fn() }))
vi.mock('@/host/kernelRuntime', () => ({
  kernelRegistry: { route: routeMock, getActive: getActiveMock }
}))

let funnelMainFlag: string | null = null
let strictVetoFlag: string | null = null
let competitiveModeFlag: string | null = null

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
    // O10：写类工具授权边界——写盘面（用于断言"拒绝时不写盘"）
    fileWrite: vi.fn().mockResolvedValue({ success: true, path: 'C:\\mock\\out.txt' }),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    storeRead: vi.fn().mockResolvedValue(null),
    safeStorageEncrypt: vi.fn().mockResolvedValue('enc'),
    safeStorageDecrypt: vi.fn().mockResolvedValue('dec'),
    vectorWriteBin: vi.fn().mockResolvedValue(true),
    vectorReadBin: vi.fn().mockResolvedValue(null),
    vaultRead: vi.fn().mockImplementation((ns: string, key: string) =>
      Promise.resolve(ns === 'config' && key === 'holo-funnel-main' ? funnelMainFlag
        : ns === 'config' && key === 'holo-strict-veto' ? strictVetoFlag
        : ns === 'config' && key === 'holo-competitive-mode' ? competitiveModeFlag
        : null)),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
})

vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { setTimeout(() => cb(0), 0); return 0 })

import { useDialogStore } from '@/stores/dialogStore'
import { tryL0Skill } from '@/services/l0SkillRouter'
import { callToolDirectWithTier } from '@/services/macroExecutor'
import { qualityEmaStore } from '@/kernel/competition'
import type { CompetitionRecord } from '@/kernel/funnel'

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

/** api:chat-completion 收到的 payload 留档——用于断言实际交给模型的工具集 */
let chatPayloads: Array<Record<string, unknown>> = []

/** O10 用：让 chat-completion 返回可配置的 toolCalls（默认空） */
let chatToolCalls: Array<{ id: string; name: string; arguments: string }> = []
/** 工具回路用：按轮次消费的 toolCalls 队列（优先于上面的固定值；空则回落固定值） */
let chatToolCallsQueue: Array<Array<{ id: string; name: string; arguments: string }>> = []

function setupBus(connections: unknown[] = []) {
  chatPayloads = []
  chatToolCalls = []
  chatToolCallsQueue = []
  // O10：清授权缓存，避免跨用例污染（授权是模块级内存缓存）
  resetWriteGrantCache()
  globalBus.registerHandler('api:is-ready', () => true)
  globalBus.registerHandler('api:get-config', () => ({ activeModel: 'test-model', activeProviderId: 'p1' }))
  globalBus.registerHandler('api:chat-completion', async (payload) => {
    chatPayloads.push(payload as Record<string, unknown>)
    const queued = chatToolCallsQueue.length > 0 ? chatToolCallsQueue.shift()! : chatToolCalls
    return { content: '工具直调结果', toolCalls: queued }
  })
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
    funnelMainFlag = null
    strictVetoFlag = null
    competitiveModeFlag = null
    routeMock.mockReset()
    routeMock.mockResolvedValue({ kind: 'error', error: 'unset' } as FunnelOutcome)
    getActiveMock.mockReset()
    getActiveMock.mockReturnValue(undefined)
    vi.mocked(tryL0Skill).mockReset()
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    const pinia = createPinia()
    setActivePinia(pinia)
    store = useDialogStore()
  })

  afterEach(() => {
    globalBus.clear()
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

  it('F-4：自动执行路径诚实标注「未经用户点击确认」，不伪装成用户确认', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '探索量子计算' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('探索一下量子计算')

    const notices = noticeTexts(store)
    expect(notices).toMatch(/⚡ 自动执行.*未经用户点击确认/)
    expect(notices).not.toContain('✅ 用户确认')
  })

  it('F-4：用户点击确认路径保留「✅ 用户确认」文案', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: 'funnel任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome)

    await store.sendMessage('测试消息')
    expect(store.awaitingConfirmation).toBe(true)

    await store.confirmPlan()
    expect(noticeTexts(store)).toContain('✅ 用户确认')
    expect(noticeTexts(store)).not.toMatch(/⚡ 自动执行.*未经用户点击确认/)
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

  it('mcp-direct 直调：工具集必须补齐常驻原生工具（模型不能只看到 1 个工具）', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)

    await store.sendMessage('算一下')

    expect(chatPayloads).toHaveLength(1)
    const names = ((chatPayloads[0].tools as Array<{ name: string }>) || []).map(t => t.name)
    // 匹配到的 MCP 工具仍在
    expect(names).toContain('srv___calc')
    // 常驻原生工具不得被单工具直调剔除——否则「先列目录、再改名」这类多步任务，
    // 模型只拿到其中一个工具，就会回复「我只有移动/重命名文件的工具」（实测 R19 Q15）
    expect(names).toContain('read_file')
    expect(names).toContain('list_directory')
    expect(names).toContain('file_write')
    expect(names).toContain('file_move')
  })

  // O10（2026-09-22 用户裁决 B）：写类工具的授权边界。
  // 本用例走的是 mcp-direct → executeMcpToolCalls → dialogStore.executeToolCall，
  // **不经** callToolDirectWithTier —— 即首轮端到端验证暴露出的漏网路径。
  it('O10：工具执行路径的 file_write 须经用户裁决——拒绝时不写盘', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)
    chatToolCalls = [{
      id: 'c1', name: 'file_write',
      arguments: JSON.stringify({ path: 'C:\\Users\\Test\\Desktop\\x.txt', content: 'hi' })
    }]
    globalBus.registerHandler('dialog:confirm-write', () => 'deny')

    await store.sendMessage('写个文件')

    expect((globalThis as any).window.electronAPI.fileWrite).not.toHaveBeenCalled()
    // 拒绝结果会被回灌给模型（模型据此得知"未写入"，而不是以为自己写成功了）——
    // 2026-09-24 mcp-direct 加回路后，最终呈现的是模型的收口回复而非拒绝文本本身，
    // 故断言回灌内容而非消息文本。
    const feedback = chatPayloads.map(p => JSON.stringify(p.messages)).join('\n')
    expect(feedback).toContain('用户拒绝执行')
  })

  it('O10：用户本次允许 → 写盘执行', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)
    chatToolCalls = [{
      id: 'c1', name: 'file_write',
      arguments: JSON.stringify({ path: 'C:\\Users\\Test\\Desktop\\x.txt', content: 'hi' })
    }]
    globalBus.registerHandler('dialog:confirm-write', () => 'once')

    await store.sendMessage('写个文件')

    expect((globalThis as any).window.electronAPI.fileWrite).toHaveBeenCalled()
  })

  // 2026-09-24：原 mcp-direct 分支只执行一轮 toolCalls 就呈现——实测（HANDOFF 追加五十）
  // 路由落到该分支时模型调一次 list_directory 就再无续跑，多步任务（先列目录再改名）
  // 必然停在第一步且不报错。本用例断言「回灌 + 续跑」确实发生。
  it('mcp-direct：多步任务不再停在第一步（有限轮次回路）', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)
    // 第 1 次调用发起工具调用；回灌后的第 2 次不再调工具（模型收口）
    chatToolCallsQueue = [
      [{ id: 'c1', name: 'calc', arguments: '{}' }],
      []
    ]

    await store.sendMessage('算一下')

    expect(chatPayloads.length).toBeGreaterThanOrEqual(2)
    expect(noticeTexts(store)).toContain('工具直调结果')
  })

  // 2026-09-26：工具执行期中止此前要等下一轮 LLM 请求才生效（实测延迟约 6.3s），且每多走一轮
  // 就多白烧一次完整 LLM 请求（B-07 race 只让调用方不再等待，ipcCall 在 race 之前就已发出）。
  it('mcp-direct：工具执行期中止 → 立即收口，不再续跑 LLM、不发收口请求', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)
    const ctls: AbortController[] = []
    globalBus.on('debug:register-abort', (c: unknown) => ctls.push(c as AbortController))
    // 工具执行期间模拟用户点「⏹ 终止」——真实 terminateExecution 会 abort 注册表内全部控制器
    globalBus.registerHandler('mcp:call-tool', async () => {
      ctls.forEach(c => c.abort())
      return '部分结果'
    })
    chatToolCallsQueue = [[{ id: 'c1', name: 'srv___calc', arguments: '{}' }]]

    await store.sendMessage('算一下')

    // 只发出首轮那一条 LLM 请求——中止后不得再续跑（旧行为 ≥2 条）
    expect(chatPayloads).toHaveLength(1)
    expect(noticeTexts(store)).toContain('⏹ 已终止（工具执行阶段）')
    expect(noticeTexts(store)).toContain('部分结果')
  })

  it('mcp-direct：中止后同一轮的剩余工具不再执行（signal 逐工具复查）', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)
    const ctls: AbortController[] = []
    globalBus.on('debug:register-abort', (c: unknown) => ctls.push(c as AbortController))
    let toolCallsSeen = 0
    globalBus.registerHandler('mcp:call-tool', async () => {
      toolCallsSeen++
      ctls.forEach(c => c.abort())
      return '第一个工具结果'
    })
    chatToolCallsQueue = [[
      { id: 'c1', name: 'srv___calc', arguments: '{}' },
      { id: 'c2', name: 'srv___calc', arguments: '{}' },
      { id: 'c3', name: 'srv___calc', arguments: '{}' }
    ]]

    await store.sendMessage('算一下')

    expect(toolCallsSeen).toBe(1)
    expect(chatPayloads).toHaveLength(1)
  })

  // 2026-09-26：原生工具执行路径（confirmPlan 的 isAllNative 分支）此前不注册任何控制器 ⇒
  // 整段执行不可中止（真实渲染实测：adds 里只有路由那一个）。步骤边界是这里唯一的可中断点。
  it('plan(全原生工具)：执行期中止 → 后续步骤不再执行（步骤边界可中止）', async () => {
    funnelMainFlag = null
    setupBus()
    const ctls: AbortController[] = []
    globalBus.on('debug:register-abort', (c: unknown) => ctls.push(c as AbortController))
    const seenTools: string[] = []
    vi.mocked(callToolDirectWithTier).mockImplementation(async (tool: string) => {
      seenTools.push(tool)
      ctls.forEach(c => c.abort()) // 第 1 步执行期间模拟用户点「⏹ 终止」
      return '第一步结果'
    })
    const nativePlan = {
      intent: '列两个目录',
      needs: ['general'],
      steps: [
        { step: 1, description: '列目录 A', tool: 'list_directory', depends_on: [], params: { path: 'C:\\mockA' }, expectedOutput: '清单A' },
        { step: 2, description: '列目录 B', tool: 'list_directory', depends_on: [], params: { path: 'C:\\mockB' }, expectedOutput: '清单B' }
      ]
    }
    routeMock.mockResolvedValue({ kind: 'plan', plan: nativePlan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('列两个目录')

    expect(seenTools).toEqual(['list_directory']) // 第 2 步未执行
    expect(noticeTexts(store)).toContain('⏹ 已终止（原生工具执行阶段）')
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

  // 2026-09-26：路由/规划阶段此前不注册可中止控制器 ⇒ 工作台「⏹ 终止」在整个路由窗口置灰，
  // 且该阶段的 LLM 调用（ctx.chatCompletion）不带 signal。以下三条钉住新增的「路由期可中止」行为。
  it('路由期 ctx.chatCompletion 的 LLM 调用必须带 signal（否则该阶段无法被终止打断）', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '带 signal 的任务' })
    routeMock.mockImplementation(async (_input: string, ctx: Record<string, unknown>) => {
      await (ctx['chatCompletion'] as (m: unknown[]) => Promise<unknown>)([{ role: 'user', content: 'x' }])
      return { kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome
    })

    await store.sendMessage('测试消息')

    expect(chatPayloads).toHaveLength(1)
    expect(chatPayloads[0]['signal']).toBeInstanceOf(AbortSignal)
  })

  it('路由期中止（route 内 abort 后正常返回）→ 按已处理短路，不落 consumeFunnelOutcome、不回退旧路径', async () => {
    funnelMainFlag = null
    setupBus()
    const ctls: AbortController[] = []
    globalBus.on('debug:register-abort', (c: unknown) => ctls.push(c as AbortController))
    const routed: Array<Record<string, unknown>> = []
    globalBus.on('funnel:routed', (p: unknown) => routed.push(p as Record<string, unknown>))
    routeMock.mockImplementation(async () => {
      ctls[0].abort() // 模拟用户点「⏹ 终止」
      return { kind: 'error', error: 'ignored' } as FunnelOutcome
    })
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '不该走到这里',
      steps: [{ step: 1, description: 'x', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    })

    await store.sendMessage('测试路由中止')

    expect(store.isProcessing).toBe(false)
    expect(store.awaitingConfirmation).toBe(false)
    expect(noticeTexts(store)).toContain('⏹ 已终止（路由/规划阶段）')
    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({ handled: true, kind: 'aborted' })
    // 关键：不得退化成「换条路径把它再跑一遍」
    expect(vi.mocked(tryL0Skill)).not.toHaveBeenCalled()
  })

  it('路由期中止（route 抛错）→ 判为「已终止」而非异常回退旧路径', async () => {
    funnelMainFlag = null
    setupBus()
    const ctls: AbortController[] = []
    globalBus.on('debug:register-abort', (c: unknown) => ctls.push(c as AbortController))
    const routed: Array<Record<string, unknown>> = []
    globalBus.on('funnel:routed', (p: unknown) => routed.push(p as Record<string, unknown>))
    routeMock.mockImplementation(async () => {
      ctls[0].abort()
      throw new Error('Aborted')
    })
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '不该走到这里',
      steps: [{ step: 1, description: 'x', tool: 'llm_generate', params: {}, expectedOutput: 'x' }]
    })

    await store.sendMessage('测试路由中止抛错')

    expect(store.isProcessing).toBe(false)
    expect(noticeTexts(store)).toContain('⏹ 已终止（路由/规划阶段）')
    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({ handled: true, kind: 'aborted' })
    expect(vi.mocked(tryL0Skill)).not.toHaveBeenCalled()
  })
})

describe('A2-9：pre-output 否决门接入 funnel 主路径（presentExecutionOutput）', () => {
  let store: ReturnType<typeof useDialogStore>

  const blockingKernel = {
    id: 'kernel-default',
    runPreOutputGate: () => ({
      blocked: true,
      entries: [{ pluginId: 'test-pack', severity: 'block' as const, reason: '输出包含风险内容' }],
      warnings: [],
      humanJudgmentPrompts: []
    })
  }

  const warnKernel = {
    id: 'kernel-default',
    runPreOutputGate: () => ({
      blocked: false,
      entries: [{ pluginId: 'test-pack', severity: 'warn' as const, reason: '仅提示' }],
      warnings: [],
      humanJudgmentPrompts: []
    })
  }

  const promptKernel = {
    id: 'kernel-default',
    runPreOutputGate: () => ({
      blocked: false,
      entries: [{ pluginId: 'test-pack', severity: 'warn' as const, reason: '高风险' }],
      warnings: [],
      humanJudgmentPrompts: ['请人工复核输出']
    })
  }

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    funnelMainFlag = null
    strictVetoFlag = null
    competitiveModeFlag = null
    routeMock.mockReset()
    routeMock.mockResolvedValue({ kind: 'error', error: 'unset' } as FunnelOutcome)
    getActiveMock.mockReset()
    getActiveMock.mockReturnValue(undefined)
    vi.mocked(tryL0Skill).mockReset()
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    const pinia = createPinia()
    setActivePinia(pinia)
    store = useDialogStore()
  })

  afterEach(() => {
    globalBus.clear()
  })

  it('自动执行计划被 block → 不产出助手消息，复用 ⛔ 否决门拦截 UI（M6.5：不入会话记忆）', async () => {
    funnelMainFlag = null
    setupBus()
    getActiveMock.mockReturnValue(blockingKernel)
    const plan = makePlan({ intent: '高危任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('执行高危任务')

    expect(noticeTexts(store)).toContain('⛔ 否决门拦截：输出包含风险内容')
    expect(store.messages.some(m => m.role === 'assistant' && m.type === 'text')).toBe(false)
    expect(store.isProcessing).toBe(false)
  })

  it('warn 级门 → 不拦截，输出正常呈现', async () => {
    funnelMainFlag = null
    setupBus()
    getActiveMock.mockReturnValue(warnKernel)
    const plan = makePlan({ intent: '普通任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('执行普通任务')

    expect(noticeTexts(store)).not.toContain('⛔ 否决门拦截')
    expect(store.messages.some(m => m.role === 'assistant' && m.content.length > 0)).toBe(true)
  })

  it('humanJudgmentPrompts 非空 → 保守拦截（M6.4）', async () => {
    funnelMainFlag = null
    setupBus()
    getActiveMock.mockReturnValue(promptKernel)
    const plan = makePlan({ intent: '需复核任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('执行需复核任务')

    expect(noticeTexts(store)).toContain('⛔ 否决门拦截：请人工复核输出')
    expect(store.messages.some(m => m.role === 'assistant' && m.type === 'text')).toBe(false)
  })

  it('mcp-direct 产物同样过门：block → 工具输出不呈现', async () => {
    funnelMainFlag = null
    setupBus([{
      id: 'srv', name: '测试服务', isConnected: true,
      tools: [{ name: 'calc', description: '计算工具', inputSchema: { type: 'object' } }]
    }])
    getActiveMock.mockReturnValue(blockingKernel)
    routeMock.mockResolvedValue({ kind: 'mcp-direct', toolName: 'srv___calc', source: 'L2' } as FunnelOutcome)

    await store.sendMessage('算一下')

    expect(noticeTexts(store)).toContain('⛔ 否决门拦截：输出包含风险内容')
    expect(store.messages.some(m => m.content.includes('工具直调结果'))).toBe(false)
    expect(store.isProcessing).toBe(false)
  })

  it('内核无 runPreOutputGate（前向兼容）→ 直接放行', async () => {
    funnelMainFlag = null
    setupBus()
    getActiveMock.mockReturnValue({ id: 'legacy-kernel' })
    const plan = makePlan({ intent: '旧内核任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('执行旧内核任务')

    expect(noticeTexts(store)).not.toContain('⛔ 否决门拦截')
    expect(store.messages.some(m => m.role === 'assistant' && m.content.length > 0)).toBe(true)
  })

  it('getActive 抛错（桥/内核异常）→ fail-open 放行', async () => {
    funnelMainFlag = null
    setupBus()
    getActiveMock.mockImplementation(() => { throw new Error('registry exploded') })
    const plan = makePlan({ intent: '容错任务' })
    routeMock.mockResolvedValue({ kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4' } as FunnelOutcome)

    await store.sendMessage('执行容错任务')

    expect(store.messages.some(m => m.role === 'assistant' && m.content.length > 0)).toBe(true)
  })

})

describe('M16：竞争模型接入 funnel 主路径（config:holo-competitive-mode）', () => {
  let store: ReturnType<typeof useDialogStore>

  beforeEach(() => {
    vault.clearCache()
    globalBus.clear()
    funnelMainFlag = null
    strictVetoFlag = null
    competitiveModeFlag = null
    routeMock.mockReset()
    routeMock.mockResolvedValue({ kind: 'error', error: 'unset' } as FunnelOutcome)
    getActiveMock.mockReset()
    getActiveMock.mockReturnValue(undefined)
    vi.mocked(tryL0Skill).mockReset()
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    qualityEmaStore.clearForTest()
    const pinia = createPinia()
    setActivePinia(pinia)
    store = useDialogStore()
  })

  afterEach(() => {
    globalBus.clear()
  })

  function makeCompetition(): CompetitionRecord {
    return { winnerPackId: 'pack-a', loserPackIds: ['pack-b', 'pack-c'] }
  }

  /** 等待 fire-and-forget 影子评估落审计 */
  async function flushAsync(ms = 20): Promise<void> {
    await new Promise(r => setTimeout(r, ms))
  }

  it("flag='1' → ctx.competitiveMode=true 透传给内核；未配置 → false（默认关）", async () => {
    funnelMainFlag = null
    competitiveModeFlag = '1'
    setupBus()
    const plan = makePlan({ intent: '竞争任务' })
    routeMock.mockImplementation(async (_input: string, ctx: Record<string, unknown>) => {
      expect(ctx['competitiveMode']).toBe(true)
      return { kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome
    })
    await store.sendMessage('竞争测试')
    expect(routeMock).toHaveBeenCalledTimes(1)

    // 默认关
    competitiveModeFlag = null
    vault.clearCache()
    const pinia2 = createPinia()
    setActivePinia(pinia2)
    const store2 = useDialogStore()
    routeMock.mockImplementation(async (_input: string, ctx: Record<string, unknown>) => {
      expect(ctx['competitiveMode']).toBe(false)
      return { kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L0' } as FunnelOutcome
    })
    await store2.sendMessage('默认关测试')
    expect(routeMock).toHaveBeenCalledTimes(2)
  })

  it('带 competition 的自动执行 plan → 胜者 EMA outcome=1.0 + 败者影子评估审计事件（action=shadow-eval）', async () => {
    funnelMainFlag = null
    setupBus()
    // 预置胜者 EMA 低于 1.0，使成功更新可观测：0.729 → 0.9×0.729+0.1×1.0
    qualityEmaStore.update('pack-a', 0.0)
    qualityEmaStore.update('pack-a', 0.0)
    qualityEmaStore.update('pack-a', 0.0)
    expect(qualityEmaStore.get('pack-a')).toBeCloseTo(0.729)

    const audits: Array<Record<string, unknown>> = []
    globalBus.on('memory:add-audit-log', (p: unknown) => audits.push(p as Record<string, unknown>))

    const plan = makePlan({ intent: '竞争胜者任务' })
    routeMock.mockResolvedValue({
      kind: 'plan', plan, macroManifestId: null, autoExecutable: true, source: 'L4',
      competition: makeCompetition()
    } as FunnelOutcome)

    await store.sendMessage('执行竞争任务')
    await flushAsync()

    // 胜者 EMA outcome=1.0（执行成功经 presentExecutionOutput）
    expect(qualityEmaStore.get('pack-a')).toBeCloseTo(0.9 * 0.729 + 0.1 * 1.0)
    // 败者影子评估：每个败者一条审计（getActive 无内核 → 无钩子 → wouldVeto=false）
    expect(audits).toHaveLength(2)
    expect(audits.map(a => JSON.parse(String(a['details'])).packId).sort()).toEqual(['pack-b', 'pack-c'])
    expect(audits.every(a => a['action'] === 'shadow-eval' && a['toolId'] === 'kernel-competition')).toBe(true)
    expect(audits.every(a => JSON.parse(String(a['details'])).wouldVeto === false)).toBe(true)
    // 主流程不受影响：产出正常呈现
    expect(store.messages.some(m => m.role === 'assistant' && m.content.length > 0)).toBe(true)
    expect(store.isProcessing).toBe(false)
  })

  it('确认暂停点的 competition 记录 → 用户负反馈消息 → 胜者 EMA outcome=0.2', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '待确认竞争任务' })
    routeMock.mockResolvedValue({
      kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L2',
      competition: makeCompetition()
    } as FunnelOutcome)

    await store.sendMessage('竞争任务待确认')
    expect(store.awaitingConfirmation).toBe(true)

    await store.sendMessage('不对，这个结果是错误的')
    // EMA = 0.9×1.0 + 0.1×0.2
    expect(qualityEmaStore.get('pack-a')).toBeCloseTo(0.92)
  })

  it('rejectPlan → 竞争记录作废，后续负反馈不触发 EMA 更新', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '取消竞争任务' })
    routeMock.mockResolvedValue({
      kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L2',
      competition: makeCompetition()
    } as FunnelOutcome)

    await store.sendMessage('竞争任务将取消')
    expect(store.awaitingConfirmation).toBe(true)
    store.rejectPlan()

    await store.sendMessage('不对，这个结果是错误的')
    // 记录已被 rejectPlan 清理 → EMA 维持初始 1.0
    expect(qualityEmaStore.get('pack-a')).toBe(1.0)
  })

  it('非负反馈新消息 → 陈旧竞争记录清理（不产生 EMA 更新）', async () => {
    funnelMainFlag = null
    setupBus()
    const plan = makePlan({ intent: '陈旧记录任务' })
    routeMock.mockResolvedValue({
      kind: 'plan', plan, macroManifestId: null, autoExecutable: false, source: 'L2',
      competition: makeCompetition()
    } as FunnelOutcome)

    await store.sendMessage('竞争任务陈旧记录')
    expect(store.awaitingConfirmation).toBe(true)

    await store.sendMessage('帮我查一下天气')
    expect(qualityEmaStore.get('pack-a')).toBe(1.0)
  })
})
