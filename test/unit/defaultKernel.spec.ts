import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { L2ToolManifest } from '@/models'

vi.mock('@/services/l0SkillRouter', () => ({
  tryL0Skill: vi.fn(),
  tryL05QuickMatch: vi.fn(),
  checkL1Capability: vi.fn(),
  classifyDomain: vi.fn(() => ['general']),
  buildExplorePlan: vi.fn()
}))
vi.mock('@/services/promptTranslator', () => ({
  translateIntent: vi.fn(),
  planTask: vi.fn()
}))
vi.mock('@/services/toolRetrieval', () => ({
  buildToolIndex: vi.fn(async () => []),
  universalMatch: vi.fn(),
  getTop3CandidatesUniversal: vi.fn(() => []),
  llmFallback: vi.fn(),
  extractCoreKeywords: vi.fn(() => [])
}))
vi.mock('@/services/strategySelector', () => ({
  selectRewriteStrategy: vi.fn(() => 'none'),
  selectDisambigStrategy: vi.fn(() => 'show_candidates'),
  extractStrategyContext: vi.fn(() => ({ contentLength: 0 }))
}))
vi.mock('@/services/nerExtractor', () => ({
  extractEntities: vi.fn(() => [])
}))

import { createDefaultLayers, type DefaultKernelContext } from '@/kernels/default'
import { runFunnel, type LayerResult } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import { tryL0Skill, tryL05QuickMatch, checkL1Capability, classifyDomain, buildExplorePlan } from '@/services/l0SkillRouter'
import { translateIntent, planTask } from '@/services/promptTranslator'
import { universalMatch, getTop3CandidatesUniversal, llmFallback, extractCoreKeywords, buildToolIndex } from '@/services/toolRetrieval'
import { selectDisambigStrategy } from '@/services/strategySelector'
import type { UniversalMatchResult, MatchableItem } from '@/services/toolRetrieval'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(classifyDomain).mockReturnValue(['general'])
  vi.mocked(selectDisambigStrategy).mockReturnValue('show_candidates')
})

function makeManifest(over: {
  id?: string
  name?: string
  keywords?: string[]
  mode?: 'direct' | 'macro' | 'chain'
  directCall?: L2ToolManifest['execution']['directCall']
  dagPlan?: L2ToolManifest['execution']['dagPlan']
  slots?: L2ToolManifest['execution']['paramMapping']['slots']
} = {}): L2ToolManifest {
  return {
    identity: { id: over.id ?? 'm-1', name: over.name ?? '技能一', version: '1', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' },
    visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' },
    routing: { keywords: over.keywords ?? ['技能'], targetRoles: [], requiredL1: [], inputType: 'text', retrievalSummary: '', userSummary: '', confidenceThreshold: 0.5 },
    execution: {
      mode: over.mode ?? 'macro',
      directCall: over.directCall,
      dagPlan: over.dagPlan,
      paramMapping: { slots: over.slots ?? [], bindings: [] }
    },
    cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false }
  }
}

function makeCtx(over: Partial<DefaultKernelContext> = {}): DefaultKernelContext {
  return {
    allL2Manifests: [],
    mcpTools: [],
    visibleL2Ids: [],
    lastAssistantContent: '',
    recentUserMsg: '',
    chatCompletion: vi.fn(async () => ({ content: '' })),
    ...over
  }
}

/** L3 需要 toolIndex 非空才进仲裁 */
function mockNonEmptyToolIndex(): void {
  vi.mocked(buildToolIndex).mockResolvedValue([
    { fullName: 't', shortName: 't', summary: 's', description: 'd', vector: [1], mcpId: '' }
  ])
}

function makeMatchItem(over: Partial<MatchableItem> & { source: 'l2' | 'mcp' }): MatchableItem {
  return {
    id: over.id ?? 'item-1',
    name: over.name ?? '条目一',
    description: '',
    keywords: [],
    userSummary: '',
    ...over
  }
}

