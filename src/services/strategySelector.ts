import { ZeroTokenLearner, type ZOLAdjustFn, type ZOLState } from './zeroTokenLearning'
import type { StrategyContext, RewriteStrategy, DisambigStrategy, ExtractedEntity, ConstraintResult, DetectedDomain, DomainRewriteOffsets, DomainDisambigOffsets, BudgetMode } from '@/models'
import { getBudgetMode } from './tokenBudget'

// ── Rewrite Thresholds ──────────────────────────────────────────

interface RewriteThresholds {
  [key: string]: number
  minContentLength: number
  minKeywordCount: number
  minLawArticleCount: number
  minFinanceTermCount: number
}

const DEFAULT_REWRITE: RewriteThresholds = {
  minContentLength: 8,
  minKeywordCount: 2,
  minLawArticleCount: 1,
  minFinanceTermCount: 2,
}

const adjustRewrite: ZOLAdjustFn<RewriteThresholds> = (thresholds, successRate, _defaults, config) => {
  const step = config.adjustStep
  if (successRate < 0.70) {
    for (const key of Object.keys(thresholds) as (keyof RewriteThresholds)[]) {
      thresholds[key] = thresholds[key] * (1 - step)
    }
  } else if (successRate > 0.90) {
    for (const key of Object.keys(thresholds) as (keyof RewriteThresholds)[]) {
      thresholds[key] = thresholds[key] * (1 + step)
    }
  }
}

// ── Disambig Thresholds ─────────────────────────────────────────

interface DisambigThresholds {
  [key: string]: number
  highConfidenceGap: number
  mediumConfidenceGap: number
  lowConfidenceCandidateCount: number
  lowConfidenceScoreGap: number
}

const DEFAULT_DISAMBIG: DisambigThresholds = {
  highConfidenceGap: 0.15,
  mediumConfidenceGap: 0.08,
  lowConfidenceCandidateCount: 3,
  lowConfidenceScoreGap: 0.10,
}

const adjustDisambig: ZOLAdjustFn<DisambigThresholds> = (thresholds, successRate, _defaults, config) => {
  const step = config.adjustStep
  if (successRate < 0.70) {
    thresholds.highConfidenceGap *= (1 - step)
    thresholds.mediumConfidenceGap *= (1 - step)
    thresholds.lowConfidenceCandidateCount *= (1 + step)
    thresholds.lowConfidenceScoreGap *= (1 - step)
  } else if (successRate > 0.90) {
    thresholds.highConfidenceGap *= (1 + step)
    thresholds.mediumConfidenceGap *= (1 + step)
    thresholds.lowConfidenceCandidateCount *= (1 - step)
    thresholds.lowConfidenceScoreGap *= (1 + step)
  }
}

// ── ZOL Instances ───────────────────────────────────────────────

const rewriteLearner = new ZeroTokenLearner<RewriteThresholds>({
  decisionPoint: 'rewrite_strategy',
  defaultThresholds: DEFAULT_REWRITE,
  adjustFn: adjustRewrite,
  storageKey: 'holo-zol-rewrite',
  migrationKeys: [],
})

const disambigLearner = new ZeroTokenLearner<DisambigThresholds>({
  decisionPoint: 'disambig_strategy',
  defaultThresholds: DEFAULT_DISAMBIG,
  adjustFn: adjustDisambig,
  storageKey: 'holo-zol-disambig',
})

/** 2026-10-07：与 smartRouter 同因——补加载两个 learner 的持久化状态。
 *  ZeroTokenLearner.initFromVault() 此前全库无人调用（死代码），构造期 vault.readCache 冷 ⇒ 每次启动都从零开始。 */
export async function initStrategySelector(): Promise<void> {
  await Promise.all([rewriteLearner.initFromVault(), disambigLearner.initFromVault()])
}

// ── Domain Bias Offsets ─────────────────────────────────────────

const DOMAIN_REWRITE_OFFSETS: Record<string, Partial<DomainRewriteOffsets>> = {
  legal:   { minLawArticleCount: -1, minContentLength: -2 },
  finance: { minFinanceTermCount: -1, minContentLength: -1 },
  hr:      { minContentLength: -3 },
}

const DOMAIN_DISAMBIG_OFFSETS: Record<string, Partial<DomainDisambigOffsets>> = {
  legal:   { highConfidenceGap: -0.03 },
  finance: { lowConfidenceScoreGap: -0.02 },
  hr:      { lowConfidenceCandidateCount: -1 },
}

function applyRewriteOffsets(t: Readonly<RewriteThresholds>, domain: DetectedDomain): RewriteThresholds {
  const offsets = DOMAIN_REWRITE_OFFSETS[domain] || {}
  return {
    minContentLength:    t.minContentLength    + (offsets.minContentLength    ?? 0),
    minKeywordCount:     t.minKeywordCount     + (offsets.minKeywordCount     ?? 0),
    minLawArticleCount:  t.minLawArticleCount  + (offsets.minLawArticleCount  ?? 0),
    minFinanceTermCount: t.minFinanceTermCount + (offsets.minFinanceTermCount ?? 0),
  }
}

