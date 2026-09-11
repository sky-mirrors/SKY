import { describe, it, expect, vi, beforeEach } from 'vitest'
import { debugLog } from '@/services/debugLog'

describe('debugLog', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('function exists and is callable', () => {
    expect(typeof debugLog).toBe('function')
  })

  it('accepts multiple arguments without throwing', () => {
    expect(() => debugLog('a', 'b', 'c')).not.toThrow()
  })

  it('accepts no arguments without throwing', () => {
    expect(() => debugLog()).not.toThrow()
  })

  it('accepts various types without throwing', () => {
    expect(() => debugLog('str', 123, true, null, { key: 'val' }, [1, 2])).not.toThrow()
  })
})