describe('P3.3：默认内核插件（六层行为等价）', () => {
  const layers = createDefaultLayers()

  // ---- L0 ----
  it('L0：tryL0Skill 命中 → plan（needs=域，depends_on 强制空，macroManifestId=null）', async () => {
    vi.mocked(tryL0Skill).mockResolvedValue({
      intent: '保存文件到桌面',
      steps: [{ step: 1, description: '写文件', tool: 'file_write', params: { path: 'a.md' }, expectedOutput: '文件' }],
      isExploration: false
    })
    vi.mocked(classifyDomain).mockReturnValue(['file'])
    const result = await layers.l0('保存文件', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.intent).toBe('保存文件到桌面')
      expect(result.plan.needs).toEqual(['file'])
      expect(result.plan.steps[0].depends_on).toEqual([])
      expect(result.macroManifestId).toBeNull()
    }
  })

  it('L0：未命中 → miss', async () => {
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    expect((await layers.l0('复杂多步任务', null, makeCtx())).kind).toBe('miss')
  })

  // ---- L0.5 ----
  it('L0.5：direct manifest 命中 → plan（{{input}} 替换、score=置信）', () => {
    const m = makeManifest({
      mode: 'direct',
      directCall: { l1Target: 'l1-model-gateway', promptTemplate: '处理 {{input}}', maxTokens: 512 }
    })
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: m, confidence: 0.85, matchedKeywords: ['技能'] })
    const result = layers.l05('查技能 x', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.steps[0].params.prompt).toBe('处理 查技能 x')
      expect(result.score).toBeCloseTo(0.85)
      expect(result.macroManifestId).toBe('m-1')
    }
  })

  it('L0.5：scoreDelta 叠加置信分', () => {
    const m = makeManifest({ mode: 'direct', directCall: { l1Target: 'l1', promptTemplate: 'p', maxTokens: 1 } })
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: m, confidence: 0.85, matchedKeywords: ['技能'] })
    const result = layers.l05('x', { scoreDelta: 0.1 }, makeCtx())
    if (result.kind === 'plan') expect(result.score).toBeCloseTo(0.95)
  })

  it('L0.5：无 dagPlan 的兜底单步计划', () => {
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: makeManifest({ mode: 'macro' }), confidence: 0.85, matchedKeywords: ['技能'] })
    const result = layers.l05('原始输入', null, makeCtx())
    if (result.kind === 'plan') {
      expect(result.plan.steps[0].params.prompt).toBe('原始输入')
      expect(result.plan.steps[0].expectedOutput).toBe('处理结果')
    }
  })

  it('L0.5：未命中 → miss', () => {
    vi.mocked(tryL05QuickMatch).mockReturnValue(null)
    expect(layers.l05('x', null, makeCtx()).kind).toBe('miss')
  })

  // ---- L1 ----
  it('L1：checkL1Capability 命中 → plan（needs=[nodeId]，score=置信）', () => {
    vi.mocked(checkL1Capability).mockReturnValue({
      canHandle: true,
      nodeId: 'l1-model-gateway',
      nodeName: '模型网关',
      confidence: 0.8,
      plan: { intent: '翻译这段话', steps: [{ step: 1, description: '模型网关处理', tool: 'llm_generate', params: { prompt: '翻译这段话' }, expectedOutput: '处理结果' }], isExploration: false }
    })
    const result = layers.l1('帮我翻译', null)
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.needs).toEqual(['l1-model-gateway'])
      expect(result.score).toBeCloseTo(0.8)
    }
  })

  it('L1：canHandle=false → miss', () => {
    vi.mocked(checkL1Capability).mockReturnValue({ canHandle: false, nodeId: '', nodeName: '', confidence: 0, plan: null })
    expect(layers.l1('x', null).kind).toBe('miss')
  })

  // ---- L2 ----
  it('L2：反馈检测命中（长助手消息+否定词）→ 跳过检索直接 miss', async () => {
    const ctx = makeCtx({ lastAssistantContent: 'x'.repeat(80) })
    const result = await layers.l2('不对，没有这个', null, ctx)
    expect(result.kind).toBe('miss')
    expect(universalMatch).not.toHaveBeenCalled()
  })

  it('L2：短反馈（<30字否定词）→ miss', async () => {
    const result = await layers.l2('找不到', null, makeCtx())
    expect(result.kind).toBe('miss')
  })

  it('L2：首次未命中 → keyword_extract 改写重试命中', async () => {
    const m = makeManifest({ mode: 'macro', dagPlan: { steps: [{ step: 1, description: 'd', tool: 'llm_generate', depends_on: [], params: {}, expectedOutput: 'o' }], fallbackStrategy: 'retry', maxRetries: 1 } })
    vi.mocked(extractCoreKeywords).mockReturnValue(['合同', '审查'])
    vi.mocked(universalMatch)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        item: makeMatchItem({ source: 'l2', manifest: m }),
        confidence: 0.9,
        matchMethod: 'keyword',
        isAmbiguous: false,
        gate: 'green'
      } as UniversalMatchResult)
    const { selectRewriteStrategy } = await import('@/services/strategySelector')
    vi.mocked(selectRewriteStrategy).mockReturnValue('keyword_extract')
    const result = await layers.l2('帮我做合同合规审查的详细分析报告', null, makeCtx())
    expect(result.kind).toBe('plan')
    expect(universalMatch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(universalMatch).mock.calls[1][0]).toBe('合同 审查')
  })

  it('L2：MCP 歧义且候选>1 → candidates（截取前5）', async () => {
    const cands = Array.from({ length: 7 }, (_, i) => ({
      item: makeMatchItem({ source: 'mcp', id: `t${i}`, name: `工具${i}` }),
      score: 0.9 - i * 0.1,
      method: 'keyword'
    }))
    vi.mocked(universalMatch).mockResolvedValue({
      item: cands[0].item,
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: cands,
      gate: 'yellow'
    } as UniversalMatchResult)
    const result = await layers.l2('查工具', null, makeCtx())
    expect(result.kind).toBe('candidates')
    if (result.kind === 'candidates') {
      expect(result.candidates).toHaveLength(5)
      expect(result.candidates[0]).toEqual({ id: 't0', name: '工具0', score: 0.9 })
    }
  })

  it('L2：MCP 歧义但候选≤1 → miss（降级 L3）', async () => {
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'mcp' }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [],
      gate: 'yellow'
    } as UniversalMatchResult)
    expect((await layers.l2('查工具', null, makeCtx())).kind).toBe('miss')
  })

  it('L2：MCP 无歧义且工具在列表 → mcp-direct', async () => {
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'mcp', id: 'tool_a', name: 'A工具' }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    const ctx = makeCtx({ mcpTools: [{ name: 'tool_a', description: '' }] })
    const result = await layers.l2('用A工具', null, ctx)
    expect(result.kind).toBe('mcp-direct')
    if (result.kind === 'mcp-direct') expect(result.toolName).toBe('tool_a')
  })

  it('L2：MCP 无歧义但工具不在列表 → miss（降级 L3）', async () => {
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'mcp', id: 'tool_x' }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    expect((await layers.l2('用X工具', null, makeCtx())).kind).toBe('miss')
  })

  it('L2：L2 manifest 绿色无歧义 macro+dagPlan → plan（含 fallback 透传、manifestId）', async () => {
    const m = makeManifest({
      id: 'contract-review',
      name: '合同审查',
      mode: 'macro',
      dagPlan: {
        steps: [
          { step: 1, description: '读文件', tool: 'file_read', depends_on: [], params: { path: 'a.md' }, expectedOutput: '内容', fallback: 'knowledge_search' },
          { step: 2, description: '审查', tool: 'llm_generate', depends_on: [1], params: {}, expectedOutput: '审查结果' }
        ],
        fallbackStrategy: 'retry',
        maxRetries: 2
      }
    })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    const result = await layers.l2('审查合同', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.intent).toBe('合同审查')
      expect(result.plan.steps[0].fallback).toBe('knowledge_search')
      expect(result.plan.steps[1].depends_on).toEqual([1])
      expect(result.macroManifestId).toBe('contract-review')
    }
  })

  it('L2：direct 模式 manifest → 单步 prompt 模板计划', async () => {
    const m = makeManifest({ mode: 'direct', directCall: { l1Target: 'l1', promptTemplate: '直接处理模板', maxTokens: 128 } })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    const result = await layers.l2('x', null, makeCtx())
    if (result.kind === 'plan') {
      expect(result.plan.steps[0].params.prompt).toBe('直接处理模板')
      expect(result.macroManifestId).toBe('m-1')
    }
  })

  it('L2：命中但不可执行形态（macro 无 dagPlan）→ planTask 兜底、manifestId 置空', async () => {
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: makeManifest({ mode: 'macro' }) }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    vi.mocked(planTask).mockResolvedValue({
      intent: 'LLM规划', needs: ['n'], steps: [{ step: 1, description: 'd', tool: 'auto', depends_on: [], params: {}, expectedOutput: 'o' }]
    })
    const ctx = makeCtx({ mcpTools: [{ name: 't1', description: '' }], recentUserMsg: '上一条' })
    const result = await layers.l2('x', null, ctx)
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.intent).toBe('LLM规划')
      expect(result.macroManifestId).toBeNull()
      expect(planTask).toHaveBeenCalledWith('x', ['t1'], '上一条')
    }
  })

  it('L2：planTask 抛错 → 通用单步兜底计划', async () => {
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: makeManifest({ mode: 'macro' }) }),
      confidence: 0.9,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    vi.mocked(planTask).mockRejectedValue(new Error('LLM down'))
    const result = await layers.l2('用户请求内容', null, makeCtx())
    if (result.kind === 'plan') {
      expect(result.plan.steps[0].tool).toBe('auto')
      expect(result.plan.intent).toBe('用户请求内容')
    }
  })

  it('L2：黄色歧义 show_candidates 多候选 → candidates（manifest id/name）', async () => {
    const m1 = makeManifest({ id: 'a', name: '技能A' })
    const m2 = makeManifest({ id: 'b', name: '技能B' })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m1 }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [
        { item: makeMatchItem({ source: 'l2', manifest: m1 }), score: 0.7, method: 'keyword' },
        { item: makeMatchItem({ source: 'l2', manifest: m2 }), score: 0.65, method: 'vector' }
      ],
      gate: 'yellow'
    } as UniversalMatchResult)
    const result = await layers.l2('查技能', null, makeCtx())
    expect(result.kind).toBe('candidates')
    if (result.kind === 'candidates') {
      expect(result.candidates[0]).toEqual({ id: 'a', name: '技能A', score: 0.7 })
      expect(result.candidates[1]).toEqual({ id: 'b', name: '技能B', score: 0.65 })
    }
  })

  it('L2：黄色歧义 show_candidates 单候选 → translateIntent 确认（intent-confirm）', async () => {
    const m = makeManifest({ id: 'a', name: '技能A' })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [{ item: makeMatchItem({ source: 'l2', manifest: m }), score: 0.7, method: 'keyword' }],
      gate: 'yellow'
    } as UniversalMatchResult)
    vi.mocked(translateIntent).mockResolvedValue({ intent: '执行技能A', params: { x: '1' } })
    const ctx = makeCtx({ recentUserMsg: '上文' })
    const result = await layers.l2('做A', null, ctx)
    expect(result.kind).toBe('intent-confirm')
    if (result.kind === 'intent-confirm') {
      expect(result.intent).toBe('执行技能A')
      expect(result.manifestId).toBe('a')
      expect(result.params).toEqual({ x: '1' })
      expect(result.originalInput).toBe('做A')
    }
    expect(translateIntent).toHaveBeenCalledWith('做A', m, '上文')
  })

  it('L2：翻译成功但缺必填槽位 → slot-fill', async () => {
    const m = makeManifest({
      id: 'a', name: '技能A',
      slots: [
        { name: 'company', source: 'input_text', description: '公司名', required: true },
        { name: 'date', source: 'context', description: '日期', required: false }
      ]
    })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [{ item: makeMatchItem({ source: 'l2', manifest: m }), score: 0.7, method: 'keyword' }],
      gate: 'yellow'
    } as UniversalMatchResult)
    vi.mocked(translateIntent).mockResolvedValue({ intent: '执行', params: { date: '2026-01-01' } })
    const result = await layers.l2('做A', null, makeCtx())
    expect(result.kind).toBe('slot-fill')
    if (result.kind === 'slot-fill') {
      expect(result.manifestId).toBe('a')
      expect(result.slots[0]).toEqual({ name: 'company', description: '公司名', required: true, value: '' })
      expect(result.slots[1].value).toBe('2026-01-01')
    }
  })

  it('L2：翻译超时/失败 → miss（降级 L3）', async () => {
    const m = makeManifest({ id: 'a' })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [{ item: makeMatchItem({ source: 'l2', manifest: m }), score: 0.7, method: 'keyword' }],
      gate: 'yellow'
    } as UniversalMatchResult)
    vi.mocked(translateIntent).mockResolvedValue(null)
    expect((await layers.l2('做A', null, makeCtx())).kind).toBe('miss')
  })

  it('L2：auto_pick → 首候选转绿色直出计划', async () => {
    const m1 = makeManifest({ id: 'a', name: '技能A', mode: 'macro', dagPlan: { steps: [{ step: 1, description: 'd', tool: 'llm_generate', depends_on: [], params: {}, expectedOutput: 'o' }], fallbackStrategy: 'retry', maxRetries: 1 } })
    const m2 = makeManifest({ id: 'b', name: '技能B' })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m1 }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [
        { item: makeMatchItem({ source: 'l2', manifest: m1 }), score: 0.7, method: 'keyword' },
        { item: makeMatchItem({ source: 'l2', manifest: m2 }), score: 0.6, method: 'keyword' }
      ],
      gate: 'yellow'
    } as UniversalMatchResult)
    vi.mocked(selectDisambigStrategy).mockReturnValue('auto_pick')
    const result = await layers.l2('查技能', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.intent).toBe('技能A')
      expect(result.macroManifestId).toBe('a')
    }
  })

  it('L2：fallback_l1 / ask_clarify 无多候选 → miss', async () => {
    const m = makeManifest({ id: 'a' })
    const universal: UniversalMatchResult = {
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [{ item: makeMatchItem({ source: 'l2', manifest: m }), score: 0.7, method: 'keyword' }],
      gate: 'yellow'
    }
    vi.mocked(universalMatch).mockResolvedValue(universal)
    vi.mocked(selectDisambigStrategy).mockReturnValue('fallback_l1')
    expect((await layers.l2('查技能', null, makeCtx())).kind).toBe('miss')
    vi.mocked(selectDisambigStrategy).mockReturnValue('ask_clarify')
    expect((await layers.l2('查技能', null, makeCtx())).kind).toBe('miss')
  })

  // ---- L3 ----
  it('L3：候选<2 → miss', async () => {
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([])
    expect((await layers.l3('x', null, makeCtx())).kind).toBe('miss')
  })

  it('L3：仲裁选中 L2 manifest → 绿色计划（置信0.5 语义）', async () => {
    mockNonEmptyToolIndex()
    const m = makeManifest({ id: 'a', name: '技能A', mode: 'macro', dagPlan: { steps: [{ step: 1, description: 'd', tool: 'llm_generate', depends_on: [], params: {}, expectedOutput: 'o' }], fallbackStrategy: 'retry', maxRetries: 1 } })
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([
      { item: makeMatchItem({ source: 'l2', manifest: m }), score: 0.5, method: 'keyword' },
      { item: makeMatchItem({ source: 'mcp', id: 't' }), score: 0.4, method: 'keyword' }
    ])
    vi.mocked(llmFallback).mockResolvedValue(makeMatchItem({ source: 'l2', manifest: m }))
    const result = await layers.l3('x', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') expect(result.macroManifestId).toBe('a')
  })

  it('L3：仲裁选中 MCP 工具在列表 → mcp-direct', async () => {
    mockNonEmptyToolIndex()
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([
      { item: makeMatchItem({ source: 'mcp', id: 'tool_a' }), score: 0.5, method: 'keyword' },
      { item: makeMatchItem({ source: 'mcp', id: 'tool_b' }), score: 0.4, method: 'keyword' }
    ])
    vi.mocked(llmFallback).mockResolvedValue(makeMatchItem({ source: 'mcp', id: 'tool_a' }))
    const ctx = makeCtx({ mcpTools: [{ name: 'tool_a', description: '' }] })
    const result = await layers.l3('x', null, ctx)
    expect(result.kind).toBe('mcp-direct')
  })

  it('L3：仲裁选中 MCP 但工具不在列表 → planTask 兜底（旧路径等价）', async () => {
    mockNonEmptyToolIndex()
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([
      { item: makeMatchItem({ source: 'mcp', id: 'tool_x' }), score: 0.5, method: 'keyword' },
      { item: makeMatchItem({ source: 'mcp', id: 'tool_b' }), score: 0.4, method: 'keyword' }
    ])
    vi.mocked(llmFallback).mockResolvedValue(makeMatchItem({ source: 'mcp', id: 'tool_x' }))
    vi.mocked(planTask).mockResolvedValue({ intent: '兜底', needs: [], steps: [{ step: 1, description: 'd', tool: 'auto', depends_on: [], params: {}, expectedOutput: 'o' }] })
    const result = await layers.l3('x', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.intent).toBe('兜底')
      expect(result.macroManifestId).toBeNull()
    }
  })

  it('L3：仲裁失败 → miss（降级 L4）', async () => {
    mockNonEmptyToolIndex()
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([
      { item: makeMatchItem({ source: 'mcp', id: 'a' }), score: 0.5, method: 'keyword' },
      { item: makeMatchItem({ source: 'mcp', id: 'b' }), score: 0.4, method: 'keyword' }
    ])
    vi.mocked(llmFallback).mockResolvedValue(null)
    expect((await layers.l3('x', null, makeCtx())).kind).toBe('miss')
  })

  // ---- L4 ----
  it('L4：探索计划 → plan（needs=[探索模式]，depends_on 强制空）', async () => {
    vi.mocked(buildExplorePlan).mockResolvedValue({
      intent: '探索用户请求',
      steps: [{ step: 1, description: 'LLM直接处理', tool: 'llm_generate', params: { prompt: 'x' }, expectedOutput: '处理结果' }],
      isExploration: true
    })
    const result = await layers.l4('随便聊聊')
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.needs).toEqual(['探索模式'])
      expect(result.plan.steps[0].depends_on).toEqual([])
      expect(result.macroManifestId).toBeNull()
    }
  })

  // ---- funnel × 默认层 集成（六层降级路径） ----
  it('集成：L0-L3 全 miss → L4 探索（autoExecutable=无shell）', async () => {
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    vi.mocked(tryL05QuickMatch).mockReturnValue(null)
    vi.mocked(checkL1Capability).mockReturnValue({ canHandle: false, nodeId: '', nodeName: '', confidence: 0, plan: null })
    vi.mocked(universalMatch).mockResolvedValue(null)
    vi.mocked(getTop3CandidatesUniversal).mockReturnValue([])
    vi.mocked(buildExplorePlan).mockResolvedValue({
      intent: '探索',
      steps: [{ step: 1, description: 'LLM直接处理', tool: 'llm_generate', params: { prompt: 'x' }, expectedOutput: '处理结果' }],
      isExploration: true
    })
    const outcome = await runFunnel(
      { layers: createDefaultLayers(), hooks: new HookRunner<LayerResult>() },
      'x',
      makeCtx()
    )
    expect(outcome.kind).toBe('plan')
    if (outcome.kind === 'plan') {
      expect(outcome.source).toBe('L4')
      expect(outcome.autoExecutable).toBe(true)
    }
  })

  it('集成：L0.5 高置信无shell → autoExecutable=true；低置信 → 降级', async () => {
    const m = makeManifest({ mode: 'direct', directCall: { l1Target: 'l1', promptTemplate: 'p {{input}}', maxTokens: 1 } })
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: m, confidence: 0.95, matchedKeywords: ['技能'] })
    const outcome = await runFunnel(
      { layers: createDefaultLayers(), hooks: new HookRunner<LayerResult>() },
      '技能 x',
      makeCtx()
    )
    if (outcome.kind === 'plan') {
      expect(outcome.source).toBe('L0.5')
      expect(outcome.autoExecutable).toBe(true)
    }
  })

  it('集成：L2 MCP 歧义 → candidates 暂停点（source=L2）', async () => {
    vi.mocked(tryL0Skill).mockResolvedValue(null)
    vi.mocked(tryL05QuickMatch).mockReturnValue(null)
    vi.mocked(checkL1Capability).mockReturnValue({ canHandle: false, nodeId: '', nodeName: '', confidence: 0, plan: null })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'mcp', id: 't0' }),
      confidence: 0.8,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [
        { item: makeMatchItem({ source: 'mcp', id: 't0', name: '甲' }), score: 0.8, method: 'keyword' },
        { item: makeMatchItem({ source: 'mcp', id: 't1', name: '乙' }), score: 0.7, method: 'keyword' }
      ],
      gate: 'yellow'
    } as UniversalMatchResult)
    const outcome = await runFunnel(
      { layers: createDefaultLayers(), hooks: new HookRunner<LayerResult>() },
      '查工具',
      makeCtx()
    )
    expect(outcome.kind).toBe('candidates')
    if (outcome.kind === 'candidates') expect(outcome.source).toBe('L2')
  })
})

