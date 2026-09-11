import type {
  FactEntityType,
  ExtractedEntity,
  LawArticleEntity,
  ChineseNumberEntity,
  CompanyNameEntity
} from '@/models'

const AMOUNT_REGEX = /(￥|¥|\$|USD\s?|CNY\s?)?\d{1,3}(,\d{3})+(\.\d{1,2})?(元|美元|万元|万|块)?|(￥|¥|\$|USD\s?|CNY\s?)?\d+(\.\d{1,2})?(元|美元|万元|万|块)/g
const DATE_REGEX = /\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}|\d{4}年\d{1,2}月(\d{1,2}日?)?/g
const PERCENTAGE_REGEX = /\d+(\.\d+)?%/g
const CONTRACT_ID_REGEX = /[A-Za-z]{1,4}[-–—]?\d{4}[-–—]?\d{3,}/g
const PERSON_NAME_REGEX = /[\u4e00-\u9fa5]{2,4}(总|经理|先生|女士|主任|总监|主管|工程师|老师)/g

const CHINESE_NUM_MAP: Record<string, number> = {
  '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000,
  '两': 2, '廿': 20, '卅': 30
}

const CHINESE_AMOUNT_REGEX = /[一二三四五六七八九十百千万亿两零〇]{2,}(元|万|亿元|万元|块|美元|港币|英镑|欧元|日元)/g
const LAW_ARTICLE_REGEX = /第[一二三四五六七八九十百千万零〇\d]+条(?:第[一二三四五六七八九十百千万零〇\d]+款)?(?:第[一二三四五六七八九十百千万零〇\d]+项)?/g
const COMPANY_NAME_REGEX = /[\u4e00-\u9fa5]{2,10}(有限责任公司|股份有限公司|集团有限公司|有限公司|公司|合伙企业|事务所|研究院|中心)/g
const BANK_ACCOUNT_REGEX = /[\d\s\-]{10,30}/g
const ID_CARD_REGEX = /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g

