import type { TaskPlan, DetectedDomain, L2ToolManifest } from '@/models'
import { applyScoreDelta, type FunnelLayerSet, type LayerResult, type FunnelBaseContext } from '@/kernel/funnel'
import type { AdvisoryContribution } from '@/kernel/hooks'
import { tryL0Skill, tryL05QuickMatch, checkL1Capability, classifyDomain, buildExplorePlan } from '@/services/l0SkillRouter'
import { translateIntent, planTask } from '@/services/promptTranslator'
import {
  buildToolIndex,
  universalMatch,
  getTop3CandidatesUniversal,
  llmFallback,
  extractCoreKeywords,
  type ToolIndex,
  type RaapMatchResult
} from '@/services/toolRetrieval'
import { selectRewriteStrategy, selectDisambigStrategy, extractStrategyContext } from '@/services/strategySelector'
import { extractEntities } from '@/services/nerExtractor'

/**
 * 默认内核插件：六层漏斗的真实服务装配（funnel.ts 是编排核，本模块是每层默认实现）。
 *
 * 行为等价基线 = dialogStore.sendMessage 旧六层内联实现（:601-1090）：
 * - L0   tryL0Skill 直通（确认暂停，无自动执行）
 * - L0.5 tryL05QuickMatch（门 0.8 / 自动执行 ≥0.9 且无 shell —— 由 funnel 门评估）
 * - L1   checkL1Capability（门 0.6 —— 由 funnel 门评估）
 * - L2   RaaP：反馈跳过 → universalMatch → keyword_extract 改写重试 →
 *        MCP 歧义候选 / MCP 直调 / L2 歧义黄门四策略（candidates/翻译确认/槽位填充）
 * - L3   LLM 仲裁：≥2 候选 → llmFallback；不可执行形态落 planTask 兜底
 * - L4   buildExplorePlan 探索模式（无 shell 自动执行 —— 由 funnel 门评估）
 *
 * 上下文数据（manifests/toolIndex/mcpTools/lastAssistantContent/recentUserMsg）由适配层注入；
 * UI 副作用（通知/暂停点状态机/执行）全部留在适配层，本模块只产出 LayerResult。
 */

export interface DefaultKernelContext extends FunnelBaseContext {
  /** 全部 L2 manifest（旧 node:get-all-l2-manifests） */
  allL2Manifests: L2ToolManifest[]
  /** 全部 MCP 工具（旧 allMcpTools；直调与 planTask 工具清单用） */
  mcpTools: { name: string; description: string }[]
  /** 可见 L2 过滤（旧 node:get-visible-l2-ids） */
  visibleL2Ids: string[]
  /** 角色过滤（旧 node:get-selected-role） */
  selectedRole?: string
  /** 最近一条助手消息内容（反馈检测用） */
  lastAssistantContent: string
  /** 上一条用户消息（translateIntent/planTask 上下文） */
  recentUserMsg: string
  /** LLM 仲裁通道（旧 api:chat-completion stream:false maxTokens:128） */
  chatCompletion: (messages: { role: string; content: string }[]) => Promise<{ content: string }>
  /** 请求内 toolIndex 缓存（L2 构建、L3 复用；适配层每请求新建 ctx 即重置） */
  toolIndexCache?: ToolIndex[]
}

// ---- 内部工具 ----

const FEEDBACK_RE = /没有|不存在|找不到|不行|错误|失败|没看到|没找到|搞错了|不对|不是/i
const SHORT_FEEDBACK_RE = /没有|不行|不对|错误|失败|找不到|不是/i

function detectedDomainOf(input: string): DetectedDomain {
  const domains = classifyDomain(input)
  if (domains.includes('legal')) return 'legal'
  if (domains.includes('finance')) return 'finance'
  if (domains.includes('hr')) return 'hr'
  return 'general'
}

async function ensureToolIndex(ctx: DefaultKernelContext): Promise<ToolIndex[]> {
  if (!ctx.toolIndexCache) {
    ctx.toolIndexCache = await buildToolIndex(
      ctx.mcpTools.map(t => ({ name: t.name, description: t.description })),
      ctx.allL2Manifests
    )
  }
  return ctx.toolIndexCache
}

