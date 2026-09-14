import type {
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintSource,
  ExtractedEntity
} from '@/models'

function makeRegulationSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'regulation',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function findEntitiesByType(entities: ExtractedEntity[], type: string): ExtractedEntity[] {
  return entities.filter(e => e.type === type)
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

export const check = (ctx: ConstraintCheckContext): ConstraintResult | null => {
  const text = ctx.sourceText + ' ' + ctx.outputText
  if (!hasKeyword(text, ['转账', '汇款', '支付'])) return null
  const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
  if (amountMatch) {
    const num = parseFloat(amountMatch[1])
    const unit = amountMatch[2]
    const val = num * (unit === '万元' || unit === '万' ? 10000 : 1)
    if (val >= 500000) {
      return {
        triggered: true,
        constraintId: 'finance-large-transaction-flag',
        severity: 'warning',
        message: `单笔${amountMatch[0]}达到大额交易报告标准（50万元以上），需按规定报告`,
        reliability: {
          confidence: 'high',
          source: makeRegulationSource('金融机构大额交易和可疑交易报告管理办法', '第五条', '2022-07-01')
        },
        matchedEntities: findEntitiesByType(ctx.entities, 'amount')
      }
    }
  }
  return null
}
