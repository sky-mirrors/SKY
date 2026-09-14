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
  if (!hasKeyword(text, ['仲裁'])) return null
  const hasAgreement = hasKeyword(text, ['仲裁协议', '仲裁条款', '仲裁机构', '仲裁委员会'])
  if (!hasAgreement) {
    return {
      triggered: true,
      constraintId: 'legal-dispute-arbitration-agreement',
      severity: 'info',
      message: '仲裁需有明确仲裁协议，请确认仲裁机构约定是否明确（仲裁法第4条）',
      reliability: {
        confidence: 'medium',
        source: makeLawSource('中华人民共和国仲裁法', '第四条', '1995-09-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '提醒：合同中的仲裁条款即为仲裁协议。请确认仲裁机构约定是否明确'
    }
  }
  return null
}
