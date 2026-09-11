import type { ExtractedEntity, ConstraintCheckContext, ConstraintResult } from '@/models'
import { extractEntities } from './nerExtractor'

interface DocumentEntityMap {
  docId: string
  entities: ExtractedEntity[]
}

interface CrossDocConflict {
  entityType: string
  docAId: string
  docAValue: string
  docBId: string
  docBValue: string
  severity: 'critical' | 'minor'
}

export function extractEntitiesFromDocuments(
  documents: { docId: string; text: string }[]
): DocumentEntityMap[] {
  return documents.map(doc => ({
    docId: doc.docId,
    entities: extractEntities(doc.text)
  }))
}

function compareEntityValues(
  type: string,
  a: ExtractedEntity,
  b: ExtractedEntity
): { match: boolean; severity: 'critical' | 'minor' } {
  if (type === 'amount') {
    const fa = parseFloat(a.normalized)
    const fb = parseFloat(b.normalized)
    if (isNaN(fa) || isNaN(fb)) return { match: false, severity: 'minor' }
    const diff = Math.abs(fa - fb)
    const pctDiff = fa !== 0 ? diff / Math.abs(fa) : 1
    return { match: pctDiff < 0.001, severity: pctDiff > 0.1 ? 'critical' : 'minor' }
  }

  if (type === 'date') {
    const da = new Date(a.normalized)
    const db = new Date(b.normalized)
    if (isNaN(da.getTime()) || isNaN(db.getTime())) return { match: false, severity: 'minor' }
    const diffDays = Math.abs(da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24)
    return { match: diffDays <= 1, severity: diffDays > 3 ? 'critical' : 'minor' }
  }

  if (type === 'percentage') {
    const fa = parseFloat(a.normalized)
    const fb = parseFloat(b.normalized)
    const diff = Math.abs(fa - fb)
    return { match: diff < 0.1, severity: diff > 1 ? 'critical' : 'minor' }
  }

  if (type === 'contract_id' || type === 'id_card' || type === 'bank_account') {
    return { match: a.normalized === b.normalized, severity: 'critical' }
  }

  if (type === 'person_name' || type === 'company_name') {
    const match = a.normalized === b.normalized ||
      a.normalized.includes(b.normalized) ||
      b.normalized.includes(a.normalized)
    return { match, severity: 'minor' }
  }

  if (type === 'law_article') {
    return { match: a.normalized === b.normalized, severity: 'critical' }
  }

  return { match: a.normalized === b.normalized, severity: 'minor' }
}

export function findCrossDocumentConflicts(
  docMaps: DocumentEntityMap[]
): CrossDocConflict[] {
  const conflicts: CrossDocConflict[] = []

  for (let i = 0; i < docMaps.length; i++) {
    for (let j = i + 1; j < docMaps.length; j++) {
      const docA = docMaps[i]
      const docB = docMaps[j]

      const typesA = new Set(docA.entities.map(e => e.type))
      const commonTypes = docB.entities.filter(e => typesA.has(e.type)).map(e => e.type)
      const uniqueTypes = new Set(commonTypes)

      for (const type of uniqueTypes) {
        const entitiesA = docA.entities.filter(e => e.type === type)
        const entitiesB = docB.entities.filter(e => e.type === type)

        for (const eA of entitiesA) {
          let anyMatch = false
          for (const eB of entitiesB) {
            const cmp = compareEntityValues(type, eA, eB)
            if (cmp.match) {
              anyMatch = true
              break
            }
            if (!cmp.match) {
              conflicts.push({
                entityType: type,
                docAId: docA.docId,
                docAValue: eA.raw,
                docBId: docB.docId,
                docBValue: eB.raw,
                severity: cmp.severity
              })
              anyMatch = true
              break
            }
          }
        }
      }
    }
  }

  return conflicts
}

export function runCrossDocValidation(
  documents: { docId: string; text: string }[]
): ConstraintResult[] {
  const docMaps = extractEntitiesFromDocuments(documents)
  const conflicts = findCrossDocumentConflicts(docMaps)

  const criticalConflicts = conflicts.filter(c => c.severity === 'critical')
  const minorConflicts = conflicts.filter(c => c.severity === 'minor')

  const results: ConstraintResult[] = []

  for (const conflict of criticalConflicts) {
    results.push({
      triggered: true,
      constraintId: `cross-doc-${conflict.entityType}-critical`,
      severity: 'error',
      message: `跨文档${conflict.entityType}不一致: ${conflict.docAId}(${conflict.docAValue}) vs ${conflict.docBId}(${conflict.docBValue})`,
      reliability: {
        confidence: 'high',
        source: {
          type: 'standard',
          name: '跨文档一致性校验',
          article: '自动',
          effectiveDate: new Date().toISOString().split('T')[0]
        }
      }
    })
  }

  for (const conflict of minorConflicts) {
    results.push({
      triggered: true,
      constraintId: `cross-doc-${conflict.entityType}-minor`,
      severity: 'warning',
      message: `跨文档${conflict.entityType}微小差异: ${conflict.docAId}(${conflict.docAValue}) vs ${conflict.docBId}(${conflict.docBValue})`,
      reliability: {
        confidence: 'medium',
        source: {
          type: 'standard',
          name: '跨文档一致性校验',
          article: '自动',
          effectiveDate: new Date().toISOString().split('T')[0]
        },
        caveat: '差异较小，可能由表述方式不同导致'
      }
    })
  }

  return results
}
