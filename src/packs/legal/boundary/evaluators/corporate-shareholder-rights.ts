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
  if (!hasKeyword(text, ['股东会决议', '董事会决议'])) return null
  const hasProceduralIssue = hasKeyword(text, ['未经法定程序', '程序违法', '未经表决', '违规表决', '召集程序违法', '未通知股东'])
  const hasCompliant = hasKeyword(text, ['合法程序', '依法表决', '经合法程序', '表决通过', '依法召开'])
  if (hasProceduralIssue || !hasCompliant) {
    return {
      triggered: true,
      constraintId: 'legal-corporate-shareholder-rights',
      severity: 'info',
      message: '股东会决议程序应合规，违规决议股东有权请求撤销（公司法第22条）',
      reliability: {
        confidence: 'medium',
        source: makeLawSource('中华人民共和国公司法', '第二十二条', '2024-07-01')
      },
      automationLevel: 'semi',
      requiresHumanConfirmation: true,
      humanJudgmentPrompt: '请人工审查：股东会决议程序是否合规？股东是否有权请求撤销？'
    }
  }
  return null
}
