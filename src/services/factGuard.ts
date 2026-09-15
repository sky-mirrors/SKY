import type {
  FactEntityType,
  ExtractedEntity,
  FactConflict,
  FactGuardResult,
  ConstraintResult,
  ConstraintCheckContext
} from '@/models'
import { extractEntities } from './nerExtractor'
import { runConstraints } from './domainConstraints'
import { processConstraintResults } from './constraintFeedback'
import { runCrossDocValidation } from './crossDocValidator'

export type { FactEntityType, ExtractedEntity, FactConflict, FactGuardResult }

const TRIGGER_ROLES = new Set(['finance', 'legal', 'hr'])

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

export { extractEntities }

export function shouldTrigger(manifestRoles: string[], contextText: string): boolean {
  const hasTriggerRole = manifestRoles.some(r => TRIGGER_ROLES.has(r))
  if (!hasTriggerRole) return false
  const entities = extractEntities(contextText.substring(0, 5000))
  return entities.length > 0
}

function runFactGuard(
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
      let conflict: FactConflict | null = null
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
        } else if (type === 'contract_id' || type === 'id_card' || type === 'bank_account') {
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
        } else if (type === 'company_name') {
          isMatch = src.normalized === out.normalized || src.normalized.includes(out.normalized) || out.normalized.includes(src.normalized)
          if (!isMatch) {
            severity = 'minor'
            diff = `公司名称差异: ${src.raw} vs ${out.raw}`
          }
        } else if (type === 'law_article') {
          isMatch = src.normalized === out.normalized
          if (!isMatch) {
            severity = 'critical'
            diff = `法条引用差异: ${src.raw} vs ${out.raw}`
          }
        }

        if (isMatch) {
          matched = true
          break
        }
        // P1-20：不匹配时只记录首个冲突候选并继续尝试其余 source——
        // 原实现在首个不匹配处即 push+break，后续本可匹配成功的 source
        // 永远得不到比对（多金额文档中系统性制造假冲突）
        if (!conflict && src.normalized) {
          conflict = {
            type,
            sourceRaw: src.raw,
            outputRaw: out.raw,
            sourceNormalized: src.normalized,
            outputNormalized: out.normalized,
            severity,
            diff
          }
        }
      }

      if (!matched && conflict) {
        conflicts.push(conflict)
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
    ? '事实一致性校验通过'
    : severity === 'critical'
      ? `严重事实冲突: ${criticalConflicts.map(c => c.diff).join('；')}`
      : `微小差异已自动修正: ${minorConflicts.map(c => c.diff).join('；')}`

  return { ok, conflicts, hallucinatedEntities, severity, correctedOutput, summary }
}

export interface FactGuardV2Result extends FactGuardResult {
  layer1Entities: ExtractedEntity[]
  layer2ConstraintResults: ConstraintResult[]
  layer3CrossDocResults: ConstraintResult[]
  allConstraintResults: ConstraintResult[]
}

export function runFactGuardV2(
  groundTruthEntities: ExtractedEntity[],
  outputEntities: ExtractedEntity[],
  llmOutput: string,
  documents?: { docId: string; text: string }[]
): FactGuardV2Result {
  const layer1Result = runFactGuard(groundTruthEntities, outputEntities, llmOutput)

  const constraintCtx: ConstraintCheckContext = {
    entities: groundTruthEntities,
    sourceText: llmOutput,
    outputText: llmOutput,
    stepResults: {},
    manifestRoles: []
  }
  const layer2Results = runConstraints(constraintCtx)
  processConstraintResults(layer2Results)

  let layer3Results: ConstraintResult[] = []
  if (documents && documents.length > 1) {
    layer3Results = runCrossDocValidation(documents)
    processConstraintResults(layer3Results)
  }

  const allConstraintResults = [...layer2Results, ...layer3Results]
  const fullLevelResults = allConstraintResults.filter(r => !r.automationLevel || r.automationLevel === 'full')
  const constraintErrors = fullLevelResults.filter(r => r.triggered && r.severity === 'error')
  const constraintWarnings = fullLevelResults.filter(r => r.triggered && r.severity === 'warning')

  let finalSeverity: 'critical' | 'minor' | 'ok' = layer1Result.severity
  if (constraintErrors.length > 0) {
    finalSeverity = 'critical'
  } else if (constraintWarnings.length > 0 && finalSeverity === 'ok') {
    finalSeverity = 'minor'
  }

  let finalSummary = layer1Result.summary
  if (constraintErrors.length > 0) {
    finalSummary += `；领域约束违规: ${constraintErrors.map(r => r.message).join('；')}`
  }
  if (constraintWarnings.length > 0) {
    finalSummary += `；领域约束警告: ${constraintWarnings.map(r => r.message).join('；')}`
  }

  return {
    ...layer1Result,
    ok: finalSeverity === 'ok',
    severity: finalSeverity,
    summary: finalSummary,
    layer1Entities: groundTruthEntities,
    layer2ConstraintResults: layer2Results,
    layer3CrossDocResults: layer3Results,
    allConstraintResults: allConstraintResults
  }
}
