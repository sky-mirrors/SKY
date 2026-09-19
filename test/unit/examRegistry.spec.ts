import { describe, it, expect } from 'vitest'
import { registerExamTrace, releaseExamTrace, clearExamTraces, isExamTraceId, activeExamTraceCount } from '@/exam/examRegistry'

describe('EXAM-1 examRegistry', () => {
  it('注册后 isExamTraceId 命中，释放/清空后失效', () => {
    clearExamTraces()
    registerExamTrace('trace-a')
    expect(isExamTraceId('trace-a')).toBe(true)
    expect(isExamTraceId('trace-b')).toBe(false)
    expect(activeExamTraceCount()).toBe(1)

    releaseExamTrace('trace-a')
    expect(isExamTraceId('trace-a')).toBe(false)

    registerExamTrace('trace-a')
    registerExamTrace('trace-b')
    clearExamTraces()
    expect(activeExamTraceCount()).toBe(0)
    expect(isExamTraceId('trace-a')).toBe(false)
  })

  it('空 traceId 不注册；undefined/空串判定为非 exam 流量', () => {
    clearExamTraces()
    registerExamTrace('')
    expect(activeExamTraceCount()).toBe(0)
    expect(isExamTraceId(undefined)).toBe(false)
    expect(isExamTraceId('')).toBe(false)
  })
})
