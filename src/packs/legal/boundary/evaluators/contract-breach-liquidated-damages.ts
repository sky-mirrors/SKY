import type {
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintSource,
  ExtractedEntity
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

function findEntitiesByType(entities: ExtractedEntity[], type: string): ExtractedEntity[] {
  return entities.filter(e => e.type === type)
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

export const check = (ctx: ConstraintCheckContext): ConstraintResult | null => {
  const text = ctx.sourceText + ' ' + ctx.outputText
  if (!hasKeyword(text, ['违约金'])) return null
  const contractMatch = text.match(/(?:合同金额|总金额|合同总价)[为是约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
  const penaltyMatch = text.match(/违约金[为是约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
  if (contractMatch && penaltyMatch) {
    const contractVal = parseFloat(contractMatch[1]) * (contractMatch[2] === '万元' || contractMatch[2] === '万' ? 10000 : 1)
    const penaltyVal = parseFloat(penaltyMatch[1]) * (penaltyMatch[2] === '万元' || penaltyMatch[2] === '万' ? 10000 : 1)
    if (contractVal > 0 && penaltyVal / contractVal > 0.3) {
      return {
        triggered: true,
        constraintId: 'legal-contract-breach-liquidated-damages',
        severity: 'warning',
        message: `违约金(${penaltyVal}元)占合同金额(${contractVal}元)的${(penaltyVal / contractVal * 100).toFixed(1)}%，可能过高（民法典第585条，司法实践一般不超过30%）`,
        reliability: {
          confidence: 'medium',
          source: makeLawSource('中华人民共和国民法典', '第五百八十五条', '2021-01-01'),
          caveat: '30%上限为司法实践参考'
        },
        matchedEntities: findEntitiesByType(ctx.entities, 'amount')
      }
    }
  }
  return null
}
