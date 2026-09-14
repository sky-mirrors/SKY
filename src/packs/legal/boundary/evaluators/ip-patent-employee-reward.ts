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
  if (!hasKeyword(text, ['职务发明', '发明创造'])) return null
  const hasNoReward = hasKeyword(text, ['未约定奖励', '未约定报酬', '未给予奖励', '未支付报酬', '未约定发明人奖励'])
  const hasReward = hasKeyword(text, ['给予奖励', '支付报酬', '约定奖励', '给予发明人奖励'])
  if (hasNoReward || !hasReward) {
    return {
      triggered: true,
      constraintId: 'legal-ip-patent-employee-reward',
      severity: 'info',
      message: '职务发明创造应给予发明人奖励和报酬（专利法第15条）',
      reliability: {
        confidence: 'high',
        source: makeLawSource('中华人民共和国专利法', '第十五条', '2021-06-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请确认：职务发明是否约定了发明人奖励？'
    }
  }
  return null
}