/** 旧 :1081-1090 兜底：planTask 失败 → 通用单步计划 */
async function planTaskWithFallback(input: string, ctx: DefaultKernelContext): Promise<TaskPlan> {
  try {
    return await planTask(input, ctx.mcpTools.map(t => t.name), ctx.recentUserMsg)
  } catch {
    return {
      intent: input.substring(0, 50),
      needs: ['直接处理'],
      steps: [{ step: 1, description: '根据用户需求选择合适的工具执行任务', tool: 'auto', depends_on: [], params: {}, expectedOutput: '任务结果' }]
    }
  }
}

/** 旧 :1040-1077：从 RaaP 命中 manifest 构建计划；不可执行形态 → planTask 兜底（macroManifestId 置空） */
async function finalizeRaapPlan(raap: RaapMatchResult, input: string, ctx: DefaultKernelContext): Promise<LayerResult> {
  const m = raap.manifest
  if ((m.execution.mode === 'macro' || m.execution.mode === 'chain') && m.execution.dagPlan) {
    return {
      kind: 'plan',
      plan: {
        intent: m.identity.name,
        needs: m.routing.keywords.slice(0, 3),
        steps: m.execution.dagPlan.steps.map(s => ({
          step: s.step,
          description: s.description,
          tool: s.tool,
          depends_on: s.depends_on,
          params: s.params as Record<string, string>,
          expectedOutput: s.expectedOutput,
          fallback: s.fallback
        }))
      },
      macroManifestId: m.identity.id
    }
  }
  if (m.execution.mode === 'direct' && m.execution.directCall) {
    return {
      kind: 'plan',
      plan: {
        intent: m.identity.name,
        needs: m.routing.keywords.slice(0, 3),
        steps: [{
          step: 1,
          description: m.identity.name,
          tool: 'llm_generate',
          depends_on: [],
          params: { prompt: m.execution.directCall.promptTemplate },
          expectedOutput: m.identity.name + '输出'
        }]
      },
      macroManifestId: m.identity.id
    }
  }
  return { kind: 'plan', plan: await planTaskWithFallback(input, ctx), macroManifestId: null }
}

/** 旧 :848-956：L2 歧义黄门消歧四策略 */
async function disambiguate(input: string, raap: RaapMatchResult, ctx: DefaultKernelContext): Promise<LayerResult> {
  const cands = raap.candidates || []
  const disambigCtx = extractStrategyContext({
    content: input,
    entities: [],
    constraintResults: [],
    detectedDomain: detectedDomainOf(input),
    initialMatchFailed: true,
    candidates: cands.map(c => ({ score: c.score, targetRoles: c.manifest.routing.targetRoles }))
  })
  const strategy = selectDisambigStrategy(disambigCtx)

  switch (strategy) {
    case 'show_candidates': {
      if (cands.length > 1) {
        return {
          kind: 'candidates',
          candidates: cands.slice(0, 5).map(c => ({ id: c.manifest.identity.id, name: c.manifest.identity.name, score: c.score }))
        }
      }
      // 单候选 → 翻译意图（确认/槽位填充）；翻译失败 → 降级 L3
      const translated = await translateIntent(input, raap.manifest, ctx.recentUserMsg)
      if (translated) {
        const slotSlots = raap.manifest.execution.paramMapping?.slots || []
        const missingRequired = slotSlots.filter(s => s.required && !translated.params[s.name])
        if (missingRequired.length === 0) {
          return {
            kind: 'intent-confirm',
            intent: translated.intent,
            manifestId: raap.manifest.identity.id,
            params: translated.params,
            originalInput: input
          }
        }
        return {
          kind: 'slot-fill',
          manifestId: raap.manifest.identity.id,
          manifestName: raap.manifest.identity.name,
          slots: slotSlots.map(s => ({
            name: s.name,
            description: s.description,
            required: s.required,
            value: (translated.params[s.name] as string) || ''
          }))
        }
      }
      return { kind: 'miss' }
    }
    case 'auto_pick': {
      const top = cands[0]
      if (top) {
        return finalizeRaapPlan({
          manifest: top.manifest,
          confidence: top.score,
          matchMethod: top.method === 'keyword' ? 'keyword' : top.method === 'vector' ? 'vector' : 'model',
          isAmbiguous: false,
          gate: 'green'
        }, input, ctx)
      }
      return { kind: 'miss' }
    }
    case 'ask_clarify': {
      if (cands.length > 1) {
        return {
          kind: 'candidates',
          candidates: cands.slice(0, 5).map(c => ({ id: c.manifest.identity.id, name: c.manifest.identity.name, score: c.score }))
        }
      }
      return { kind: 'miss' }
    }
    case 'fallback_l1': {
      return { kind: 'miss' }
    }
  }
}

