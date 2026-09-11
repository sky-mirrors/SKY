import { describe, it, expect } from 'vitest'
import { extractEntitiesFromDocuments, findCrossDocumentConflicts, runCrossDocValidation } from '@/services/crossDocValidator'

describe('crossDocValidator', () => {
  describe('extractEntitiesFromDocuments', () => {
    it('extracts entities from multiple documents', () => {
      const docs = [
        { docId: 'doc1', text: '合同金额为人民币60万元' },
        { docId: 'doc2', text: '甲方应支付50万元' }
      ]
      const maps = extractEntitiesFromDocuments(docs)
      expect(maps).toHaveLength(2)
      expect(maps[0].docId).toBe('doc1')
      expect(maps[0].entities.length).toBeGreaterThan(0)
      expect(maps[1].docId).toBe('doc2')
      expect(maps[1].entities.length).toBeGreaterThan(0)
    })

    it('handles empty documents', () => {
      const docs = [
        { docId: 'doc1', text: '' }
      ]
      const maps = extractEntitiesFromDocuments(docs)
      expect(maps).toHaveLength(1)
      expect(maps[0].entities).toHaveLength(0)
    })
  })

  describe('findCrossDocumentConflicts', () => {
    it('finds no conflicts for consistent amounts', () => {
      const docMaps = [
        {
          docId: 'doc1',
          entities: [
            { type: 'amount', raw: '60万元', normalized: '600000.00', confidence: 1, source: 'regex' as const }
          ]
        },
        {
          docId: 'doc2',
          entities: [
            { type: 'amount', raw: '600000元', normalized: '600000.00', confidence: 1, source: 'regex' as const }
          ]
        }
      ]
      const conflicts = findCrossDocumentConflicts(docMaps)
      const amountConflicts = conflicts.filter(c => c.entityType === 'amount')
      expect(amountConflicts).toHaveLength(0)
    })

    it('finds critical conflicts for inconsistent amounts', () => {
      const docMaps = [
        {
          docId: 'doc1',
          entities: [
            { type: 'amount', raw: '60万元', normalized: '600000.00', confidence: 1, source: 'regex' as const }
          ]
        },
        {
          docId: 'doc2',
          entities: [
            { type: 'amount', raw: '30万元', normalized: '300000.00', confidence: 1, source: 'regex' as const }
          ]
        }
      ]
      const conflicts = findCrossDocumentConflicts(docMaps)
      const amountConflicts = conflicts.filter(c => c.entityType === 'amount')
      expect(amountConflicts.length).toBeGreaterThan(0)
    })

    it('finds conflicts for mismatched contract IDs', () => {
      const docMaps = [
        {
          docId: 'doc1',
          entities: [
            { type: 'contract_id', raw: 'HT-2024-001', normalized: 'HT-2024-001', confidence: 1, source: 'regex' as const }
          ]
        },
        {
          docId: 'doc2',
          entities: [
            { type: 'contract_id', raw: 'HT-2024-002', normalized: 'HT-2024-002', confidence: 1, source: 'regex' as const }
          ]
        }
      ]
      const conflicts = findCrossDocumentConflicts(docMaps)
      const idConflicts = conflicts.filter(c => c.entityType === 'contract_id')
      expect(idConflicts.length).toBeGreaterThan(0)
      expect(idConflicts[0].severity).toBe('critical')
    })

    it('finds no conflicts for documents with no overlapping entity types', () => {
      const docMaps = [
        {
          docId: 'doc1',
          entities: [
            { type: 'amount', raw: '60万元', normalized: '600000.00', confidence: 1, source: 'regex' as const }
          ]
        },
        {
          docId: 'doc2',
          entities: [
            { type: 'date', raw: '2024年3月1日', normalized: '2024-03-01', confidence: 1, source: 'regex' as const }
          ]
        }
      ]
      const conflicts = findCrossDocumentConflicts(docMaps)
      expect(conflicts).toHaveLength(0)
    })

    it('handles empty entity lists', () => {
      const docMaps = [
        { docId: 'doc1', entities: [] },
        { docId: 'doc2', entities: [] }
      ]
      const conflicts = findCrossDocumentConflicts(docMaps)
      expect(conflicts).toHaveLength(0)
    })
  })

  describe('runCrossDocValidation', () => {
    it('returns constraint results for conflicts', () => {
      const docs = [
        { docId: 'contract', text: '合同编号HT-2024-001，金额60万元' },
        { docId: 'invoice', text: '合同编号HT-2024-002，金额30万元' }
      ]
      const results = runCrossDocValidation(docs)
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.severity === 'error' || r.severity === 'warning')).toBe(true)
    })

    it('returns empty results for single document', () => {
      const docs = [
        { docId: 'doc1', text: '合同金额60万元' }
      ]
      const results = runCrossDocValidation(docs)
      expect(results).toHaveLength(0)
    })

    it('returns empty results for consistent documents', () => {
      const docs = [
        { docId: 'doc1', text: '甲方北京科技有限公司' },
        { docId: 'doc2', text: '甲方北京科技有限公司' }
      ]
      const results = runCrossDocValidation(docs)
      const criticalResults = results.filter(r => r.severity === 'error')
      expect(criticalResults).toHaveLength(0)
    })
  })
})
