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
  const hasProbation = hasKeyword(text, ['试用期'])
  if (!hasProbation) return null

  const amounts = findEntitiesByType(ctx.entities, 'amount')
  const yearMatch = text.match(/(\d+)\s*年/)

  let contractYears = 0
  if (yearMatch) contractYears = parseInt(yearMatch[1], 10)
  else {
    const cnYearMatch = text.match(/(一|二|两|三|四|五|六|七|八|九|十|十一|十二)\s*年/)
    if (cnYearMatch) {
      const cnYearMap: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 }
      contractYears = cnYearMap[cnYearMatch[1]] || 0
    }
  }

  const probationMatch = text.match(/试用期[为\d个月一二三四五六七八九十]+/)
  if (!probationMatch) return null

  let probationMonths = 0
  const probationNumMatch = probationMatch[0].match(/(\d+)\s*个月/)
  if (probationNumMatch) probationMonths = parseInt(probationNumMatch[1], 10)
  else {
    const cnMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
    for (const [k, v] of Object.entries(cnMap)) {
      if (probationMatch[0].includes(k)) { probationMonths = v; break }
    }
  }

  if (probationMonths === 0) return null

  let maxProbation = 0
  if (contractYears >= 3) maxProbation = 6
  else if (contractYears >= 1) maxProbation = 2
  else if (contractYears > 0) maxProbation = 1
  else maxProbation = 0

  if (maxProbation > 0 && probationMonths > maxProbation) {
    return {
      triggered: true,
      constraintId: 'legal-labor-contract-probation-limit',
      severity: 'error',
      message: `${contractYears}年期限劳动合同试用期上限为${maxProbation}个月，当前约定${probationMonths}个月，超出法定上限（劳动合同法第19条）`,
      reliability: {
        confidence: 'high',
        source: makeLawSource('中华人民共和国劳动合同法', '第十九条', '2008-01-01')
      },
      matchedEntities: amounts
    }
  }
  return null
}