// ---- 六层默认实现 ----

/** L0 Skill 直通（旧 :601-628）：确认暂停，无自动执行 */
async function l0(input: string): Promise<LayerResult> {
  const l0Plan = await tryL0Skill(input)
  if (!l0Plan) return { kind: 'miss' }
  const domains = classifyDomain(input)
  return {
    kind: 'plan',
    plan: {
      intent: l0Plan.intent,
      needs: domains,
      steps: l0Plan.steps.map(s => ({
        step: s.step, description: s.description, tool: s.tool,
        depends_on: [], params: s.params, expectedOutput: s.expectedOutput
      }))
    },
    macroManifestId: null
  }
}

/** L0.5 快配（旧 :632-691）：门 0.8、自动执行 ≥0.9 且无 shell 由 funnel 评估 */
function l05(input: string, merged: AdvisoryContribution | null, ctx: DefaultKernelContext): LayerResult {
  const l05Result = tryL05QuickMatch(input, ctx.allL2Manifests)
  if (!l05Result) return { kind: 'miss' }
  const m = l05Result.manifest
  let plan: TaskPlan
  if (m.execution.mode === 'direct' && m.execution.directCall) {
    plan = {
      intent: m.identity.name,
      needs: m.routing.keywords.slice(0, 3),
      steps: [{
        step: 1,
        description: m.identity.name,
        tool: 'llm_generate',
        depends_on: [],
        params: { prompt: m.execution.directCall.promptTemplate.replace('{{input}}', input) },
        expectedOutput: m.identity.name + '输出'
      }]
    }
  } else if (m.execution.dagPlan) {
    plan = {
      intent: m.identity.name,
      needs: m.routing.keywords.slice(0, 3),
      steps: m.execution.dagPlan.steps.map(s => ({
        step: s.step, description: s.description, tool: s.tool,
        depends_on: s.depends_on, params: s.params as Record<string, string>, expectedOutput: s.expectedOutput
      }))
    }
  } else {
    plan = {
      intent: m.identity.name,
      needs: m.routing.keywords.slice(0, 3),
      steps: [{ step: 1, description: m.identity.name, tool: 'llm_generate', depends_on: [], params: { prompt: input }, expectedOutput: '处理结果' }]
    }
  }
  return { kind: 'plan', plan, macroManifestId: m.identity.id, score: applyScoreDelta(l05Result.confidence, merged) }
}


/** L1 能力直调（旧 :693-717）：门 0.6 由 funnel 评估 */
function l1(input: string, merged: AdvisoryContribution | null): LayerResult {
  const l1Check = checkL1Capability(input)
  if (!(l1Check.canHandle && l1Check.plan)) return { kind: 'miss' }
  return {
    kind: 'plan',
    plan: {
      intent: l1Check.plan.intent,
      needs: [l1Check.nodeId],
      steps: l1Check.plan.steps.map(s => ({
        step: s.step, description: s.description, tool: s.tool,
        depends_on: [], params: s.params, expectedOutput: s.expectedOutput
      }))
    },
    score: applyScoreDelta(l1Check.confidence, merged)
  }
}

