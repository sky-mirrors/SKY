import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  selectRewriteStrategy,
  selectDisambigStrategy,
  extractStrategyContext,
  recordStrategyOutcome,
  getZOLState,
  resetZOL,
  countFinanceTerms,
} from '@/services/strategySelector'
import type { StrategyContext, RewriteStrategy, DisambigStrategy, ExtractedEntity, ConstraintResult, BudgetMode } from '@/models'
import { setBudgetMode, resetBudget } from '@/services/tokenBudget'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
    get length() { return Object.keys(store).length },
    key: (idx: number) => Object.keys(store)[idx] ?? null
  }
})()
vi.stubGlobal('localStorage', localStorageMock)

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    contentLength: 20,
    keywordCount: 3,
    initialMatchFailed: true,
    detectedDomain: 'general',
    lawArticleCount: 0,
    financeTermCount: 0,
    constraintHitCount: 0,
    candidateCount: 2,
    topScoreGap: 0.1,
    hasDomainSignalMatch: false,
    ...overrides,
  }
}

describe('strategySelector', () => {
  beforeEach(() => {
    localStorage.clear()
    resetZOL()
  })

  describe('selectRewriteStrategy', () => {
    it('returns none when match succeeded', () => {
      expect(selectRewriteStrategy(makeContext({ initialMatchFailed: false }))).toBe('none')
    })

    it('returns none when content is too short', () => {
      expect(selectRewriteStrategy(makeContext({ initialMatchFailed: true, contentLength: 5 }))).toBe('none')
    })

    it('returns keyword_extract when lawArticleCount >= 1', () => {
      expect(selectRewriteStrategy(makeContext({ lawArticleCount: 1 }))).toBe('keyword_extract')
    })

    it('returns keyword_extract when financeTermCount >= 2', () => {
      expect(selectRewriteStrategy(makeContext({ financeTermCount: 2 }))).toBe('keyword_extract')
    })

    it('returns keyword_extract when keywordCount >= 2', () => {
      expect(selectRewriteStrategy(makeContext({ keywordCount: 2 }))).toBe('keyword_extract')
    })

    it('returns none when no domain signals and no keywords', () => {
      expect(selectRewriteStrategy(makeContext({ keywordCount: 0, lawArticleCount: 0, financeTermCount: 0 }))).toBe('none')
    })

    it('returns none when keywordCount is 1 (below default threshold)', () => {
      expect(selectRewriteStrategy(makeContext({ keywordCount: 1, lawArticleCount: 0, financeTermCount: 0 }))).toBe('none')
    })

    it('never returns llm_rewrite or both', () => {
      const results: RewriteStrategy[] = []
      const contexts = [
        makeContext({ keywordCount: 5, lawArticleCount: 3, financeTermCount: 4 }),
        makeContext({ keywordCount: 0 }),
        makeContext({ contentLength: 2 }),
      ]
      for (const ctx of contexts) {
        results.push(selectRewriteStrategy(ctx))
      }
      expect(results.every(r => r === 'none' || r === 'keyword_extract')).toBe(true)
    })
  })

  describe('selectDisambigStrategy', () => {
    it('returns fallback_l1 when no candidates', () => {
      expect(selectDisambigStrategy(makeContext({ candidateCount: 0 }))).toBe('fallback_l1')
    })

    it('returns auto_pick for single candidate', () => {
      expect(selectDisambigStrategy(makeContext({ candidateCount: 1 }))).toBe('auto_pick')
    })

    it('returns auto_pick when high confidence gap + domain match', () => {
      expect(selectDisambigStrategy(makeContext({
        candidateCount: 3,
        topScoreGap: 0.20,
        hasDomainSignalMatch: true,
      }))).toBe('auto_pick')
    })

    it('returns show_candidates when medium confidence gap', () => {
      expect(selectDisambigStrategy(makeContext({
        candidateCount: 3,
        topScoreGap: 0.10,
        hasDomainSignalMatch: false,
      }))).toBe('show_candidates')
    })

    it('returns ask_clarify when many close candidates', () => {
      expect(selectDisambigStrategy(makeContext({
        candidateCount: 4,
        topScoreGap: 0.05,
        hasDomainSignalMatch: false,
      }))).toBe('ask_clarify')
    })

    it('returns show_candidates as default', () => {
      expect(selectDisambigStrategy(makeContext({
        candidateCount: 2,
        topScoreGap: 0.05,
        hasDomainSignalMatch: false,
      }))).toBe('show_candidates')
    })

    it('does not return auto_pick without domain match even with high gap', () => {
      expect(selectDisambigStrategy(makeContext({
        candidateCount: 3,
        topScoreGap: 0.20,
        hasDomainSignalMatch: false,
      }))).not.toBe('auto_pick')
    })

    it('never returns llm_pick', () => {
      const results: DisambigStrategy[] = []
      const contexts = [
        makeContext({ candidateCount: 0 }),
        makeContext({ candidateCount: 1 }),
        makeContext({ candidateCount: 5, topScoreGap: 0.01 }),
        makeContext({ candidateCount: 3, topScoreGap: 0.20, hasDomainSignalMatch: true }),
      ]
      for (const ctx of contexts) {
        results.push(selectDisambigStrategy(ctx))
      }
      expect(results.every(r => r !== 'llm_pick')).toBe(true)
    })
  })

  describe('countFinanceTerms', () => {
    it('counts matching financial terms', () => {
      expect(countFinanceTerms('增值税税率计算和折旧方法')).toBe(2)
    })

    it('returns 0 for no financial terms', () => {
      expect(countFinanceTerms('今天天气真好')).toBe(0)
    })

    it('counts English financial abbreviations', () => {
      expect(countFinanceTerms('ROI and EBITDA analysis')).toBe(2)
    })

    it('does not double-count overlapping terms', () => {
      expect(countFinanceTerms('增值税')).toBe(1)
    })
  })

  describe('extractStrategyContext', () => {
    it('extracts law_article count from entities', () => {
      const entities: ExtractedEntity[] = [
        { type: 'law_article', raw: '第714条', normalized: '714', linePos: 0 },
        { type: 'amount', raw: '100元', normalized: '100', linePos: 5 },
      ]
      const ctx = extractStrategyContext({
        content: '民法典第714条',
        entities,
        constraintResults: [],
        detectedDomain: 'legal',
        initialMatchFailed: true,
      })
      expect(ctx.lawArticleCount).toBe(1)
    })

    it('counts triggered constraints', () => {
      const constraintResults: ConstraintResult[] = [
        { constraintId: 'c1', triggered: true, severity: 'warning', message: 'm1', automationLevel: 'full' },
        { constraintId: 'c2', triggered: false, severity: 'info', message: 'm2', automationLevel: 'semi' },
      ]
      const ctx = extractStrategyContext({
        content: 'test',
        entities: [],
        constraintResults,
        detectedDomain: 'legal',
        initialMatchFailed: true,
      })
      expect(ctx.constraintHitCount).toBe(1)
    })

    it('computes topScoreGap from candidates', () => {
      const ctx = extractStrategyContext({
        content: 'test',
        entities: [],
        constraintResults: [],
        detectedDomain: 'general',
        initialMatchFailed: false,
        candidates: [
          { score: 0.9, targetRoles: ['legal'] },
          { score: 0.7, targetRoles: ['finance'] },
        ],
      })
      expect(ctx.topScoreGap).toBeCloseTo(0.2)
      expect(ctx.candidateCount).toBe(2)
    })

    it('detects domain signal match', () => {
      const ctx = extractStrategyContext({
        content: 'test',
        entities: [],
        constraintResults: [],
        detectedDomain: 'legal',
        initialMatchFailed: false,
        candidates: [
          { score: 0.9, targetRoles: ['legal', 'finance'] },
        ],
      })
      expect(ctx.hasDomainSignalMatch).toBe(true)
    })

    it('returns false for no domain signal match', () => {
      const ctx = extractStrategyContext({
        content: 'test',
        entities: [],
        constraintResults: [],
        detectedDomain: 'hr',
        initialMatchFailed: false,
        candidates: [
          { score: 0.9, targetRoles: ['legal', 'finance'] },
        ],
      })
      expect(ctx.hasDomainSignalMatch).toBe(false)
    })

    it('detects finance terms in content', () => {
      const ctx = extractStrategyContext({
        content: '增值税折旧计算',
        entities: [],
        constraintResults: [],
        detectedDomain: 'finance',
        initialMatchFailed: true,
      })
      expect(ctx.financeTermCount).toBe(2)
    })
  })

  describe('ZOL outcome recording + adaptation', () => {
    it('records outcomes to the correct learner', () => {
      recordStrategyOutcome({
        strategyType: 'rewrite',
        strategy: 'keyword_extract',
        outcome: 'success',
        contextSnapshot: { lawArticleCount: 1 },
      })
      const state = getZOLState()
      expect(state.rewrite.outcomeCount).toBe(1)
      expect(state.disambig.outcomeCount).toBe(0)
    })

    it('no cross-contamination between rewrite and disambig', () => {
      recordStrategyOutcome({
        strategyType: 'rewrite',
        strategy: 'keyword_extract',
        outcome: 'success',
        contextSnapshot: {},
      })
      recordStrategyOutcome({
        strategyType: 'disambig',
        strategy: 'show_candidates',
        outcome: 'failure',
        contextSnapshot: {},
      })
      const state = getZOLState()
      expect(state.rewrite.recentSuccessRate).toBe(1.0)
      expect(state.disambig.recentSuccessRate).toBe(0.0)
    })

    it('getZOLState returns both learners', () => {
      const state = getZOLState()
      expect(state.rewrite).toBeDefined()
      expect(state.disambig).toBeDefined()
      expect(state.rewrite.thresholds).toBeDefined()
      expect(state.disambig.thresholds).toBeDefined()
    })

    it('resetZOL clears both learners', () => {
      recordStrategyOutcome({
        strategyType: 'rewrite',
        strategy: 'keyword_extract',
        outcome: 'success',
        contextSnapshot: {},
      })
      resetZOL()
      const state = getZOLState()
      expect(state.rewrite.outcomeCount).toBe(0)
      expect(state.disambig.outcomeCount).toBe(0)
    })
  })

  describe('progressive disambiguation integration', () => {
    it('legal query with clear top candidate → auto_pick', () => {
      const ctx = makeContext({
        detectedDomain: 'legal',
        candidateCount: 2,
        topScoreGap: 0.20,
        hasDomainSignalMatch: true,
      })
      expect(selectDisambigStrategy(ctx)).toBe('auto_pick')
    })

    it('legal query with close scores → show_candidates', () => {
      const ctx = makeContext({
        detectedDomain: 'legal',
        candidateCount: 2,
        topScoreGap: 0.08,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctx)).toBe('show_candidates')
    })

    it('ambiguous multi-domain query → ask_clarify', () => {
      const ctx = makeContext({
        detectedDomain: 'general',
        candidateCount: 4,
        topScoreGap: 0.03,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctx)).toBe('ask_clarify')
    })
  })

  describe('domain bias offsets', () => {
    beforeEach(() => { resetZOL() })

    it('legal domain: 1 law article triggers keyword_extract (offset lowers threshold from 1 to 0)', () => {
      const ctx = makeContext({
        detectedDomain: 'legal',
        lawArticleCount: 0,
        contentLength: 6,
      })
      expect(selectRewriteStrategy(ctx)).toBe('keyword_extract')
    })

    it('general domain: 0 law articles does NOT trigger keyword_extract', () => {
      const ctx = makeContext({
        detectedDomain: 'general',
        lawArticleCount: 0,
        contentLength: 6,
      })
      expect(selectRewriteStrategy(ctx)).toBe('none')
    })

    it('legal domain: shorter content (6 chars) still triggers rewrite (offset -2 from 8)', () => {
      const ctx = makeContext({
        detectedDomain: 'legal',
        contentLength: 6,
        lawArticleCount: 1,
        keywordCount: 0,
        financeTermCount: 0,
      })
      expect(selectRewriteStrategy(ctx)).toBe('keyword_extract')
    })

    it('finance domain: 1 finance term triggers keyword_extract (offset lowers threshold from 2 to 1)', () => {
      const ctx = makeContext({
        detectedDomain: 'finance',
        financeTermCount: 1,
        lawArticleCount: 0,
        keywordCount: 0,
      })
      expect(selectRewriteStrategy(ctx)).toBe('keyword_extract')
    })

    it('general domain: 1 finance term does NOT trigger keyword_extract (threshold is 2)', () => {
      const ctx = makeContext({
        detectedDomain: 'general',
        financeTermCount: 1,
        lawArticleCount: 0,
        keywordCount: 0,
      })
      expect(selectRewriteStrategy(ctx)).toBe('none')
    })

    it('hr domain: content length 5 triggers rewrite (offset -3 from 8)', () => {
      const ctx = makeContext({
        detectedDomain: 'hr',
        contentLength: 5,
        keywordCount: 3,
        lawArticleCount: 0,
        financeTermCount: 0,
      })
      expect(selectRewriteStrategy(ctx)).toBe('keyword_extract')
    })

    it('general domain: content length 5 does NOT trigger rewrite (threshold is 8)', () => {
      const ctx = makeContext({
        detectedDomain: 'general',
        contentLength: 5,
        keywordCount: 3,
        lawArticleCount: 0,
        financeTermCount: 0,
      })
      expect(selectRewriteStrategy(ctx)).toBe('none')
    })

    it('legal disambig: lower highConfidenceGap allows auto_pick with smaller gap', () => {
      const ctxLegal = makeContext({
        detectedDomain: 'legal',
        candidateCount: 3,
        topScoreGap: 0.12,
        hasDomainSignalMatch: true,
      })
      const ctxGeneral = makeContext({
        detectedDomain: 'general',
        candidateCount: 3,
        topScoreGap: 0.12,
        hasDomainSignalMatch: true,
      })
      expect(selectDisambigStrategy(ctxLegal)).toBe('auto_pick')
      expect(selectDisambigStrategy(ctxGeneral)).toBe('show_candidates')
    })

    it('hr disambig: lower lowConfidenceCandidateCount triggers ask_clarify with fewer candidates', () => {
      const ctxHr = makeContext({
        detectedDomain: 'hr',
        candidateCount: 2,
        topScoreGap: 0.03,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctxHr)).toBe('ask_clarify')
    })

    it('finance disambig: lower lowConfidenceScoreGap triggers ask_clarify more easily', () => {
      const ctxFinance = makeContext({
        detectedDomain: 'finance',
        candidateCount: 3,
        topScoreGap: 0.07,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctxFinance)).toBe('ask_clarify')
    })
  })

  describe('budget mode integration', () => {
    beforeEach(() => {
      resetBudget()
      resetZOL()
    })

    it('zero mode forces keyword_extract regardless of context', () => {
      const ctx = makeContext({ initialMatchFailed: false, contentLength: 1, keywordCount: 0 })
      expect(selectRewriteStrategy(ctx, 'zero')).toBe('keyword_extract')
    })

    it('zero mode forces auto_pick for disambig', () => {
      const ctx = makeContext({ candidateCount: 5, topScoreGap: 0.01, hasDomainSignalMatch: false })
      expect(selectDisambigStrategy(ctx, 'zero')).toBe('auto_pick')
    })

    it('economy mode blocks ask_clarify, falls back to show_candidates', () => {
      const ctx = makeContext({
        candidateCount: 5,
        topScoreGap: 0.03,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctx, 'economy')).toBe('show_candidates')
    })

    it('standard mode allows ask_clarify normally', () => {
      const ctx = makeContext({
        candidateCount: 5,
        topScoreGap: 0.03,
        hasDomainSignalMatch: false,
      })
      expect(selectDisambigStrategy(ctx, 'standard')).toBe('ask_clarify')
    })

    it('budgetMode param overrides global getBudgetMode', () => {
      setBudgetMode('standard')
      const ctx = makeContext({ initialMatchFailed: false, contentLength: 1 })
      expect(selectRewriteStrategy(ctx, 'zero')).toBe('keyword_extract')
    })
  })
})
