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
import { gateTemplateForInput, classifyTemplateInput, detectInputForm } from '@/services/inputForm'
import { extractEntities } from '@/services/nerExtractor'
import { getPackIdForManifest, getPackWeight } from '@/host/packRuntime'
import { computeBidScore, resolveCompetition, qualityEmaStore, type PackBidder } from '@/kernel/competition'
import type { CompetitionRecord } from '@/kernel/funnel'

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
  /** M16 竞争模式 flag（vault config:holo-competitive-mode，默认关）：L2 跨 pack 歧义候选按竞标分竞争 */
  competitiveMode?: boolean
}

// ---- 内部工具 ----

const FEEDBACK_RE = /没有|不存在|找不到|不行|错误|失败|没看到|没找到|搞错了|不对|不是/i
const SHORT_FEEDBACK_RE = /没有|不行|不对|错误|失败|找不到|不是/i

export { FEEDBACK_RE, SHORT_FEEDBACK_RE }

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

/** 旧 :1040-1077：从 RaaP 命中 manifest 构建计划；不可执行形态 → planTask 兜底（macroManifestId 置空）。
 *  P0-A：构建前先过输入门控（gateTemplateForInput）——file 模板无文件输入 → planTask 兜底；
 *  file_or_text 无文件但有内联材料 → 剥离读取步骤、材料直注 prompt；有真实路径 → 绑定 {{user_file}}。 */
/**
 * G-11（2026-09-25）：把 manifest 声明的 `routing.requiredL1` 消费进 `plan.needs`。
 * 此前 requiredL1 全仓零消费者（快照 §〇 核实）——声明的 L1 能力既不进计划、也不被校验。
 * 这里让它进入计划产出。`needs` 仅用于确认 UI 展示与 DAG 标注、**从不下发 LLM**
 * （grep 证实 macroExecutor/promptTranslator 均不读 needs），故零行为风险。
 */
function manifestPlanNeeds(m: { routing: { requiredL1?: string[]; keywords: string[] } }): string[] {
  return [...(m.routing.requiredL1 || []), ...m.routing.keywords.slice(0, 3)]
}