describe('P0-A：输入门控（RaaP 误路由修复）', () => {
  const layers = createDefaultLayers()

  function makeTypedManifest(over: {
    id?: string
    inputType: 'file' | 'text' | 'file_or_text'
    steps?: L2ToolManifest['execution']['dagPlan']
  }): L2ToolManifest {
    const base = makeManifest({ id: over.id ?? 'm-1', mode: 'macro', dagPlan: over.steps })
    return { ...base, routing: { ...base.routing, inputType: over.inputType } }
  }

  const MEETING_DAG: L2ToolManifest['execution']['dagPlan'] = {
    steps: [
      { step: 1, description: '读取会议记录文件', tool: 'read_file', depends_on: [], params: { path: '{{user_file}}' }, expectedOutput: '会议原始记录' },
      { step: 2, description: 'AI生成会议纪要', tool: 'llm_generate', depends_on: [1], params: { prompt: '根据以下会议记录生成纪要：\n{{step_1_result}}' }, expectedOutput: '会议纪要' }
    ],
    fallbackStrategy: 'retry',
    maxRetries: 1
  }

  it('L2 绿色：file 模板无文件输入 → planTask 兜底（macroManifestId=null）', async () => {
    const m = makeTypedManifest({ id: 'reader', inputType: 'file', steps: MEETING_DAG })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.97,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    vi.mocked(planTask).mockResolvedValue({ intent: '兜底', needs: [], steps: [{ step: 1, description: 'd', tool: 'auto', depends_on: [], params: {}, expectedOutput: 'o' }] })
    const result = await layers.l2('帮我看看这段文字说了什么大概意思', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.macroManifestId).toBeNull()
      expect(result.plan.intent).toBe('兜底')
    }
  })

  it('L2 绿色：file_or_text + 内联材料 → 剥离 read_file、材料注入 prompt', async () => {
    const m = makeTypedManifest({ id: 'minutes', inputType: 'file_or_text', steps: MEETING_DAG })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.97,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    const result = await layers.l2('整理成会议纪要，内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责跟进', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.macroManifestId).toBe('minutes')
      expect(result.plan.steps).toHaveLength(1)
      expect(result.plan.steps[0].tool).toBe('llm_generate')
      expect(String(result.plan.steps[0].params.prompt)).toContain('张三汇报了项目进度')
      expect(String(result.plan.steps[0].params.prompt)).not.toContain('{{step_1_result}}')
    }
  })

  it('L2 绿色：file_or_text + 真实路径 → {{user_file}} 绑定', async () => {
    const m = makeTypedManifest({ id: 'minutes', inputType: 'file_or_text', steps: MEETING_DAG })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: m }),
      confidence: 0.97,
      matchMethod: 'keyword',
      isAmbiguous: false,
      gate: 'green'
    } as UniversalMatchResult)
    const result = await layers.l2('把 C:\\Users\\Admin\\Desktop\\记录.docx 整理成会议纪要', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.steps[0].tool).toBe('read_file')
      expect(String(result.plan.steps[0].params.path)).toBe('C:\\Users\\Admin\\Desktop\\记录.docx')
    }
  })

  it('L2 黄门 show_candidates：file 候选被过滤后仅剩 text 候选 → 单候选翻译路径用幸存者', async () => {
    const mFile = makeTypedManifest({ id: 'reader', inputType: 'file', steps: MEETING_DAG })
    const mText = makeTypedManifest({ id: 'writer', inputType: 'text', steps: MEETING_DAG })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: mFile }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [
        { item: makeMatchItem({ source: 'l2', manifest: mFile }), score: 0.7, method: 'keyword' },
        { item: makeMatchItem({ source: 'l2', manifest: mText }), score: 0.6, method: 'keyword' }
      ],
      gate: 'yellow'
    } as UniversalMatchResult)
    vi.mocked(translateIntent).mockResolvedValue({ intent: '执行writer', params: { x: '1' } })
    const result = await layers.l2('帮我看看这段文字说了什么大概意思呢', null, makeCtx())
    expect(result.kind).toBe('intent-confirm')
    expect(translateIntent).toHaveBeenCalledWith(expect.anything(), mText, expect.anything())
  })

  it('L2 黄门：全部候选被门控拒绝 → miss（降级 L3）', async () => {
    const mFile = makeTypedManifest({ id: 'reader', inputType: 'file', steps: MEETING_DAG })
    vi.mocked(universalMatch).mockResolvedValue({
      item: makeMatchItem({ source: 'l2', manifest: mFile }),
      confidence: 0.7,
      matchMethod: 'keyword',
      isAmbiguous: true,
      candidates: [{ item: makeMatchItem({ source: 'l2', manifest: mFile }), score: 0.7, method: 'keyword' }],
      gate: 'yellow'
    } as UniversalMatchResult)
    expect((await layers.l2('帮我看看这段文字说了什么大概意思呢', null, makeCtx())).kind).toBe('miss')
  })

  it('L0.5：file 模板无文件输入 → miss', () => {
    const m = makeTypedManifest({ id: 'reader', inputType: 'file', steps: MEETING_DAG })
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: m, confidence: 0.95, matchedKeywords: ['技能'] })
    expect(layers.l05('帮我看看这段文字说了什么大概意思', null, makeCtx()).kind).toBe('miss')
  })

  it('L0.5：file_or_text + 内联材料 → 适配后的计划', () => {
    const m = makeTypedManifest({ id: 'minutes', inputType: 'file_or_text', steps: MEETING_DAG })
    vi.mocked(tryL05QuickMatch).mockReturnValue({ manifest: m, confidence: 0.95, matchedKeywords: ['技能'] })
    const result = layers.l05('整理成会议纪要，内容如下：张三汇报了项目进度，李四提出了预算问题，王五负责跟进', null, makeCtx())
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') {
      expect(result.plan.steps).toHaveLength(1)
      expect(result.plan.steps[0].tool).toBe('llm_generate')
    }
  })
})
