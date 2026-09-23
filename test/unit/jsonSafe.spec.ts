// BOM 防护（2026-09-23 事故后补）：
//   实况：`api-config.json` 被写成「BOM + {}」（5 字节）⇒ 加载时 JSON.parse 直接抛错 ⇒
//   整个应用"没有模型配置"⇒ 所有 LLM 调用失败（考试 0%、普通对话无回复）。
//   且 vault 读取处**静默返回 null**，让这个故障隐形很久。
// 本模块：剥 BOM + 容错解析 + 失败可见告警。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { stripBom, parseJsonSafe } from '@/services/jsonSafe'

afterEach(() => { vi.restoreAllMocks() })

describe('stripBom：剥离 UTF-8 BOM', () => {
  it('剥离前置 BOM（U+FEFF）', () => {
    expect(stripBom('\uFEFF{}')).toBe('{}')
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}')
  })
  it('无 BOM 时原样返回；空串安全', () => {
    expect(stripBom('{}')).toBe('{}')
    expect(stripBom('')).toBe('')
  })
})

describe('parseJsonSafe：容错解析', () => {
  it('带 BOM 的 JSON 也能解析（事故现场的那 5 个字节）', () => {
    expect(parseJsonSafe<Record<string, unknown>>('\uFEFF{}', 'api-config')).toEqual({})
    expect(parseJsonSafe<{ a: number }>('\uFEFF{"a":1}', 'api-config')).toEqual({ a: 1 })
  })
  it('null/undefined 返回 null，不抛', () => {
    expect(parseJsonSafe(null, 'x')).toBeNull()
    expect(parseJsonSafe(undefined, 'x')).toBeNull()
  })
  it('真损坏时返回 null 并**给出可见告警**（不再静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseJsonSafe('{不是JSON', 'vault:api-config')).toBeNull()
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('api-config')
  })
})
