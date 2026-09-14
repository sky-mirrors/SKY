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
  if (!hasKeyword(text, ['劳务派遣', '派遣人员', '派遣工'])) return null
  const pctMatch = text.match(/派遣[比例人员]*[约是为]?\s*(\d+(?:\.\d+)?)\s*%/)
  if (pctMatch) {
    const ratio = parseFloat(pctMatch[1])
    if (ratio > 10) {
      return {
        triggered: true,
        constraintId: 'legal-labor-dispatch-ratio',
        severity: 'warning',
        message: `劳务派遣用工比例${ratio}%超过10%法定上限（劳动合同法第66条、劳务派遣暂行规定第4条）`,
        reliability: {
          confidence: 'high',
          source: makeLawSource('中华人民共和国劳动合同法', '第六十六条', '2008-01-01'),
          caveat: '劳务派遣暂行规定明确比例为10%'
        },
        automationLevel: 'full',
        matchedEntities: findEntitiesByType(ctx.entities, 'percentage')
      }
    }
  }
  const amounts = findEntitiesByType(ctx.entities, 'amount')
  if (amounts.length >= 2) {
    const vals = amounts.map(a => parseFloat(a.normalized)).filter(v => v > 0)
    if (vals.length >= 2 && vals[0] > 0) {
      const ratio = vals[1] / vals[0] * 100
      if (ratio > 10) {
        return {
          triggered: true,
          constraintId: 'legal-labor-dispatch-ratio',
          severity: 'warning',
          message: `劳务派遣用工比例${ratio.toFixed(1)}%超过10%法定上限（劳动合同法第66条、劳务派遣暂行规定第4条）`,
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第六十六条', '2008-01-01'),
            caveat: '劳务派遣暂行规定明确比例为10%'
          },
          automationLevel: 'full',
          matchedEntities: amounts
        }
      }
    }
  }
  return null
}
