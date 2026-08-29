export type FactEntityType = 'amount' | 'date' | 'percentage' | 'contract_id' | 'person_name'

export interface ExtractedEntity {
  type: FactEntityType
  raw: string
  normalized: string
  linePos: number
}

export interface FactConflict {
  type: FactEntityType
  sourceRaw: string
  outputRaw: string
  sourceNormalized: string
  outputNormalized: string
  severity: 'critical' | 'minor'
  diff: string
}

export interface FactGuardResult {
  ok: boolean
  conflicts: FactConflict[]
  hallucinatedEntities: ExtractedEntity[]
  severity: 'critical' | 'minor' | 'ok'
  correctedOutput: string | null
  summary: string
}

const TRIGGER_ROLES = new Set(['finance', 'legal', 'hr'])

const AMOUNT_REGEX = /(￥|¥|\$|USD\s?|CNY\s?)?\d{1,3}(,\d{3})+(\.\d{1,2})?(元|美元|万元|万|块)?|(￥|¥|\$|USD\s?|CNY\s?)?\d+(\.\d{1,2})?(元|美元|万元|万|块)/g
const DATE_REGEX = /\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}|\d{4}年\d{1,2}月(\d{1,2}日?)?/g
const PERCENTAGE_REGEX = /\d+(\.\d+)?%/g
const CONTRACT_ID_REGEX = /[A-Za-z]{1,4}[-–—]?\d{4}[-–—]?\d{3,}/g
const PERSON_NAME_REGEX = /[\u4e00-\u9fa5]{2,4}(总|经理|先生|女士|主任|总监|主管|工程师|老师)/g

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

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = []

  AMOUNT_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AMOUNT_REGEX.exec(text)) !== null) {
    const raw = match[0]
    const normalized = normalizeAmount(raw)
    if (normalized) entities.push({ type: 'amount', raw, normalized, linePos: match.index })
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

  return entities
}

function compareAmounts(a: string, b: string): { match: boolean; diff: number } {
  const fa = parseFloat(a)
  const fb = parseFloat(b)
  if (isNaN(fa) || isNaN(fb)) return { match: false, diff: Infinity }
  const diff = Math.abs(fa - fb)
  if (fa === 0) return { match: fb === 0, diff }
  const pctDiff = diff / Math.abs(fa)
  return { match: diff < 0.01 && pctDiff < 0.001, diff }
}

function compareDates(a: string, b: string): { match: boolean; diffDays: number } {
  const da = new Date(a)
  const db = new Date(b)
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return { match: false, diffDays: Infinity }
  const diffMs = Math.abs(da.getTime() - db.getTime())
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  return { match: diffDays <= 1, diffDays }
}

function comparePercentages(a: string, b: string): { match: boolean; diff: number } {
  const fa = parseFloat(a)
  const fb = parseFloat(b)
  if (isNaN(fa) || isNaN(fb)) return { match: false, diff: Infinity }
  const diff = Math.abs(fa - fb)
  return { match: diff < 0.1, diff }
}

export function shouldTrigger(manifestRoles: string[], contextText: string): boolean {
  const hasTriggerRole = manifestRoles.some(r => TRIGGER_ROLES.has(r))
  if (!hasTriggerRole) return false
  const entities = extractEntities(contextText.substring(0, 5000))
  return entities.length > 0
}

export function runFactGuard(
  groundTruthEntities: ExtractedEntity[],
  outputEntities: ExtractedEntity[],
  llmOutput: string
): FactGuardResult {
  const conflicts: FactConflict[] = []
  const hallucinatedEntities: ExtractedEntity[] = []

  const sourceByType = new Map<FactEntityType, ExtractedEntity[]>()
  for (const e of groundTruthEntities) {
    if (!sourceByType.has(e.type)) sourceByType.set(e.type, [])
    sourceByType.get(e.type)!.push(e)
  }

  const outputByType = new Map<FactEntityType, ExtractedEntity[]>()
  for (const e of outputEntities) {
    if (!outputByType.has(e.type)) outputByType.set(e.type, [])
    outputByType.get(e.type)!.push(e)
  }

  for (const [type, outputList] of outputByType) {
    const sourceList = sourceByType.get(type) || []

    for (const out of outputList) {
      let matched = false
      for (const src of sourceList) {
        let isMatch = false
        let diff = ''
        let severity: 'critical' | 'minor' = 'minor'

        if (type === 'amount') {
          const cmp = compareAmounts(src.normalized, out.normalized)
          isMatch = cmp.match
          if (!isMatch) {
            const pctDiff = src.normalized !== '0.00' ? (cmp.diff / parseFloat(src.normalized) * 100) : 100
            severity = pctDiff > 10 ? 'critical' : 'minor'
            diff = `金额差异: ${src.raw} vs ${out.raw} (差${cmp.diff.toFixed(2)}, ${pctDiff.toFixed(1)}%)`
          }
        } else if (type === 'date') {
          const cmp = compareDates(src.normalized, out.normalized)
          isMatch = cmp.match
          if (!isMatch) {
            severity = cmp.diffDays > 3 ? 'critical' : 'minor'
            diff = `日期差异: ${src.raw} vs ${out.raw} (差${cmp.diffDays.toFixed(1)}天)`
          }
        } else if (type === 'percentage') {
          const cmp = comparePercentages(src.normalized, out.normalized)
          isMatch = cmp.match
          if (!isMatch) {
            severity = cmp.diff > 1 ? 'critical' : 'minor'
            diff = `百分比差异: ${src.raw} vs ${out.raw} (差${cmp.diff.toFixed(2)}%)`
          }
        } else if (type === 'contract_id') {
          isMatch = src.normalized === out.normalized
          if (!isMatch) {
            severity = 'critical'
            diff = `编号不匹配: ${src.raw} vs ${out.raw}`
          }
        } else if (type === 'person_name') {
          isMatch = src.normalized === out.normalized || src.normalized.includes(out.normalized) || out.normalized.includes(src.normalized)
          if (!isMatch) {
            severity = 'minor'
            diff = `姓名差异: ${src.raw} vs ${out.raw}`
          }
        }

        if (isMatch) {
          matched = true
          break
        }
        if (!isMatch && src.normalized) {
          conflicts.push({
            type,
            sourceRaw: src.raw,
            outputRaw: out.raw,
            sourceNormalized: src.normalized,
            outputNormalized: out.normalized,
            severity,
            diff
          })
          matched = true
          break
        }
      }

      if (!matched && sourceList.length === 0) {
        hallucinatedEntities.push(out)
      }
    }
  }

  const criticalConflicts = conflicts.filter(c => c.severity === 'critical')
  const minorConflicts = conflicts.filter(c => c.severity === 'minor')

  let correctedOutput: string | null = null
  if (minorConflicts.length > 0 && criticalConflicts.length === 0) {
    let corrected = llmOutput
    for (const c of minorConflicts) {
      corrected = corrected.replaceAll(c.outputRaw, c.sourceRaw)
    }
    correctedOutput = corrected
  }

  const severity: 'critical' | 'minor' | 'ok' = criticalConflicts.length > 0
    ? 'critical'
    : minorConflicts.length > 0
      ? 'minor'
      : 'ok'

  const ok = severity === 'ok'
  const summary = ok
    ? '✅ 事实一致性校验通过'
    : severity === 'critical'
      ? `🔴 严重事实冲突: ${criticalConflicts.map(c => c.diff).join('；')}`
      : `🟡 微小差异已自动修正: ${minorConflicts.map(c => c.diff).join('；')}`

  return { ok, conflicts, hallucinatedEntities, severity, correctedOutput, summary }
}
