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
  if (!hasKeyword(text, ['格式条款', '标准合同', '格式合同'])) return null
  if (hasKeyword(text, ['免责', '减轻'])) {
    const hasNegative = hasKeyword(text, ['未提示', '未说明', '未加粗', '未标红', '未提醒', '未标注'])
    const hasAffirmative = hasKeyword(text, ['已提示', '已说明', '已加粗', '已标红', '已确认', '经对方确认'])
    if (hasNegative || !hasAffirmative) {
      return {
        triggered: true,
        constraintId: 'legal-contract-standard-clause',
        severity: 'info',
        message: '格式条款中免责/减轻责任条款应采取合理方式提示说明（民法典第496条）',
        reliability: {
          confidence: 'high',
          source: makeLawSource('中华人民共和国民法典', '第四百九十六条', '2021-01-01')
        },
        automationLevel: 'semi',
        requiresHumanConfirmation: true,
        humanJudgmentPrompt: '请确认：格式条款中是否有免责条款的提示说明？'
      }
    }
  }
  return null
}
