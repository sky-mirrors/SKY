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
  if (!hasKeyword(text, ['法院', '人民法院'])) return null
  if (!hasKeyword(text, ['诉讼时效'])) return null
  if (!hasKeyword(text, ['认定', '裁定', '驳回'])) return null
  if (hasKeyword(text, ['过期', '已过', '届满'])) {
    const hasDefendant = hasKeyword(text, ['被告', '抗辩', '主张'])
    if (!hasDefendant) {
      return {
        triggered: true,
        constraintId: 'legal-dispute-limitation-check',
        severity: 'info',
        message: '人民法院不得主动适用诉讼时效，应由被告提出抗辩（民法典第193条）',
        reliability: {
          confidence: 'high',
          source: makeLawSource('中华人民共和国民法典', '第一百九十三条', '2021-01-01')
        },
        automationLevel: 'semi',
        requiresHumanConfirmation: true,
        humanJudgmentPrompt: '请确认：诉讼时效是否由被告主动提出抗辩？'
      }
    }
  }
  return null
}
