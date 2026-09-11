import { describe, it, expect } from 'vitest'
import { generatePseudoVector, cosineSimilarity, needsReembedding, VECTOR_DIM } from '@/services/embedder'

describe('embedder', () => {
  describe('VECTOR_DIM', () => {
    it('is 384', () => {
      expect(VECTOR_DIM).toBe(384)
    })
  })

  describe('generatePseudoVector', () => {
    it('returns vector of correct dimension', () => {
      const vec = generatePseudoVector('test input')
      expect(vec.length).toBe(VECTOR_DIM)
    })

    it('returns vector of custom dimension', () => {
      const vec = generatePseudoVector('test', 128)
      expect(vec.length).toBe(128)
    })

    it('is deterministic for same input', () => {
      const v1 = generatePseudoVector('consistent text')
      const v2 = generatePseudoVector('consistent text')
      expect(v1).toEqual(v2)
    })

    it('produces different vectors for different input', () => {
      const v1 = generatePseudoVector('hello world')
      const v2 = generatePseudoVector('goodbye world')
      let same = true
      for (let i = 0; i < v1.length; i++) {
        if (v1[i] !== v2[i]) { same = false; break }
      }
      expect(same).toBe(false)
    })

    it('produces normalized vector (L2 norm ~1)', () => {
      const vec = generatePseudoVector('normalization test')
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
      expect(norm).toBeCloseTo(1.0, 4)
    })

    it('handles empty string', () => {
      const vec = generatePseudoVector('')
      expect(vec.length).toBe(VECTOR_DIM)
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
      expect(norm).toBeCloseTo(0.0, 4)
    })

    it('handles Chinese text', () => {
      const vec = generatePseudoVector('你好世界')
      expect(vec.length).toBe(VECTOR_DIM)
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
      expect(norm).toBeCloseTo(1.0, 4)
    })
  })

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const vec = generatePseudoVector('test')
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 6)
    })

    it('returns 0 for orthogonal vectors', () => {
      const a = [1, 0, 0]
      const b = [0, 1, 0]
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 6)
    })

    it('returns -1 for opposite vectors', () => {
      const a = [1, 0]
      const b = [-1, 0]
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 6)
    })

    it('returns 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0)
    })

    it('returns 0 for mismatched lengths', () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    })

    it('returns high similarity for semantically similar pseudo vectors', () => {
      const v1 = generatePseudoVector('contract review analysis')
      const v2 = generatePseudoVector('contract review analysis')
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 6)
    })

    it('returns lower similarity for different pseudo vectors', () => {
      const v1 = generatePseudoVector('financial report analysis')
      const v2 = generatePseudoVector('weather forecast prediction')
      expect(cosineSimilarity(v1, v2)).toBeLessThan(1.0)
    })
  })

  describe('needsReembedding', () => {
    it('returns true for wrong dimension', () => {
      expect(needsReembedding(new Array(128).fill(0))).toBe(true)
    })

    it('returns false for correct dimension', () => {
      expect(needsReembedding(new Array(VECTOR_DIM).fill(0))).toBe(false)
    })

    it('returns true for empty vector', () => {
      expect(needsReembedding([])).toBe(true)
    })
  })
})
