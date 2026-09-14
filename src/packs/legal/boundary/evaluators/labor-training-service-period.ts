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
  if (!hasKeyword(text, ['培训', '培训费'])) return null
  if (!hasKeyword(text, ['违约金'])) return null
  const trainingMatch = text.match(/培训费[用为约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
  const penaltyMatch = text.match(/违约金[为约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
  if (trainingMatch && penaltyMatch) {
    const trainingVal = parseFloat(trainingMatch[1]) * (trainingMatch[2] === '万元' || trainingMatch[2] === '万' ? 10000 : 1)
    const penaltyVal = parseFloat(penaltyMatch[1]) * (penaltyMatch[2] === '万元' || penaltyMatch[2] === '万' ? 10000 : 1)
    if (penaltyVal > trainingVal) {
      return {
        triggered: true,
        constraintId: 'legal-labor-training-service-period',
        severity: 'error',
        message: `培训违约金${penaltyVal}元超过培训费用${trainingVal}元，超出部分无效（劳动合同法第22条）`,
        reliability: {
          confidence: 'high',
          source: makeLawSource('中华人民共和国劳动合同法', '第二十二条', '2008-01-01')
        },
        automationLevel: 'full',
        matchedEntities: findEntitiesByType(ctx.entities, 'amount')
      }
    }
  }
  return null
}