const CONTEXTUAL_NAME_PATTERNS = [
  /甲方[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /乙方[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /丙方[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /法定代表人[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /委托代理人[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /授权代表[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /负责人[：:]\s*([\u4e00-\u9fa5]{2,4})/g,
  /联系人[：:]\s*([\u4e00-\u9fa5]{2,4})/g
]

const PERSON_SUFFIXES = ['总', '经理', '先生', '女士', '主任', '总监', '主管', '工程师', '老师']

function normalizeAmount(raw: string): string {
  const cleaned = raw.replace(/[￥¥$USD\sCNY元美元万元万块,，]/g, '')
  const num = parseFloat(cleaned)
  if (isNaN(num)) return ''
  return num.toFixed(2)
}

function normalizeDate(raw: string): string {
  const cnMatch = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})/)
  if (cnMatch) {
    const y = cnMatch[1]
    const m = cnMatch[2].padStart(2, '0')
    const d = cnMatch[3] ? cnMatch[3].padStart(2, '0') : '01'
    return `${y}-${m}-${d}`
  }
  const slashMatch = raw.match(/(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/)
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`
  }
  return raw
}

function normalizePercentage(raw: string): string {
  return parseFloat(raw.replace('%', '')).toFixed(2)
}

function normalizePersonName(raw: string): string {
  let name = raw
  for (const suffix of PERSON_SUFFIXES) {
    name = name.replace(suffix, '')
  }
  return name
}

function parseChineseNumber(cn: string): number {
  let result = 0
  let section = 0
  let digit = 0

  for (let i = 0; i < cn.length; i++) {
    const ch = cn[i]
    const val = CHINESE_NUM_MAP[ch]
    if (val === undefined) continue

    if (val >= 100000000) {
      section = section + digit
      result = (result + section) * val
      section = 0
      digit = 0
    } else if (val === 10000) {
      section = section + digit
      result = result + section * val
      section = 0
      digit = 0
    } else if (val >= 10) {
      if (digit === 0) {
        section = section + val
      } else {
        section = section + digit * val
      }
      digit = 0
    } else {
      digit = val
    }
  }

  return result + section + digit
}

function parseChineseAmount(raw: string): { normalized: string; numericValue: number } {
  const suffixMatch = raw.match(/(元|万|亿元|万元|块|美元|港币|英镑|欧元|日元)$/)
  if (!suffixMatch) return { normalized: '', numericValue: 0 }

  const suffix = suffixMatch[1]
  const numPart = raw.substring(0, raw.length - suffix.length)

  if (/^\d+$/.test(numPart)) {
    const num = parseInt(numPart, 10)
    return { normalized: applySuffix(num, suffix), numericValue: applyNumericSuffix(num, suffix) }
  }

  let num = 0
  let section = 0
  let digit = 0
  for (const ch of numPart) {
    const val = CHINESE_NUM_MAP[ch]
    if (val === undefined) continue
    if (val === 100000000) {
      section = section + digit
      num = (num + section) * val
      section = 0
      digit = 0
    } else if (val === 10000) {
      section = section + digit
      num = num + section * val
      section = 0
      digit = 0
    } else if (val >= 10) {
      if (digit === 0) {
        section = section + val
      } else {
        section = section + digit * val
      }
      digit = 0
    } else {
      digit = val
    }
  }
  num += section + digit
  return { normalized: applySuffix(num, suffix), numericValue: applyNumericSuffix(num, suffix) }
}

function applySuffix(num: number, suffix: string): string {
  switch (suffix) {
    case '万元': return (num * 10000).toFixed(2)
    case '亿元': return (num * 100000000).toFixed(2)
    case '万': return (num * 10000).toFixed(2)
    default: return num.toFixed(2)
  }
}

function applyNumericSuffix(num: number, suffix: string): number {
  switch (suffix) {
    case '万元': return num * 10000
    case '亿元': return num * 100000000
    case '万': return num * 10000
    default: return num
  }
}

function parseLawArticle(raw: string): LawArticleEntity {
  const articleMatch = raw.match(/第([一二三四五六七八九十百千万零〇\d]+)条/)
  const paragraphMatch = raw.match(/第[一二三四五六七八九十百千万零〇\d]+条第([一二三四五六七八九十百千万零〇\d]+)款/)
  const itemMatch = raw.match(/第[一二三四五六七八九十百千万零〇\d]+条第[一二三四五六七八九十百千万零〇\d]+款第([一二三四五六七八九十百千万零〇\d]+)项/)

  const article = articleMatch ? parseChineseNumber(articleMatch[1]) || parseInt(articleMatch[1], 10) || 0 : 0
  const paragraph = paragraphMatch ? parseChineseNumber(paragraphMatch[1]) || parseInt(paragraphMatch[1], 10) || 0 : undefined
  const item = itemMatch ? parseChineseNumber(itemMatch[1]) || parseInt(itemMatch[1], 10) || 0 : undefined

  return { raw, article, paragraph, item }
}

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = []

  AMOUNT_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AMOUNT_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const normalized = normalizeAmount(raw)
    if (normalized) entities.push({ type: 'amount', raw, normalized, linePos: match.index })
  }

  CHINESE_AMOUNT_REGEX.lastIndex = 0
  while ((match = CHINESE_AMOUNT_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const parsed = parseChineseAmount(raw)
    if (parsed.numericValue > 0) {
      entities.push({
        type: 'amount',
        raw,
        normalized: parsed.normalized,
        linePos: match.index,
        subType: 'chinese_number'
      })
    }
  }

  DATE_REGEX.lastIndex = 0
  while ((match = DATE_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const normalized = normalizeDate(raw)
    entities.push({ type: 'date', raw, normalized, linePos: match.index })
  }

  PERCENTAGE_REGEX.lastIndex = 0
  while ((match = PERCENTAGE_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const normalized = normalizePercentage(raw)
    entities.push({ type: 'percentage', raw, normalized, linePos: match.index })
  }

  CONTRACT_ID_REGEX.lastIndex = 0
  while ((match = CONTRACT_ID_REGEX.exec(text)) !== null) {
    entities.push({ type: 'contract_id', raw: match[0], normalized: match[0].replace(/[–—]/g, '-'), linePos: match.index })
  }

  PERSON_NAME_REGEX.lastIndex = 0
  while ((match = PERSON_NAME_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const normalized = normalizePersonName(raw)
    if (normalized.length >= 2) {
      entities.push({ type: 'person_name', raw, normalized, linePos: match.index })
    }
  }

  for (const pattern of CONTEXTUAL_NAME_PATTERNS) {
    pattern.lastIndex = 0
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1]
      if (raw.length >= 2) {
        entities.push({
          type: 'person_name',
          raw,
          normalized: raw,
          linePos: match.index + match[0].indexOf(raw),
          subType: 'contextual'
        })
      }
    }
  }

  LAW_ARTICLE_REGEX.lastIndex = 0
  while ((match = LAW_ARTICLE_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const parsed = parseLawArticle(raw)
    entities.push({
      type: 'law_article',
      raw,
      normalized: `第${parsed.article}条${parsed.paragraph ? `第${parsed.paragraph}款` : ''}${parsed.item ? `第${parsed.item}项` : ''}`,
      linePos: match.index,
      subType: 'law_article'
    })
  }

  COMPANY_NAME_REGEX.lastIndex = 0
  while ((match = COMPANY_NAME_REGEX.exec(text)) !== null) {
    entities.push({
      type: 'company_name',
      raw: match[0],
      normalized: match[0],
      linePos: match.index
    })
  }

  BANK_ACCOUNT_REGEX.lastIndex = 0
  while ((match = BANK_ACCOUNT_REGEX.exec(text)) !== null) {
    const raw = match[0].replace(/[\s\-]/g, '')
    if (/^\d{10,30}$/.test(raw)) {
      entities.push({
        type: 'bank_account',
        raw: match[0],
        normalized: raw,
        linePos: match.index
      })
    }
  }

  ID_CARD_REGEX.lastIndex = 0
  while ((match = ID_CARD_REGEX.exec(text)) !== null) {
    entities.push({
      type: 'id_card',
      raw: match[0],
      normalized: match[0].toUpperCase(),
      linePos: match.index
    })
  }

  return entities
}

export function extractEntitiesByType(text: string, targetTypes: FactEntityType[]): ExtractedEntity[] {
  const all = extractEntities(text)
  const typeSet = new Set(targetTypes)
  return all.filter(e => typeSet.has(e.type))
}

export function extractChineseNumberEntities(text: string): ChineseNumberEntity[] {
  const results: ChineseNumberEntity[] = []
  CHINESE_AMOUNT_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CHINESE_AMOUNT_REGEX.exec(text)) !== null) {
    const parsed = parseChineseAmount(match[0])
    if (parsed.numericValue > 0) {
      results.push({
        raw: match[0],
        numericValue: parsed.numericValue,
        normalized: parsed.normalized,
        linePos: match.index
      })
    }
  }
  return results
}

export function extractLawArticleEntities(text: string): LawArticleEntity[] {
  const results: LawArticleEntity[] = []
  LAW_ARTICLE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LAW_ARTICLE_REGEX.exec(text)) !== null) {
    results.push(parseLawArticle(match[0]))
  }
  return results
}

export function extractCompanyNameEntities(text: string): CompanyNameEntity[] {
  const results: CompanyNameEntity[] = []
  COMPANY_NAME_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = COMPANY_NAME_REGEX.exec(text)) !== null) {
    results.push({ raw: match[0], linePos: match.index })
  }
  return results
}
