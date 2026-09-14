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
  if (!hasKeyword(text, ['商标'])) return null
  if (hasKeyword(text, ['使用'])) {
    const hasRegistration = hasKeyword(text, ['注册', '申请注册', '已注册', '商标权'])
    if (!hasRegistration) {
      return {
        triggered: true,
        constraintId: 'legal-ip-trademark-registration',
        severity: 'info',
        message: '使用未注册商标不违法，但无法获得商标专用权保护，建议申请注册（商标法第4条）',
        reliability: {
          confidence: 'medium',
          source: makeLawSource('中华人民共和国商标法', '第四条', '2019-11-01')
        },
        automationLevel: 'semi',
        requiresHumanConfirmation: true,
        humanJudgmentPrompt: '提醒：使用未注册商标不违法，但无法获得商标专用权保护。是否需要申请注册？'
      }
    }
  }
  return null
}