/** L2 RaaP（旧 :721-956 + :1040-1090） */
async function l2(input: string, _merged: AdvisoryContribution | null, ctx: DefaultKernelContext): Promise<LayerResult> {
  // 反馈检测（旧 :736-746）：跳过 RaaP，直接降级 L3
  const isLikelyFeedback = ctx.lastAssistantContent.length > 50 && FEEDBACK_RE.test(input)
  const isShortFeedback = input.length < 30 && SHORT_FEEDBACK_RE.test(input)
  if (isLikelyFeedback || isShortFeedback) return { kind: 'miss' }

  const toolIndex = await ensureToolIndex(ctx)
  const filter = { visibleL2Ids: ctx.visibleL2Ids, selectedRole: ctx.selectedRole }

  let universalResult = await universalMatch(input, toolIndex, filter)

  // 未命中 → keyword_extract 改写重试（旧 :767-779）
  if (!universalResult) {
    const strategyCtx = extractStrategyContext({
      content: input,
      entities: extractEntities(input),
      constraintResults: [],
      detectedDomain: detectedDomainOf(input),
      initialMatchFailed: true,
      keywordCount: extractCoreKeywords(input).length
    })
    if (selectRewriteStrategy(strategyCtx) === 'keyword_extract') {
      const keywords = extractCoreKeywords(input)
      if (keywords.length > 0) {
        universalResult = await universalMatch(keywords.join(' '), toolIndex, filter)
      }
    }
  }
  if (!universalResult) return { kind: 'miss' }

  // MCP 分支（旧 :810-839）
  if (universalResult.item.source === 'mcp') {
    if (universalResult.isAmbiguous) {
      const cands = universalResult.candidates || []
      if (cands.length > 1) {
        return {
          kind: 'candidates',
          candidates: cands.slice(0, 5).map(c => ({ id: c.item.id, name: c.item.name, score: c.score }))
        }
      }
      return { kind: 'miss' }
    }
    if (ctx.mcpTools.some(t => t.name === universalResult!.item.id)) {
      return { kind: 'mcp-direct', toolName: universalResult.item.id }
    }
    return { kind: 'miss' }
  }

  // L2 manifest 分支（旧 :797-809）
  const manifest = universalResult.item.manifest
  if (!manifest) return { kind: 'miss' }
  const raap: RaapMatchResult = {
    manifest,
    confidence: universalResult.confidence,
    matchMethod: universalResult.matchMethod === 'keyword+vector' ? 'model' : universalResult.matchMethod,
    isAmbiguous: universalResult.isAmbiguous,
    candidates: universalResult.candidates
      ?.filter(c => c.item.source === 'l2' && c.item.manifest)
      .map(c => ({ manifest: c.item.manifest!, score: c.score, method: c.method })),
    gate: universalResult.gate
  }
  if (raap.isAmbiguous) {
    if (raap.gate !== 'yellow') return { kind: 'miss' }
    return disambiguate(input, raap, ctx)
  }
  return finalizeRaapPlan(raap, input, ctx)
}

/** L3 LLM 仲裁（旧 :959-1005） */
async function l3(input: string, _merged: AdvisoryContribution | null, ctx: DefaultKernelContext): Promise<LayerResult> {
  const toolIndex = await ensureToolIndex(ctx)
  if (toolIndex.length === 0) return { kind: 'miss' }
  const fbCandidates = getTop3CandidatesUniversal(input, toolIndex)
  if (fbCandidates.length < 2) return { kind: 'miss' }
  const fbItem = await llmFallback(input, fbCandidates, ctx.chatCompletion)
  if (!fbItem) return { kind: 'miss' }

  if (fbItem.source === 'l2' && fbItem.manifest) {
    return finalizeRaapPlan({
      manifest: fbItem.manifest,
      confidence: 0.5,
      matchMethod: 'model',
      isAmbiguous: false,
      gate: 'green'
    }, input, ctx)
  }
  if (fbItem.source === 'mcp' && ctx.mcpTools.some(t => t.name === fbItem!.id)) {
    return { kind: 'mcp-direct', toolName: fbItem.id }
  }
  // 旧路径：仲裁命中但无可执行形态（mcp 工具不在列表/l2 无 manifest）→ planTask 兜底
  return { kind: 'plan', plan: await planTaskWithFallback(input, ctx), macroManifestId: null }
}

/** L4 探索模式（旧 :1008-1037）：无 shell 自动执行由 funnel 评估 */
async function l4(input: string): Promise<LayerResult> {
  const explorePlan = await buildExplorePlan(input)
  return {
    kind: 'plan',
    plan: {
      intent: explorePlan.intent,
      needs: ['探索模式'],
      steps: explorePlan.steps.map(s => ({
        step: s.step, description: s.description, tool: s.tool,
        depends_on: [], params: s.params, expectedOutput: s.expectedOutput
      }))
    },
    macroManifestId: null
  }
}

/** 默认内核插件层集合：注入 runFunnel(config.layers) 即得与旧 dispatch 行为等价的六层路由 */
export function createDefaultLayers(): FunnelLayerSet<DefaultKernelContext> {
  return {
    l0: (input) => l0(input),
    l05: (input, merged, ctx) => l05(input, merged, ctx),
    l1: (input, merged) => l1(input, merged),
    l2: (input, merged, ctx) => l2(input, merged, ctx),
    l3: (input, merged, ctx) => l3(input, merged, ctx),
    l4: (input) => l4(input)
  }
}
