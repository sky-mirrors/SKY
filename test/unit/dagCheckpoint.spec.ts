import { describe, it, expect, beforeEach } from 'vitest'
import { createCheckpointId } from '@/services/dagCheckpoint'

describe('dagCheckpoint', () => {
  describe('createCheckpointId', () => {
    it('returns string starting with cp-', () => {
      const id = createCheckpointId('manifest-1', { inputText: 'test' })
      expect(id).toMatch(/^cp-/)
    })

    it('includes manifestId in the id', () => {
      const id = createCheckpointId('my-manifest', { inputText: 'test' })
      expect(id).toContain('my-manifest')
    })

    it('is deterministic for same input', () => {
      const id1 = createCheckpointId('m1', { inputText: 'hello' })
      const id2 = createCheckpointId('m1', { inputText: 'hello' })
      expect(id1).toBe(id2)
    })

    it('produces different ids for different manifestId', () => {
      const id1 = createCheckpointId('manifest-a', { inputText: 'test' })
      const id2 = createCheckpointId('manifest-b', { inputText: 'test' })
      expect(id1).not.toBe(id2)
    })

    it('produces different ids for different userInput', () => {
      const id1 = createCheckpointId('m1', { inputText: 'hello' })
      const id2 = createCheckpointId('m1', { inputText: 'world' })
      expect(id1).not.toBe(id2)
    })

    it('handles empty userInput', () => {
      const id = createCheckpointId('m1', {})
      expect(id).toMatch(/^cp-m1-/)
    })

    it('handles filePath + inputText + context combined', () => {
      const id = createCheckpointId('m1', { filePath: '/a.txt', inputText: 'query', context: 'ctx' })
      expect(id).toMatch(/^cp-m1-/)
      const idDiff = createCheckpointId('m1', { filePath: '/b.txt', inputText: 'query', context: 'ctx' })
      expect(id).not.toBe(idDiff)
    })

    it('produces consistent hash for same composite key', () => {
      const input = { filePath: '/test.txt', inputText: 'analyze', context: 'financial' }
      const ids = Array.from({ length: 10 }, () => createCheckpointId('m1', input))
      expect(new Set(ids).size).toBe(1)
    })
  })
})
