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
  if (!hasKeyword(text, ['解除合同', '解除协议'])) return null
  const hasNoNotice = hasKeyword(text, ['未通知', '未告知', '未送达', '未书面通知'])
  const hasNotice = hasKeyword(text, ['已通知', '已告知', '已送达', '已书面通知', '书面通知对方'])
  if (hasNoNotice || !hasNotice) {
    return {
      triggered: true,
      constraintId: 'legal-contract-termination-notice',
      severity: 'info',
      message: '解除合同应通知对方，合同自通知到达对方时解除（民法典第565条）',
      reliability: {
        confidence: 'medium',
        source: makeLawSource('中华人民共和国民法典', '第五百六十五条', '2021-01-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请人工审查：合同解除是否已通知对方？'
    }
  }
  return null
}