function applyDisambigOffsets(t: Readonly<DisambigThresholds>, domain: DetectedDomain): DisambigThresholds {
  const offsets = DOMAIN_DISAMBIG_OFFSETS[domain] || {}
  return {
    highConfidenceGap:          t.highConfidenceGap          + (offsets.highConfidenceGap          ?? 0),
    mediumConfidenceGap:        t.mediumConfidenceGap        + (offsets.mediumConfidenceGap        ?? 0),
    lowConfidenceCandidateCount: t.lowConfidenceCandidateCount + (offsets.lowConfidenceCandidateCount ?? 0),
    lowConfidenceScoreGap:      t.lowConfidenceScoreGap      + (offsets.lowConfidenceScoreGap      ?? 0),
  }
}

// ── Financial Term Detection ────────────────────────────────────

const FINANCE_TERMS: readonly string[] = [
  '增值税', '折旧', '摊销', '资产负债', '现金流量', '利润表',
  '应收账款', '应付账款', '坏账准备', '存货', '营业收入',
  '净利润', '毛利率', '净利率', 'ROE', 'ROI', 'EBITDA',
  '折现率', '净现值', '内含报酬率', '审计', '内控',
]

export function countFinanceTerms(text: string): number {
  let count = 0
  for (const term of FINANCE_TERMS) {
    if (text.includes(term)) count++
  }
  return count
}

// ── Strategy Selection ──────────────────────────────────────────

export function selectRewriteStrategy(ctx: StrategyContext, budgetMode?: BudgetMode): RewriteStrategy {
  const mode = budgetMode ?? getBudgetMode()
  if (mode === 'zero') return 'keyword_extract'

  const t = applyRewriteOffsets(rewriteLearner.getThresholds(), ctx.detectedDomain)
  if (!ctx.initialMatchFailed) return 'none'
  if (ctx.contentLength < t.minContentLength) return 'none'

  if (ctx.lawArticleCount >= t.minLawArticleCount) return 'keyword_extract'
  if (ctx.financeTermCount >= t.minFinanceTermCount) return 'keyword_extract'
  if (ctx.keywordCount >= t.minKeywordCount) return 'keyword_extract'

  return 'none'
}

export function selectDisambigStrategy(ctx: StrategyContext, budgetMode?: BudgetMode): DisambigStrategy {
  const mode = budgetMode ?? getBudgetMode()
  if (mode === 'zero') return 'auto_pick'

  const t = applyDisambigOffsets(disambigLearner.getThresholds(), ctx.detectedDomain)

  if (ctx.candidateCount === 0) return 'fallback_l1'

  if (ctx.candidateCount === 1) return 'auto_pick'
  if (ctx.topScoreGap >= t.highConfidenceGap && ctx.hasDomainSignalMatch) return 'auto_pick'

  if (ctx.topScoreGap >= t.mediumConfidenceGap) return 'show_candidates'

  if (mode === 'economy') return 'show_candidates'

  if (ctx.candidateCount >= t.lowConfidenceCandidateCount
      && ctx.topScoreGap < t.lowConfidenceScoreGap) return 'ask_clarify'

  return 'show_candidates'
}

// ── Context Extraction ──────────────────────────────────────────

export function extractStrategyContext(params: {
  content: string
  entities: ExtractedEntity[]
  constraintResults: ConstraintResult[]
  detectedDomain: DetectedDomain
  initialMatchFailed: boolean
  keywordCount?: number
  candidates?: Array<{ score: number; targetRoles?: string[] }>
}): StrategyContext {
  const { content, entities, constraintResults, detectedDomain, initialMatchFailed } = params
  const candidates = [...(params.candidates ?? [])].sort((a, b) => b.score - a.score)
  const topScoreGap = candidates.length >= 2 ? candidates[0].score - candidates[1].score : 0
  const topRoles: string[] = candidates[0]?.targetRoles ?? []
  const hasDomainSignalMatch = topRoles.includes(detectedDomain)

  return {
    contentLength: content.length,
    keywordCount: params.keywordCount ?? 0,
    initialMatchFailed,
    detectedDomain,
    lawArticleCount: entities.filter(e => e.type === 'law_article').length,
    financeTermCount: countFinanceTerms(content),
    constraintHitCount: constraintResults.filter(r => r.triggered).length,
    candidateCount: params.candidates?.length ?? 0,
    topScoreGap,
    hasDomainSignalMatch,
  }
}

// ── Outcome Recording ───────────────────────────────────────────

export function recordStrategyOutcome(params: {
  strategyType: 'rewrite' | 'disambig'
  strategy: string
  outcome: 'success' | 'failure'
  contextSnapshot: Record<string, number>
}): void {
  const learner = params.strategyType === 'rewrite' ? rewriteLearner : disambigLearner
  learner.recordOutcome(params.strategy, params.outcome, params.contextSnapshot)
}

// ── State Access ────────────────────────────────────────────────

export function getZOLState(): {
  rewrite: ZOLState<RewriteThresholds>
  disambig: ZOLState<DisambigThresholds>
} {
  return {
    rewrite: rewriteLearner.getState(),
    disambig: disambigLearner.getState(),
  }
}

export function resetZOL(): void {
  rewriteLearner.reset()
  disambigLearner.reset()
}

export { DOMAIN_REWRITE_OFFSETS, DOMAIN_DISAMBIG_OFFSETS }
