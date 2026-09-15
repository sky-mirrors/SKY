import { describe, it, expect } from 'vitest'
import { newTraceId } from '@/services/trace'

describe('#2 traceId 参数化', () => {
  it('newTraceId 为纯生成——每次调用独立且非空', () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })
})
