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
  const hasContract = hasKeyword(text, ['合同金额', '合同总价'])
  const hasInvoice = hasKeyword(text, ['发票金额', '开票金额'])
  if (hasContract && hasInvoice) {
    const amounts = findEntitiesByType(ctx.entities, 'amount')
    if (amounts.length >= 2) {
      const vals = amounts.map(a => parseFloat(a.normalized)).filter(v => v > 0)
      if (vals.length >= 2) {
        const diff = Math.abs(vals[0] - vals[1])
        if (diff > 0.01) {
          return {
            triggered: true,
            constraintId: 'finance-invoice-amount-match',
            severity: 'warning',
            message: `合同金额与发票金额不一致（差${diff.toFixed(2)}元），请核实`,
            reliability: {
              confidence: 'medium',
              source: makeRegulationSource('中华人民共和国发票管理办法', '第二十一条', '2023-12-01'),
              caveat: '仅检查金额数值'
            },
            matchedEntities: amounts
          }
        }
      }
    }
  }
  return null
}
