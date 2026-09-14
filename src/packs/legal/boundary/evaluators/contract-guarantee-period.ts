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
  if (!hasKeyword(text, ['保证', '担保'])) return null
  const hasPeriodMention = hasKeyword(text, ['保证期间', '担保期限', '保证期限'])
  const hasNoPeriod = hasKeyword(text, ['未约定', '未约定保证', '没有约定', '未规定'])
  const hasExplicitPeriod = hasKeyword(text, ['保证期间为', '担保期限为', '保证期限为', '届满之日起', '保证期至'])
  if (hasNoPeriod || (!hasExplicitPeriod && !hasPeriodMention)) {
    return {
      triggered: true,
      constraintId: 'legal-contract-guarantee-period',
      severity: 'info',
      message: '未约定保证期间，依法默认为主债务履行期届满之日起6个月（民法典第692条）',
      reliability: {
        confidence: 'high',
        source: makeLawSource('中华人民共和国民法典', '第六百九十二条', '2021-01-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请确认：是否约定了保证期间？未约定则默认6个月'
    }
  }
  return null
}
