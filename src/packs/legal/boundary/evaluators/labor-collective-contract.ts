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
  if (!hasKeyword(text, ['集体合同'])) return null
  const hasPassed = hasKeyword(text, ['讨论通过', '审议通过', '表决通过'])
  const hasNegative = hasKeyword(text, ['未经', '未提交', '未讨论', '未审议', '未经过'])
  if (hasNegative || !hasPassed) {
    return {
      triggered: true,
      constraintId: 'legal-labor-collective-contract',
      severity: 'info',
      message: '集体合同草案应提交职工代表大会或全体职工讨论通过（劳动合同法第51条）',
      reliability: {
        confidence: 'high',
        source: makeLawSource('中华人民共和国劳动合同法', '第五十一条', '2008-01-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请确认：集体合同是否经职工代表大会讨论通过？'
    }
  }
  return null
}
