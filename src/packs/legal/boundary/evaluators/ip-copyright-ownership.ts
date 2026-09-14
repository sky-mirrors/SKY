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
  if (!hasKeyword(text, ['著作权', '版权'])) return null
  if (hasKeyword(text, ['归属', '所有']) && hasKeyword(text, ['公司', '单位', '组织', '机构'])) {
    const hasAuthor = hasKeyword(text, ['作者', '创作者'])
    if (!hasAuthor) {
      return {
        triggered: true,
        constraintId: 'legal-ip-copyright-ownership',
        severity: 'info',
        message: '著作权归属约定可能排除了实际创作者的权利，请审查（著作权法第11条）',
        reliability: {
          confidence: 'medium',
          source: makeLawSource('中华人民共和国著作权法', '第十一条', '2021-06-01')
        },
        automationLevel: 'semi',
        requiresHumanConfirmation: true,
        humanJudgmentPrompt: '请人工审查：著作权归属约定是否排除了实际创作者的权利？'
      }
    }
  }
  return null
}
