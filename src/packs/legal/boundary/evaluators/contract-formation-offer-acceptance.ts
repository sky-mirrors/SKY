import type {
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintSource
} from '@/models'

function makeLawSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'law',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

export const check = (ctx: ConstraintCheckContext): ConstraintResult | null => {
  const text = ctx.sourceText + ' ' + ctx.outputText
  if (!hasKeyword(text, ['要约'])) return null
  const hasNoKeyTerms = hasKeyword(text, ['未约定价格', '未约定数量', '缺少价格', '缺少数量', '未约定金额', '缺少金额'])
  const hasKeyTerms = hasKeyword(text, ['单价', '总价', '价格为', '金额为', '数量为'])
  if (hasNoKeyTerms || !hasKeyTerms) {
    return {
      triggered: true,
      constraintId: 'legal-contract-formation-offer-acceptance',
      severity: 'info',
      message: '要约内容应具体确定，缺少价格/金额/数量等关键要素（民法典第472条）',
      reliability: {
        confidence: 'medium',
        source: makeLawSource('中华人民共和国民法典', '第四百七十二条', '2021-01-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请人工审查：要约内容是否具体确定？'
    }
  }
  return null
}
