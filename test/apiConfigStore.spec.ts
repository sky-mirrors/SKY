import { describe, it, expect, vi, afterEach } from 'vitest'
import { pickApiConfig, isUsableApiConfig, stripBom, type ApiConfigSource } from '@electron/apiConfigStore'

function src(label: string, value: string | null, throwErr?: unknown): ApiConfigSource {
  return {
    label,
    read: () => { if (throwErr !== undefined) throw throwErr; return value }
  }
}

const GOOD = JSON.stringify({ providers: [{ id: 'custom-1', baseUrl: 'https://api.deepseek.com' }] })

describe('apiConfigStore.pickApiConfig（2026-09-23 读写分裂事故根治）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('首选源命中即返回，且不再读后续源', () => {
    const later = vi.fn(() => GOOD)
    const picked = pickApiConfig([src('vault:secure', GOOD), { label: 'file', read: later }])
    expect(picked).toEqual({ providers: [{ id: 'custom-1', baseUrl: 'https://api.deepseek.com' }] })
    expect(later).not.toHaveBeenCalled()
  })

  it('首选源为空（null）时回退到下一源', () => {
    const picked = pickApiConfig([src('vault:secure', null), src('vault:api', GOOD)])
    expect(picked?.providers).toHaveLength(1)
  })

  it('首选源为空串时回退到下一源', () => {
    const picked = pickApiConfig([src('vault:secure', ''), src('file', GOOD)])
    expect(picked?.providers).toHaveLength(1)
  })

  it('空对象 {} 不算有效配置——必须继续下一源（本次事故的文件形态是 2 字节 {}）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const picked = pickApiConfig([src('file:stale', '{}'), src('vault:secure', GOOD)])
    expect(picked?.providers).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('解析失败（坏 JSON）不抛出，继续下一源', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => pickApiConfig([src('file:corrupt', '{oops'), src('vault:secure', GOOD)])).not.toThrow()
    const picked = pickApiConfig([src('file:corrupt', '{oops'), src('vault:secure', GOOD)])
    expect(picked?.providers).toHaveLength(1)
  })

  it('read 抛异常不冒泡，继续下一源（vault 库未打开等）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const picked = pickApiConfig([src('vault:secure', null, new Error('Database not opened')), src('file', GOOD)])
    expect(picked?.providers).toHaveLength(1)
  })

  it('带 BOM 的合法 JSON 可解析（BOM 事故防复发）', () => {
    const picked = pickApiConfig([src('vault:secure', '\uFEFF' + GOOD)])
    expect(picked?.providers).toHaveLength(1)
  })

  it('带 BOM 的空对象仍不算有效配置', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(pickApiConfig([src('file', '\uFEFF{}')])).toBeNull()
  })

  it('仅 baseUrl 的旧存档算有效（兼容老格式）', () => {
    const picked = pickApiConfig([src('file', JSON.stringify({ baseUrl: 'https://x.test' }))])
    expect(picked?.baseUrl).toBe('https://x.test')
  })

  it('全部源不可用时返回 null（不抛错）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(pickApiConfig([src('a', null), src('b', '{}'), src('c', 'nonsense')])).toBeNull()
  })

  it('空源列表返回 null', () => {
    expect(pickApiConfig([])).toBeNull()
  })
})

describe('apiConfigStore 辅助', () => {
  it('stripBom 只剥开头的 BOM', () => {
    expect(stripBom('\uFEFF{}')).toBe('{}')
    expect(stripBom('{}')).toBe('{}')
    expect(stripBom('{"a":"\uFEFF"}')).toBe('{"a":"\uFEFF"}')
  })

  it('isUsableApiConfig 判定', () => {
    expect(isUsableApiConfig({ providers: [] })).toBe(true)
    expect(isUsableApiConfig({ baseUrl: 'http://x' })).toBe(true)
    expect(isUsableApiConfig({})).toBe(false)
    expect(isUsableApiConfig(null)).toBe(false)
    expect(isUsableApiConfig('str')).toBe(false)
    expect(isUsableApiConfig({ providers: 'not-array' })).toBe(false)
  })
})
