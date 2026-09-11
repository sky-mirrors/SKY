import { describe, it, expect } from 'vitest'
import {
  extractEntities,
  extractEntitiesByType,
  extractChineseNumberEntities,
  extractLawArticleEntities,
  extractCompanyNameEntities
} from '@/services/nerExtractor'

describe('nerExtractor', () => {
  describe('extractEntities - basic types', () => {
    it('extracts Arabic amounts', () => {
      const entities = extractEntities('合同金额为￥50,000.00元')
      const amounts = entities.filter(e => e.type === 'amount')
      expect(amounts.length).toBeGreaterThanOrEqual(1)
      expect(amounts.some(a => a.normalized === '50000.00')).toBe(true)
    })

    it('extracts dates in Chinese format', () => {
      const entities = extractEntities('签订日期2024年3月15日')
      const dates = entities.filter(e => e.type === 'date')
      expect(dates.length).toBeGreaterThanOrEqual(1)
      expect(dates[0].normalized).toBe('2024-03-15')
    })

    it('extracts dates in slash format', () => {
      const entities = extractEntities('有效期至2024/06/30')
      const dates = entities.filter(e => e.type === 'date')
      expect(dates.length).toBeGreaterThanOrEqual(1)
      expect(dates[0].normalized).toBe('2024-06-30')
    })

    it('extracts percentages', () => {
      const entities = extractEntities('违约金比例为5.5%')
      const pcts = entities.filter(e => e.type === 'percentage')
      expect(pcts.length).toBeGreaterThanOrEqual(1)
      expect(pcts[0].normalized).toBe('5.50')
    })

    it('extracts contract IDs', () => {
      const entities = extractEntities('合同编号HT-2024-001')
      const ids = entities.filter(e => e.type === 'contract_id')
      expect(ids.length).toBeGreaterThanOrEqual(1)
    })

    it('extracts person names with suffix', () => {
      const entities = extractEntities('负责人张经理签署')
      const names = entities.filter(e => e.type === 'person_name')
      expect(names.length).toBeGreaterThanOrEqual(1)
      expect(names.some(n => n.normalized.includes('张'))).toBe(true)
    })
  })

  describe('extractEntities - Chinese numbers', () => {
    it('extracts Chinese amount 三十五万元', () => {
      const entities = extractChineseNumberEntities('赔偿金额为三十五万元')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].numericValue).toBe(350000)
    })

    it('extracts Chinese amount 一百二十万元', () => {
      const entities = extractChineseNumberEntities('投资额一百二十万元')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].numericValue).toBe(1200000)
    })

    it('extracts mixed text with Chinese amounts', () => {
      const entities = extractEntities('合同总价三十五万元，首付十万元')
      const amounts = entities.filter(e => e.type === 'amount' && e.subType === 'chinese_number')
      expect(amounts.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('extractEntities - law articles', () => {
    it('extracts simple law article 第38条', () => {
      const entities = extractLawArticleEntities('依据劳动合同法第38条')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].article).toBe(38)
      expect(entities[0].paragraph).toBeUndefined()
    })

    it('extracts law article with paragraph 第26条第1款', () => {
      const entities = extractLawArticleEntities('根据公司法第26条第1款')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].article).toBe(26)
      expect(entities[0].paragraph).toBe(1)
    })

    it('extracts law article with paragraph and item 第47条第1款第2项', () => {
      const entities = extractLawArticleEntities('根据民法典第47条第1款第2项')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].article).toBe(47)
      expect(entities[0].paragraph).toBe(1)
      expect(entities[0].item).toBe(2)
    })
  })

  describe('extractEntities - company names', () => {
    it('extracts 有限公司', () => {
      const entities = extractCompanyNameEntities('甲方为北京星辰科技有限公司')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].raw).toContain('有限公司')
    })

    it('extracts 股份有限公司', () => {
      const entities = extractCompanyNameEntities('投资方为中国建设银行股份有限公司')
      expect(entities.length).toBeGreaterThanOrEqual(1)
      expect(entities[0].raw).toContain('股份有限公司')
    })
  })

  describe('extractEntities - contextual names', () => {
    it('extracts names after 甲方', () => {
      const entities = extractEntities('甲方：张伟，乙方：李明')
      const names = entities.filter(e => e.type === 'person_name' && e.subType === 'contextual')
      expect(names.length).toBeGreaterThanOrEqual(1)
      expect(names.some(n => n.normalized === '张伟')).toBe(true)
    })

    it('extracts names after 法定代表人', () => {
      const entities = extractEntities('法定代表人：王芳')
      const names = entities.filter(e => e.type === 'person_name' && e.subType === 'contextual')
      expect(names.length).toBeGreaterThanOrEqual(1)
      expect(names.some(n => n.normalized === '王芳')).toBe(true)
    })
  })

  describe('extractEntities - bank accounts and ID cards', () => {
    it('extracts bank account numbers', () => {
      const entities = extractEntities('收款账号 6222 0200 0000 1234 567')
      const accounts = entities.filter(e => e.type === 'bank_account')
      expect(accounts.length).toBeGreaterThanOrEqual(1)
    })

    it('extracts ID card numbers', () => {
      const entities = extractEntities('身份证号110101199003076789')
      const ids = entities.filter(e => e.type === 'id_card')
      expect(ids.length).toBeGreaterThanOrEqual(1)
      expect(ids[0].normalized).toBe('110101199003076789')
    })
  })

  describe('extractEntitiesByType', () => {
    it('filters by target types', () => {
      const entities = extractEntitiesByType('金额5000元，日期2024年1月1日', ['amount'])
      expect(entities.every(e => e.type === 'amount')).toBe(true)
    })
  })

  describe('complex text integration', () => {
    it('extracts all entity types from a contract paragraph', () => {
      const text = '甲方北京星辰科技有限公司（法定代表人：张伟）与乙方签订合同编号HT-2024-001，合同金额￥500,000.00元，于2024年3月15日生效，违约金比例为5.5%。依据劳动合同法第38条。'
      const entities = extractEntities(text)
      const types = new Set(entities.map(e => e.type))
      expect(types.has('amount')).toBe(true)
      expect(types.has('date')).toBe(true)
      expect(types.has('percentage')).toBe(true)
      expect(types.has('contract_id')).toBe(true)
      expect(types.has('company_name')).toBe(true)
      expect(types.has('law_article')).toBe(true)
    })
  })
})
