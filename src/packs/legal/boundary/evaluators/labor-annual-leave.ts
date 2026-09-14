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
  if (!hasKeyword(text, ['年休假', '年假', '带薪休假'])) return null
  const yearMatch = text.match(/(?:累计)?工作[已满约]?\s*(\d+)\s*年/)
  const dayMatch = text.match(/年休假[为约]?\s*(\d+)\s*天/)
  if (!yearMatch || !dayMatch) return null
  const years = parseInt(yearMatch[1], 10)
  const days = parseInt(dayMatch[1], 10)
  let minDays = 0
  if (years >= 20) minDays = 15
  else if (years >= 10) minDays = 10
  else if (years >= 1) minDays = 5
  if (minDays > 0 && days < minDays) {
    return {
      triggered: true,
      constraintId: 'legal-labor-annual-leave',
      severity: 'warning',
      message: `工作${years}年法定年休假下限为${minDays}天，当前${days}天不符合规定（职工带薪年休假条例第3条）`,
      reliability: {
        confidence: 'high',
        source: makeLawSource('职工带薪年休假条例', '第三条', '2008-01-01')
      },
      automationLevel: 'full',
      matchedEntities: findEntitiesByType(ctx.entities, 'amount')
    }
  }
  return null
}
