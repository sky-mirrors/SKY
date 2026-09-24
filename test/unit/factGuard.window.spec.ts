// G-3：FactGuard 的保护窗口从「文本前 5000 字」扩到全文分段。
// 原实现两处硬编码 `substring(0, 5000)`（macroExecutor 的 ground truth 与 output 比对），
// 财报后半段的金额/日期既进不了 ground truth、也不参与输出比对；与 G-1（消费者只见 800 字）
// 叠加成最坏组合：模型看不全（可能编数字），FactGuard 也看不全（编了不拦）。
import { describe, it, expect } from 'vitest'
import { extractEntitiesAll, ENTITY_EXTRACT_CHUNK } from '@/services/factGuard'
import { extractEntities } from '@/services/nerExtractor'

describe('G-3：FactGuard 抽取窗口覆盖全文', () => {
  it('短文本不改变行为——与 extractEntities 完全一致', () => {
    const t = '合同金额 1234.56 元，签署日期 2026-03-15，占比 12.5%。'
    expect(t.length).toBeLessThan(ENTITY_EXTRACT_CHUNK)
    expect(extractEntitiesAll(t)).toEqual(extractEntities(t))
  })

  it('空文本返回空（不抛错）', () => {
    expect(extractEntitiesAll('')).toEqual([])
  })

  it('超长文本：后半部分的金额也进入保护范围（旧窗口看不到）', () => {
    const filler = '甲方为某某有限公司，双方就合作事宜达成一致意见并签署本协议。'.repeat(300)
    // 注意：AMOUNT_REGEX 要求数字与单位紧邻（\d+(\.\d{1,2})?(元|…)），故不写空格
    const text = `${filler}\n尾款金额 987654.32元。`
    expect(text.length).toBeGreaterThan(ENTITY_EXTRACT_CHUNK)

    // 旧实现（只取前 5000 字）看不到尾部金额——这是 G-3 的实测形态
    const oldWindow = extractEntities(text.substring(0, ENTITY_EXTRACT_CHUNK))
    expect(oldWindow.some(e => e.normalized.includes('987654'))).toBe(false)

    // 新实现全文分段抽取能看到
    const all = extractEntitiesAll(text)
    expect(all.some(e => e.normalized.includes('987654'))).toBe(true)
  })

  it('重复实体去重（同一实体出现在多个分段只保留一条）', () => {
    const unit = '合同编号 HT-2026-0001，金额 5000.00 元。'
    const text = unit.repeat(400)
    expect(text.length).toBeGreaterThan(ENTITY_EXTRACT_CHUNK)

    const all = extractEntitiesAll(text)
    const ids = all.filter(e => e.type === 'contract_id').map(e => e.normalized)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('linePos 是全文偏移（跨分段后仍可用于定位）', () => {
    const filler = '无关内容占位。'.repeat(1000)
    const text = `${filler}金额 8888.88元。`
    expect(text.length).toBeGreaterThan(ENTITY_EXTRACT_CHUNK)

    const hit = extractEntitiesAll(text).find(e => e.normalized.includes('8888'))
    expect(hit).toBeTruthy()
    // 定位到的是全文里该金额出现的位置，而不是分段内的相对位置
    expect(text.slice(hit!.linePos, hit!.linePos + 4)).toContain('8888')
  })
})