async function finalizeRaapPlan(raap: RaapMatchResult, input: string, ctx: DefaultKernelContext): Promise<LayerResult> {
  const m = raap.manifest
  const gate = gateTemplateForInput(m, input)
  if (gate.action === 'reject') {
    return { kind: 'plan', plan: await planTaskWithFallback(input, ctx), macroManifestId: null }
  }
  if ((m.execution.mode === 'macro' || m.execution.mode === 'chain') && m.execution.dagPlan) {
    const sourceSteps = gate.steps || m.execution.dagPlan.steps
    return {
      kind: 'plan',
      plan: {
        intent: m.identity.name,
        needs: manifestPlanNeeds(m),
        steps: sourceSteps.map(s => ({
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
        needs: manifestPlanNeeds(m),
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

/**
 * M16 竞争分支：跨 pack 歧义候选按 竞标分=置信度×weight×质量EMA 竞争（规格 9.1）。
 * 触发条件（全部满足，否则返回 null 走原消歧四策略）：
 * - 候选可归因到 ≥2 个不同挂载 pack（getPackIdForManifest；未归因候选不参与）
 * - 胜者 manifest 有可执行形态（finalizeRaapPlan 产出 plan）
 * 同 pack 内候选歧义不触发竞争（"仅一个 pack 候选 → 退化为单匹配"）。
 */
async function competeAcrossPacks(input: string, raap: RaapMatchResult, ctx: DefaultKernelContext): Promise<LayerResult | null> {
  const cands = (raap.candidates || []).filter(c => c.manifest)
  const byPack = new Map<string, { manifest: L2ToolManifest; score: number; seq: number }>()
  let seq = 0
  for (const c of cands) {
    const m = c.manifest as L2ToolManifest
    const packId = getPackIdForManifest(m.identity.id)
    if (packId) {
      const existing = byPack.get(packId)
      if (!existing) {
        byPack.set(packId, { manifest: m, score: c.score, seq })
      } else if (c.score > existing.score) {
        byPack.set(packId, { manifest: m, score: c.score, seq: existing.seq })
      }
    }
    seq++
  }
  if (byPack.size < 2) return null

  const bidders: PackBidder[] = [...byPack.entries()].map(([packId, top]) => ({
    packId,
    confidence: top.score,
    weight: getPackWeight(packId),
    ema: qualityEmaStore.get(packId),
    seq: top.seq
  }))
  const resolved = resolveCompetition(bidders)
  if (!resolved) return null

  const winnerTop = byPack.get(resolved.winner.packId)
  if (!winnerTop) return null
  const result = await finalizeRaapPlan({
    manifest: winnerTop.manifest,
    confidence: resolved.winner.confidence,
    matchMethod: raap.matchMethod,
    isAmbiguous: false,
    gate: 'green'
  }, input, ctx)
  // P0-A：胜者被输入门控拒绝（file 模板无文件输入）→ 按未触发竞争处理，落回原消歧/下层
  if (result.kind !== 'plan' || !result.macroManifestId) return null

  const competition: CompetitionRecord = {
    winnerPackId: resolved.winner.packId,
    loserPackIds: resolved.losers.map(l => l.packId)
  }
  return { ...result, competition }
}

/** 旧 :848-956：L2 歧义黄门消歧四策略 */async function disambiguate(input: string, raap: RaapMatchResult, ctx: DefaultKernelContext): Promise<LayerResult> {
  // P0-A：先按输入门控过滤候选——file 模板无文件输入的候选不参与消歧
  const formInfo = detectInputForm(input)
  const cands = (raap.candidates || []).filter(c =>
    classifyTemplateInput(c.manifest, formInfo) !== 'reject'
  )
  if (cands.length === 0) return { kind: 'miss' }
  // 2026-10-01（用户裁定）：输入门控把**原 top1** 滤掉、且剩余候选分数明显低于它时，返回 miss/澄清。
  // 否则会"在剩下的里挑一个"——实测：一次**缺附件**的简历请求（top1=「简历初筛助手」conf 0.843，
  // 但它 inputType='file' 被门控 reject）被悄悄跑成了完全无关的「文档翻译英文版」计划，
  // 用户看不到任何提示。宁可返回 miss 交给上层澄清，也不要静默换成不相关的任务。
  // 2026-10-01（用户裁定）：**原 top1 被输入门控滤掉**（形态不匹配，如 file 类模板但本次无附件）
  // ⇒ 直接返回 miss，不要"在剩下的里挑一个"。实测：简历请求（top1「简历初筛助手」conf 0.843，
  // 但 inputType='file' 被门控 reject）被悄悄跑成「文档翻译英文版」（其 score 0.661 并不低，
  // 所以按分数阈值判"无关"不可靠）——形态不匹配才是判据。宁可 miss 交给上层澄清。
  const top1StillUsable = cands.some(c => c.manifest.identity.id === raap.manifest.identity.id)
  if (!top1StillUsable) {
    return { kind: 'miss' }
  }
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
      const singleManifest = cands[0].manifest
      const translated = await translateIntent(input, singleManifest, ctx.recentUserMsg)
      if (translated) {
        const slotSlots = singleManifest.execution.paramMapping?.slots || []
        const missingRequired = slotSlots.filter(s => s.required && !translated.params[s.name])
        if (missingRequired.length === 0) {
          return {
            kind: 'intent-confirm',
            intent: translated.intent,
            manifestId: singleManifest.identity.id,
            params: translated.params,
            originalInput: input
          }
        }
        return {
          kind: 'slot-fill',
          manifestId: singleManifest.identity.id,
          manifestName: singleManifest.identity.name,
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
  // P0-A：输入门控——file 模板无文件输入不进快配
  const gate = gateTemplateForInput(m, input)
  if (gate.action === 'reject') return { kind: 'miss' }
  let plan: TaskPlan
  if (m.execution.mode === 'direct' && m.execution.directCall) {
    plan = {
      intent: m.identity.name,
      needs: manifestPlanNeeds(m),
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
    const sourceSteps = gate.steps || m.execution.dagPlan.steps
    plan = {
      intent: m.identity.name,
      needs: manifestPlanNeeds(m),
      steps: sourceSteps.map(s => ({
        step: s.step, description: s.description, tool: s.tool,
        depends_on: s.depends_on, params: s.params as Record<string, string>, expectedOutput: s.expectedOutput
      }))
    }
  } else {
    plan = {
      intent: m.identity.name,
      needs: manifestPlanNeeds(m),
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
    // M16 竞争模式（flag 关闭时分支不存在，行为与原实现逐字节等价）：
    // 跨 pack 歧义候选先尝试竞争消解；未触发条件（同 pack / 单 pack / 胜者不可执行）→ 原四策略
    if (ctx.competitiveMode) {
      const competed = await competeAcrossPacks(input, raap, ctx)
      if (competed) return competed
    }
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
