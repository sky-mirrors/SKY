import { describe, it, expect } from 'vitest'
import { contentHash } from '@/services/hash'

describe('contentHash', () => {
  it('returns consistent hash for same input', () => {
    const h1 = contentHash('hello world')
    const h2 = contentHash('hello world')
    expect(h1).toBe(h2)
  })

  it('returns different hash for different input', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'))
  })

  it('returns string representation in base36', () => {
    const h = contentHash('test')
    expect(h).toMatch(/^[0-9a-z]+$/)
  })

  it('handles empty string', () => {
    const h = contentHash('')
    expect(h).toBeDefined()
    expect(typeof h).toBe('string')
  })

  it('handles unicode / Chinese characters', () => {
    const h = contentHash('你好世界')
    expect(h).toBeDefined()
    expect(typeof h).toBe('string')
  })

  it('produces 32-bit unsigned result', () => {
    const h = contentHash('overflow-test')
    const num = parseInt(h, 36)
    expect(num).toBeGreaterThanOrEqual(0)
    expect(num).toBeLessThanOrEqual(0xFFFFFFFF)
  })

  it('is deterministic across multiple calls', () => {
    const results = Array.from({ length: 100 }, () => contentHash('deterministic'))
    expect(new Set(results).size).toBe(1)
  })

  it('different strings produce different hashes (collision resistance sanity)', () => {
    const hashes = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      hashes.add(contentHash(`unique-input-${i}`))
    }
    expect(hashes.size).toBe(1000)
  })
})
