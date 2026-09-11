import type {
  DomainConstraint,
  ConstraintCheckContext,
  ConstraintResult,
  ConstraintReliability,
  ConstraintSource,
  ConstraintApplicability,
  ConstraintTestCase,
  RuleStatus,
  ExtractedEntity
} from '@/models'
import { extractEntities } from './nerExtractor'

const ACTIVE_CONSTRAINTS: DomainConstraint[] = []

function createConstraint(
  id: string,
  domain: DomainConstraint['domain'],
  category: string,
  description: string,
  severity: ConstraintResult['severity'],
  applicability: ConstraintApplicability,
  reliability: ConstraintReliability,
  testCases: ConstraintTestCase[],
  checkFn: (context: ConstraintCheckContext) => ConstraintResult | null,
  automationLevel: 'full' | 'semi' = 'full',
  humanJudgmentPrompt?: string,
  reviewType: 'auto' | 'manual' = 'auto'
): DomainConstraint {
  return {
    id,
    domain,
    category,
    description,
    severity,
    applicability,
    reliability,
    testCases,
    status: 'draft',
    triggerCount: 0,
    falsePositiveCount: 0,
    lastTriggeredAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    automationLevel,
    humanJudgmentPrompt,
    reviewType,
    check: checkFn
  }
}

function makeLawSource(name: string, article: string, effectiveDate: string, originalText?: string): ConstraintSource {
  return {
    type: 'law',
    name,
    article,
    effectiveDate,
    originalText,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function makeRegulationSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'regulation',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

function makeStandardSource(name: string, article: string, effectiveDate: string): ConstraintSource {
  return {
    type: 'standard',
    name,
    article,
    effectiveDate,
    verifiedBy: undefined,
    verifiedAt: undefined
  }
}

const PRC_APPLICABILITY: ConstraintApplicability = { jurisdiction: 'PRC' }

function findEntitiesByType(entities: ExtractedEntity[], type: string): ExtractedEntity[] {
  return entities.filter(e => e.type === type)
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

export const LEGAL_CONSTRAINTS: DomainConstraint[] = [
  createConstraint(
    'legal-labor-contract-written',
    'legal',
    '劳动合同',
    '建立劳动关系应当订立书面劳动合同（劳动合同法第10条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第十条',
        '2008-01-01',
        '建立劳动关系，应当订立书面劳动合同。已建立劳动关系，未同时订立书面劳动合同的，应当自用工之日起一个月内订立书面劳动合同。'
      ),
      caveat: '仅检查是否存在劳动合同相关表述，不判断合同内容的合法性'
    },
    [
      {
        description: '入职满一个月未签劳动合同应触发',
        input: '员工张三于2024年1月1日入职，至今未签订劳动合同',
        expectedTrigger: true,
        expectedMessage: '建立劳动关系应当订立书面劳动合同'
      },
      {
        description: '已签劳动合同不应触发',
        input: '员工李四于2024年1月1日入职，已签订劳动合同',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      if (!hasKeyword(ctx.sourceText, ['入职', '用工', '劳动关系']) && !hasKeyword(ctx.outputText, ['入职', '用工', '劳动关系'])) return null
      const allText = ctx.sourceText + ' ' + ctx.outputText
      const hasContract = hasKeyword(allText, ['劳动合同', '书面合同', '签署合同', '签订合同'])
      const hasNegation = hasKeyword(allText, ['未签订', '未签', '未签署', '没有签订', '未订立'])
      if (!hasContract || hasNegation) {
        return {
          triggered: true,
          constraintId: 'legal-labor-contract-written',
          severity: 'warning',
          message: '建立劳动关系应当订立书面劳动合同（劳动合同法第10条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第十条', '2008-01-01'),
            caveat: '仅检查是否存在劳动合同相关表述'
          },
          matchedEntities: findEntitiesByType(ctx.entities, 'law_article')
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-contract-probation-limit',
    'legal',
    '试用期',
    '劳动合同期限与试用期上限不匹配（劳动合同法第19条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第十九条',
        '2008-01-01',
        '劳动合同期限三个月以上不满一年的，试用期不得超过一个月；劳动合同期限一年以上不满三年的，试用期不得超过二个月；三年以上固定期限和无固定期限的劳动合同，试用期不得超过六个月。'
      )
    },
    [
      {
        description: '一年合同约定3个月试用期应触发',
        input: '劳动合同期限为一年，试用期为三个月',
        expectedTrigger: true,
        expectedMessage: '试用期上限'
      },
      {
        description: '三年合同约定6个月试用期不应触发',
        input: '劳动合同期限为三年，试用期为六个月',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasProbation = hasKeyword(text, ['试用期'])
      if (!hasProbation) return null

      const amounts = findEntitiesByType(ctx.entities, 'amount')
      const yearMatch = text.match(/(\d+)\s*年/)

      let contractYears = 0
      if (yearMatch) contractYears = parseInt(yearMatch[1], 10)
      else {
        const cnYearMatch = text.match(/(一|二|两|三|四|五|六|七|八|九|十|十一|十二)\s*年/)
        if (cnYearMatch) {
          const cnYearMap: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 }
          contractYears = cnYearMap[cnYearMatch[1]] || 0
        }
      }

      const probationMatch = text.match(/试用期[为\d个月一二三四五六七八九十]+/)
      if (!probationMatch) return null

      let probationMonths = 0
      const probationNumMatch = probationMatch[0].match(/(\d+)\s*个月/)
      if (probationNumMatch) probationMonths = parseInt(probationNumMatch[1], 10)
      else {
        const cnMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
        for (const [k, v] of Object.entries(cnMap)) {
          if (probationMatch[0].includes(k)) { probationMonths = v; break }
        }
      }

      if (probationMonths === 0) return null

      let maxProbation = 0
      if (contractYears >= 3) maxProbation = 6
      else if (contractYears >= 1) maxProbation = 2
      else if (contractYears > 0) maxProbation = 1
      else maxProbation = 0

      if (maxProbation > 0 && probationMonths > maxProbation) {
        return {
          triggered: true,
          constraintId: 'legal-labor-contract-probation-limit',
          severity: 'error',
          message: `${contractYears}年期限劳动合同试用期上限为${maxProbation}个月，当前约定${probationMonths}个月，超出法定上限（劳动合同法第19条）`,
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第十九条', '2008-01-01')
          },
          matchedEntities: amounts
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-overtime-limit',
    'legal',
    '加班时长',
    '每月加班不得超过36小时（劳动法第41条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动法',
        '第四十一条',
        '1995-01-01',
        '用人单位由于生产经营需要，经与工会和劳动者协商后可以延长工作时间，一般每日不得超过一小时；因特殊原因需要延长工作时间的，在保障劳动者身体健康的条件下延长工作时间每日不得超过三小时，但是每月不得超过三十六小时。'
      )
    },
    [
      {
        description: '月加班50小时应触发',
        input: '本月加班共计50小时',
        expectedTrigger: true,
        expectedMessage: '每月不得超过36小时'
      },
      {
        description: '月加班20小时不应触发',
        input: '本月加班共计20小时',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const overtimeMatch = text.match(/加班[^\d]*(\d+)\s*小时/)
      if (!overtimeMatch) return null
      const hours = parseInt(overtimeMatch[1], 10)
      if (hours > 36) {
        return {
          triggered: true,
          constraintId: 'legal-labor-overtime-limit',
          severity: 'warning',
          message: `月加班${hours}小时，超过法定上限36小时（劳动法第41条）`,
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动法', '第四十一条', '1995-01-01')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-salary-payment',
    'legal',
    '工资支付',
    '工资应当以货币形式按月支付（劳动法第50条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动法',
        '第五十条',
        '1995-01-01',
        '工资应当以货币形式按月支付给劳动者本人。不得克扣或者无故拖欠劳动者的工资。'
      )
    },
    [
      {
        description: '拖欠工资应触发',
        input: '公司已拖欠员工三个月工资',
        expectedTrigger: true,
        expectedMessage: '不得克扣或者无故拖欠'
      },
      {
        description: '按时支付不应触发',
        input: '公司每月5日按时发放工资',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasArrears = hasKeyword(text, ['拖欠', '克扣', '不发工资', '欠薪', '未支付工资', '未发放工资'])
      if (hasArrears) {
        return {
          triggered: true,
          constraintId: 'legal-labor-salary-payment',
          severity: 'warning',
          message: '工资应当以货币形式按月支付，不得克扣或者无故拖欠（劳动法第50条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动法', '第五十条', '1995-01-01')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-dismiss-protection',
    'legal',
    '解除劳动合同',
    '孕期/产期/哺乳期女职工不得依第40/41条解除（劳动合同法第42条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第四十二条',
        '2008-01-01',
        '女职工在孕期、产期、哺乳期的，用人单位不得依照本法第四十条、第四十一条的规定解除劳动合同。'
      )
    },
    [
      {
        description: '解雇哺乳期女职工应触发',
        input: '公司决定解除哺乳期女职工王某的劳动合同',
        expectedTrigger: true,
        expectedMessage: '不得解除劳动合同'
      },
      {
        description: '正常解雇不应触发',
        input: '公司因员工严重违纪解除劳动合同',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasDismiss = hasKeyword(text, ['解除劳动合同', '辞退', '开除', '解雇', '终止劳动合同']) || (hasKeyword(text, ['解除']) && hasKeyword(text, ['劳动合同']))
      const hasProtection = hasKeyword(text, ['孕期', '产期', '哺乳期', '孕妇', '产妇'])
      if (hasDismiss && hasProtection) {
        return {
          triggered: true,
          constraintId: 'legal-labor-dismiss-protection',
          severity: 'error',
          message: '孕期/产期/哺乳期女职工不得依第40/41条解除劳动合同（劳动合同法第42条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第四十二条', '2008-01-01')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-contract-seal',
    'legal',
    '合同形式',
    '合同应加盖公章或合同专用章（民法典第490条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第四百九十条',
        '2021-01-01',
        '当事人采用合同书形式订立合同的，自当事人均签名、盖章或者按指印时合同成立。'
      ),
      caveat: '仅检查合同文本中是否提及签章，不验证实际签章'
    },
    [
      {
        description: '合同无签章要求应触发',
        input: '本合同一式两份，双方各持一份',
        expectedTrigger: true,
        expectedMessage: '签章'
      },
      {
        description: '合同有签章要求不应触发',
        input: '本合同自双方签字盖章之日起生效',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['合同'])) return null
      const hasSeal = hasKeyword(text, ['盖章', '公章', '合同专用章', '签字盖章', '签章'])
      if (!hasSeal) {
        return {
          triggered: true,
          constraintId: 'legal-contract-seal',
          severity: 'info',
          message: '合同未提及签章/盖章要求，建议确认合同成立要件（民法典第490条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国民法典', '第四百九十条', '2021-01-01'),
            caveat: '仅检查文本表述，不验证实际签章'
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-severance-pay',
    'legal',
    '经济补偿',
    '用人单位解除/终止劳动合同应支付经济补偿的情形（劳动合同法第46条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第四十六条',
        '2008-01-01',
        '有下列情形之一的，用人单位应当向劳动者支付经济补偿：（一）劳动者依照本法第三十八条规定解除劳动合同的；（二）用人单位依照本法第三十六条规定提出解除劳动合同并与劳动者协商一致解除劳动合同的；...'
      )
    },
    [
      {
        description: '协商解除未提补偿应触发',
        input: '公司与员工协商解除劳动合同，未提及经济补偿',
        expectedTrigger: true,
        expectedMessage: '经济补偿'
      },
      {
        description: '正常提及补偿不应触发',
        input: '公司与员工协商解除劳动合同，支付N+1经济补偿',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasDismiss = hasKeyword(text, ['解除劳动合同', '终止劳动合同', '协商解除'])
      if (!hasDismiss) return null
      const hasCompensation = hasKeyword(text, ['经济补偿', '补偿金', 'N+1', '赔偿金', '遣散费'])
      const hasCompNegation = hasKeyword(text, ['未提及', '未支付', '未给予', '没有支付', '没有给予', '未补偿'])
      if (!hasCompensation || hasCompNegation) {
        return {
          triggered: true,
          constraintId: 'legal-labor-severance-pay',
          severity: 'warning',
          message: '解除/终止劳动合同可能需要支付经济补偿，请确认是否适用劳动合同法第46条情形',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第四十六条', '2008-01-01')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-social-insurance',
    'legal',
    '社会保险',
    '用人单位应当为劳动者缴纳社会保险（劳动法第72条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动法',
        '第七十二条',
        '1995-01-01',
        '用人单位和劳动者必须依法参加社会保险，缴纳社会保险费。'
      )
    },
    [
      {
        description: '未缴纳社保应触发',
        input: '公司未为员工缴纳社会保险',
        expectedTrigger: true,
        expectedMessage: '社会保险'
      },
      {
        description: '已缴纳社保不应触发',
        input: '公司依法为员工缴纳五险一金',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasInsuranceKw = hasKeyword(text, ['社会保险', '社保', '五险一金'])
      const hasInsNegation = hasKeyword(text, ['未缴纳', '未缴', '不缴', '未购买', '没有', '未为'])
      const hasNoInsurance = hasKeyword(text, ['未缴纳社保', '未缴社保', '不缴社保', '未缴纳社会保险', '不缴社会保险', '未购买社保', '没有社保']) || (hasInsuranceKw && hasInsNegation)
      if (hasNoInsurance) {
        return {
          triggered: true,
          constraintId: 'legal-labor-social-insurance',
          severity: 'warning',
          message: '用人单位和劳动者必须依法参加社会保险（劳动法第72条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动法', '第七十二条', '1995-01-01')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-minimum-wage',
    'legal',
    '最低工资',
    '工资不得低于当地最低工资标准（劳动法第48条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国劳动法',
        '第四十八条',
        '1995-01-01',
        '国家实行最低工资保障制度。最低工资的具体标准由省、自治区、直辖市人民政府规定，报国务院备案。用人单位支付劳动者的工资不得低于当地最低工资标准。'
      ),
      caveat: '具体最低工资标准因地而异，需结合当地规定判断'
    },
    [
      {
        description: '工资低于2000应触发',
        input: '员工月工资为1500元',
        expectedTrigger: true,
        expectedMessage: '最低工资'
      },
      {
        description: '工资正常不应触发',
        input: '员工月工资为8000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const amounts = findEntitiesByType(ctx.entities, 'amount')
      const text = ctx.sourceText + ' ' + ctx.outputText
      const wageMatch = text.match(/(?:月工资|月薪|工资|月薪)[为是约]?\s*(?:￥|¥)?(\d+)/)
      if (wageMatch) {
        const wage = parseFloat(wageMatch[1])
        if (wage < 2000) {
          return {
            triggered: true,
            constraintId: 'legal-labor-minimum-wage',
            severity: 'error',
            message: `月工资${wage}元可能低于当地最低工资标准，请核实（劳动法第48条）`,
            reliability: {
              confidence: 'medium',
              source: makeLawSource('中华人民共和国劳动法', '第四十八条', '1995-01-01'),
              caveat: '具体标准因地而异，2000元为全国最低参考线'
            },
            matchedEntities: amounts
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-contract-breach-liquidated-damages',
    'legal',
    '违约金',
    '违约金不得过高（民法典第585条，一般不超过实际损失30%）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第五百八十五条',
        '2021-01-01',
        '约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。'
      ),
      caveat: '30%上限为司法实践参考，非法定硬指标'
    },
    [
      {
        description: '违约金为合同金额50%应触发',
        input: '合同金额100万元，违约金为50万元',
        expectedTrigger: true,
        expectedMessage: '违约金'
      },
      {
        description: '违约金为合同金额10%不应触发',
        input: '合同金额100万元，违约金为10万元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['违约金'])) return null
      const contractMatch = text.match(/(?:合同金额|总金额|合同总价)[为是约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
      const penaltyMatch = text.match(/违约金[为是约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
      if (contractMatch && penaltyMatch) {
        const contractVal = parseFloat(contractMatch[1]) * (contractMatch[2] === '万元' || contractMatch[2] === '万' ? 10000 : 1)
        const penaltyVal = parseFloat(penaltyMatch[1]) * (penaltyMatch[2] === '万元' || penaltyMatch[2] === '万' ? 10000 : 1)
        if (contractVal > 0 && penaltyVal / contractVal > 0.3) {
          return {
            triggered: true,
            constraintId: 'legal-contract-breach-liquidated-damages',
            severity: 'warning',
            message: `违约金(${penaltyVal}元)占合同金额(${contractVal}元)的${(penaltyVal / contractVal * 100).toFixed(1)}%，可能过高（民法典第585条，司法实践一般不超过30%）`,
            reliability: {
              confidence: 'medium',
              source: makeLawSource('中华人民共和国民法典', '第五百八十五条', '2021-01-01'),
              caveat: '30%上限为司法实践参考'
            },
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'legal-labor-dispatch-ratio',
    'legal',
    '劳务派遣',
    '劳务派遣用工比例不得超过10%（劳动合同法第66条+劳务派遣暂行规定第4条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第六十六条',
        '2008-01-01',
        '用工单位应当严格控制劳务派遣用工数量，不得超过其用工总量的一定比例，具体比例由国务院劳动行政部门规定。'
      ),
      caveat: '劳务派遣暂行规定明确比例为10%'
    },
    [
      {
        description: '派遣比例15%应触发',
        input: '公司共有员工100人，其中劳务派遣人员15人，派遣比例15%',
        expectedTrigger: true,
        expectedMessage: '10%'
      },
      {
        description: '派遣比例8%不应触发',
        input: '公司共有员工100人，其中劳务派遣人员8人，派遣比例8%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['劳务派遣', '派遣人员', '派遣工'])) return null
      const pctMatch = text.match(/派遣[比例人员]*[约是为]?\s*(\d+(?:\.\d+)?)\s*%/)
      if (pctMatch) {
        const ratio = parseFloat(pctMatch[1])
        if (ratio > 10) {
          return {
            triggered: true,
            constraintId: 'legal-labor-dispatch-ratio',
            severity: 'warning',
            message: `劳务派遣用工比例${ratio}%超过10%法定上限（劳动合同法第66条、劳务派遣暂行规定第4条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国劳动合同法', '第六十六条', '2008-01-01'),
              caveat: '劳务派遣暂行规定明确比例为10%'
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'percentage')
          }
        }
      }
      const amounts = findEntitiesByType(ctx.entities, 'amount')
      if (amounts.length >= 2) {
        const vals = amounts.map(a => parseFloat(a.normalized)).filter(v => v > 0)
        if (vals.length >= 2 && vals[0] > 0) {
          const ratio = vals[1] / vals[0] * 100
          if (ratio > 10) {
            return {
              triggered: true,
              constraintId: 'legal-labor-dispatch-ratio',
              severity: 'warning',
              message: `劳务派遣用工比例${ratio.toFixed(1)}%超过10%法定上限（劳动合同法第66条、劳务派遣暂行规定第4条）`,
              reliability: {
                confidence: 'high',
                source: makeLawSource('中华人民共和国劳动合同法', '第六十六条', '2008-01-01'),
                caveat: '劳务派遣暂行规定明确比例为10%'
              },
              automationLevel: 'full',
              matchedEntities: amounts
            }
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-dispatch-same-pay',
    'legal',
    '劳务派遣',
    '被派遣劳动者享有与用工单位同类岗位劳动者同工同酬权利（劳动合同法第63条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第六十三条',
        '2008-01-01',
        '被派遣劳动者享有与用工单位的劳动者同工同酬的权利。用工单位应当按照同工同酬原则，对被派遣劳动者与本单位同类岗位的劳动者实行相同的工资分配办法。'
      )
    },
    [
      {
        description: '派遣工薪酬低于正式工应触发',
        input: '劳务派遣员工薪酬为5000元，同类岗位正式员工工资8000元',
        expectedTrigger: true,
        expectedMessage: '同工同酬'
      },
      {
        description: '薪酬无差异不应触发',
        input: '劳务派遣员工与正式员工同工同酬，工资均为8000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['派遣', '派遣工', '派遣人员'])) return null
      if (!hasKeyword(text, ['薪酬', '工资', '薪资', '报酬'])) return null
      const hasSamePay = hasKeyword(text, ['同工同酬', '相同', '一致', '均为'])
      if (hasSamePay) return null
      const amounts = findEntitiesByType(ctx.entities, 'amount')
      const hasExplicitDiff = hasKeyword(text, ['不同', '差异', '低于', '差别', '少', '低'])
      if (hasExplicitDiff || amounts.length >= 2) {
        return {
          triggered: true,
          constraintId: 'legal-labor-dispatch-same-pay',
          severity: 'warning',
          message: '被派遣劳动者享有同工同酬权利，用工单位应实行相同工资分配办法（劳动合同法第63条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第六十三条', '2008-01-01')
          },
          automationLevel: 'full',
          matchedEntities: amounts
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-annual-leave',
    'legal',
    '年休假',
    '职工累计工作年限对应年休假天数：1-10年5天、10-20年10天、20年以上15天（职工带薪年休假条例第3条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '职工带薪年休假条例',
        '第三条',
        '2008-01-01',
        '职工累计工作已满1年不满10年的，年休假5天；已满10年不满20年的，年休假10天；已满20年的，年休假15天。国家法定休假日、休息日不计入年休假的假期。'
      )
    },
    [
      {
        description: '工作5年仅3天年假应触发',
        input: '员工累计工作5年，年休假3天',
        expectedTrigger: true,
        expectedMessage: '年休假'
      },
      {
        description: '工作5年5天年假不应触发',
        input: '员工累计工作5年，年休假5天',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['年休假', '年假', '带薪休假'])) return null
      const yearMatch = text.match(/(?:累计)?工作[已满约]?\s*(\d+)\s*年/)
      const dayMatch = text.match(/年休假[为约]?\s*(\d+)\s*天/)
      if (!yearMatch || !dayMatch) return null
      const years = parseInt(yearMatch[1], 10)
      const days = parseInt(dayMatch[1], 10)
      let minDays = 0
      if (years >= 20) minDays = 15
      else if (years >= 10) minDays = 10
      else if (years >= 1) minDays = 5
      if (minDays > 0 && days < minDays) {
        return {
          triggered: true,
          constraintId: 'legal-labor-annual-leave',
          severity: 'warning',
          message: `工作${years}年法定年休假下限为${minDays}天，当前${days}天不符合规定（职工带薪年休假条例第3条）`,
          reliability: {
            confidence: 'high',
            source: makeLawSource('职工带薪年休假条例', '第三条', '2008-01-01')
          },
          automationLevel: 'full',
          matchedEntities: findEntitiesByType(ctx.entities, 'amount')
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-maternity-leave',
    'legal',
    '产假',
    '女职工产假不得少于98天（女职工劳动保护特别规定第7条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '女职工劳动保护特别规定',
        '第七条',
        '2012-04-28',
        '女职工生育享受98天产假，其中产前可以休假15天；难产的，增加产假15天；生育多胞胎的，每多生育1个婴儿，增加产假15天。'
      ),
      caveat: '各地产假延长天数不同，98天为法定最低标准'
    },
    [
      {
        description: '产假60天应触发',
        input: '女职工产假为60天',
        expectedTrigger: true,
        expectedMessage: '98天'
      },
      {
        description: '产假98天不应触发',
        input: '女职工产假为98天',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['产假'])) return null
      const dayMatch = text.match(/产假[为约]?\s*(\d+)\s*天/)
      if (dayMatch) {
        const days = parseInt(dayMatch[1], 10)
        if (days < 98) {
          return {
            triggered: true,
            constraintId: 'legal-labor-maternity-leave',
            severity: 'error',
            message: `产假${days}天低于法定最低98天（女职工劳动保护特别规定第7条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('女职工劳动保护特别规定', '第七条', '2012-04-28'),
              caveat: '各地产假延长天数不同，98天为法定最低标准'
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-work-injury-compensation',
    'legal',
    '工伤',
    '停工留薪期内原工资福利待遇不变（工伤保险条例第33条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '工伤保险条例',
        '第三十三条',
        '2011-01-01',
        '职工因工作遭受事故伤害或者患职业病需要暂停工作接受工伤医疗的，在停工留薪期内，原工资福利待遇不变，由所在单位按月支付。'
      )
    },
    [
      {
        description: '工伤期间降薪应触发',
        input: '员工工伤停工留薪期内公司按最低工资标准发放',
        expectedTrigger: true,
        expectedMessage: '原工资福利待遇不变'
      },
      {
        description: '工伤期间原工资照发不应触发',
        input: '员工工伤停工留薪期内原工资福利待遇不变',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['工伤'])) return null
      if (hasKeyword(text, ['降薪', '扣减', '最低工资', '减少工资', '降低待遇', '按最低'])) {
        return {
          triggered: true,
          constraintId: 'legal-labor-work-injury-compensation',
          severity: 'error',
          message: '停工留薪期内原工资福利待遇不变，不得降薪或按最低工资发放（工伤保险条例第33条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('工伤保险条例', '第三十三条', '2011-01-01')
          },
          automationLevel: 'full',
          matchedEntities: findEntitiesByType(ctx.entities, 'amount')
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-non-compete-scope',
    'legal',
    '竞业限制',
    '竞业限制期限不得超过2年（劳动合同法第24条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第二十四条',
        '2008-01-01',
        '竞业限制的范围、地域、期限由用人单位与劳动者约定，竞业限制的约定不得违反法律、法规的规定。在解除或者终止劳动合同后，前款规定的人员到与本单位生产或者经营同类产品、从事同类业务的有竞争关系的其他用人单位，或者自己开业生产或者经营同类产品、从事同类业务的竞业限制期限，不得超过二年。'
      )
    },
    [
      {
        description: '竞业限制3年应触发',
        input: '离职后竞业限制期限为3年',
        expectedTrigger: true,
        expectedMessage: '2年'
      },
      {
        description: '竞业限制2年不应触发',
        input: '离职后竞业限制期限为2年',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['竞业限制', '竞业禁止'])) return null
      const yearMatch = text.match(/竞业限制[期限为]*[约]?\s*(\d+)\s*年/)
      if (yearMatch) {
        const years = parseInt(yearMatch[1], 10)
        if (years > 2) {
          return {
            triggered: true,
            constraintId: 'legal-labor-non-compete-scope',
            severity: 'error',
            message: `竞业限制期限${years}年超过法定上限2年（劳动合同法第24条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国劳动合同法', '第二十四条', '2008-01-01')
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-non-compete-compensation',
    'legal',
    '竞业限制',
    '竞业限制经济补偿不得低于劳动者离职前十二个月平均工资的30%（最高法司法解释第36条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '最高人民法院关于审理劳动争议案件适用法律问题的解释',
        '第三十六条',
        '2021-01-01',
        '当事人在劳动合同或者保密协议中约定了竞业限制，但未约定解除或者终止劳动合同后给予劳动者经济补偿，劳动者履行了竞业限制义务，要求用人单位按照劳动者在劳动合同解除或者终止前十二个月平均工资的百分之三十按月支付经济补偿的，人民法院应予支持。'
      )
    },
    [
      {
        description: '竞业限制补偿仅20%应触发',
        input: '竞业限制经济补偿为离职前月平均工资的20%',
        expectedTrigger: true,
        expectedMessage: '30%'
      },
      {
        description: '竞业限制补偿50%不应触发',
        input: '竞业限制经济补偿为离职前月平均工资的50%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['竞业限制', '竞业禁止'])) return null
      if (!hasKeyword(text, ['补偿', '经济补偿'])) return null
      const pctMatch = text.match(/(?:平均工资的?)?\s*(\d+(?:\.\d+)?)\s*%/)
      if (pctMatch) {
        const pct = parseFloat(pctMatch[1])
        if (pct < 30) {
          return {
            triggered: true,
            constraintId: 'legal-labor-non-compete-compensation',
            severity: 'warning',
            message: `竞业限制经济补偿${pct}%低于法定下限30%（最高法司法解释第36条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('最高人民法院关于审理劳动争议案件适用法律问题的解释', '第三十六条', '2021-01-01')
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'percentage')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-training-service-period',
    'legal',
    '培训服务期',
    '培训违约金不得超过培训费用（劳动合同法第22条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第二十二条',
        '2008-01-01',
        '用人单位为劳动者提供专项培训费用，对其进行专业技术培训的，可以与该劳动者订立协议，约定服务期。劳动者违反服务期约定的，应当按照约定向用人单位支付违约金。违约金的数额不得超过用人单位提供的培训费用。'
      )
    },
    [
      {
        description: '违约金超培训费应触发',
        input: '公司提供培训费用50000元，约定违约金80000元',
        expectedTrigger: true,
        expectedMessage: '培训费用'
      },
      {
        description: '违约金等于培训费不应触发',
        input: '公司提供培训费用50000元，约定违约金50000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['培训', '培训费'])) return null
      if (!hasKeyword(text, ['违约金'])) return null
      const trainingMatch = text.match(/培训费[用为约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
      const penaltyMatch = text.match(/违约金[为约]?\s*(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
      if (trainingMatch && penaltyMatch) {
        const trainingVal = parseFloat(trainingMatch[1]) * (trainingMatch[2] === '万元' || trainingMatch[2] === '万' ? 10000 : 1)
        const penaltyVal = parseFloat(penaltyMatch[1]) * (penaltyMatch[2] === '万元' || penaltyMatch[2] === '万' ? 10000 : 1)
        if (penaltyVal > trainingVal) {
          return {
            triggered: true,
            constraintId: 'legal-labor-training-service-period',
            severity: 'error',
            message: `培训违约金${penaltyVal}元超过培训费用${trainingVal}元，超出部分无效（劳动合同法第22条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国劳动合同法', '第二十二条', '2008-01-01')
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-contract-standard-clause-invalid',
    'legal',
    '格式条款',
    '格式条款中免除己方责任、加重对方责任的条款无效（民法典第497条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第四百九十七条',
        '2021-01-01',
        '有下列情形之一的，该格式条款无效：（一）提供格式条款一方不合理地免除或者减轻其责任、加重对方责任、限制对方主要权利；（二）提供格式条款一方排除对方主要权利。'
      )
    },
    [
      {
        description: '格式条款概不负责应触发',
        input: '本格式条款规定：本公司概不负责，不承担任何责任',
        expectedTrigger: true,
        expectedMessage: '格式条款'
      },
      {
        description: '正常格式条款不应触发',
        input: '本标准合同条款经双方协商一致确认',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['格式条款', '标准合同', '格式合同'])) return null
      if (hasKeyword(text, ['概不负责', '不承担任何责任', '免除一切责任', '完全免责'])) {
        return {
          triggered: true,
          constraintId: 'legal-contract-standard-clause-invalid',
          severity: 'error',
          message: '格式条款中不合理免责条款无效（民法典第497条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国民法典', '第四百九十七条', '2021-01-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-contract-guarantee-type',
    'legal',
    '保证方式',
    '未明确保证方式默认为一般保证（民法典第686条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第六百八十六条',
        '2021-01-01',
        '保证的方式包括一般保证和连带责任保证。当事人在保证合同中对保证方式没有约定或者约定不明确的，按照一般保证承担保证责任。'
      )
    },
    [
      {
        description: '保证未明确方式应触发',
        input: '甲方为乙方提供保证担保',
        expectedTrigger: true,
        expectedMessage: '一般保证'
      },
      {
        description: '明确连带保证不应触发',
        input: '甲方为乙方提供连带责任保证',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['保证', '担保'])) return null
      const hasType = hasKeyword(text, ['连带', '连带责任保证', '一般保证'])
      if (!hasType) {
        return {
          triggered: true,
          constraintId: 'legal-contract-guarantee-type',
          severity: 'info',
          message: '未明确保证方式，依法默认为一般保证（民法典第686条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国民法典', '第六百八十六条', '2021-01-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-contract-limitation-period',
    'legal',
    '诉讼时效',
    '诉讼时效期间为3年，约定超过3年的无效（民法典第188条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第一百八十八条',
        '2021-01-01',
        '向人民法院请求保护民事权利的诉讼时效期间为三年。诉讼时效期间自权利人知道或者应当知道权利受到损害以及义务人之日起计算。法律另有规定的，依照其规定。'
      ),
      caveat: '当事人约定延长或缩短诉讼时效的约定无效'
    },
    [
      {
        description: '约定诉讼时效5年应触发',
        input: '双方约定诉讼时效为5年',
        expectedTrigger: true,
        expectedMessage: '3年'
      },
      {
        description: '正常诉讼时效3年不应触发',
        input: '依法诉讼时效为3年',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['诉讼时效'])) return null
      const yearMatch = text.match(/诉讼时效[为约]?\s*(\d+)\s*年/)
      if (yearMatch) {
        const years = parseInt(yearMatch[1], 10)
        if (years > 3) {
          return {
            triggered: true,
            constraintId: 'legal-contract-limitation-period',
            severity: 'warning',
            message: `约定诉讼时效${years}年，超过法定3年，该约定无效（民法典第188条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国民法典', '第一百八十八条', '2021-01-01'),
              caveat: '当事人约定延长诉讼时效的约定无效'
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-ip-copyright-work-for-hire',
    'legal',
    '职务作品',
    '职务作品作者享有署名权，单位可享有其他著作权（著作权法第18条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国著作权法',
        '第十八条',
        '2021-06-01',
        '自然人为完成法人或者非法人组织工作任务所创作的作品是职务作品，作者享有署名权，著作权的其他权利由法人或者非法人组织享有。'
      )
    },
    [
      {
        description: '职务作品放弃署名权应触发',
        input: '本职务作品作者放弃署名权，全部著作权归公司所有',
        expectedTrigger: true,
        expectedMessage: '署名权'
      },
      {
        description: '职务作品保留署名权不应触发',
        input: '本职务作品作者保留署名权，其他著作权归单位',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['职务作品'])) return null
      if (hasKeyword(text, ['全部著作权', '放弃署名', '不享有署名', '无署名权'])) {
        return {
          triggered: true,
          constraintId: 'legal-ip-copyright-work-for-hire',
          severity: 'warning',
          message: '职务作品作者享有署名权，不得要求放弃（著作权法第18条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国著作权法', '第十八条', '2021-06-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-consumer-triple-damages',
    'legal',
    '消费者欺诈',
    '经营者欺诈应三倍赔偿，不足500元按500元计（消费者权益保护法第55条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国消费者权益保护法',
        '第五十五条',
        '2014-03-15',
        '经营者提供商品或者服务有欺诈行为的，应当按照消费者的要求增加赔偿其受到的损失，增加赔偿的金额为消费者购买商品的价款或者接受服务的费用的三倍；增加赔偿的金额不足五百元的，为五百元。'
      )
    },
    [
      {
        description: '欺诈赔偿低于三倍应触发',
        input: '商家欺诈行为仅赔偿消费者商品原价1000元',
        expectedTrigger: true,
        expectedMessage: '三倍'
      },
      {
        description: '欺诈三倍赔偿不应触发',
        input: '商家欺诈行为按消费者购买价款的三倍赔偿3000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['欺诈', '欺诈行为'])) return null
      if (!hasKeyword(text, ['赔偿', '补偿'])) return null
      const hasTriple = hasKeyword(text, ['三倍', '3倍', '三倍赔偿'])
      if (!hasTriple) {
        return {
          triggered: true,
          constraintId: 'legal-consumer-triple-damages',
          severity: 'warning',
          message: '经营者欺诈应三倍赔偿，不足500元按500元计（消费者权益保护法第55条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国消费者权益保护法', '第五十五条', '2014-03-15')
          },
          automationLevel: 'full',
          matchedEntities: findEntitiesByType(ctx.entities, 'amount')
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-consumer-seven-day-return',
    'legal',
    '网购退货',
    '网购商品7天无理由退货（消费者权益保护法第25条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国消费者权益保护法',
        '第二十五条',
        '2014-03-15',
        '经营者采用网络、电视、电话、邮购等方式销售商品，消费者有权自收到商品之日起七日内退货，且无需说明理由。'
      ),
      caveat: '定制商品、鲜活易腐等除外'
    },
    [
      {
        description: '网购不支持退货应触发',
        input: '网购商品不支持7天无理由退货',
        expectedTrigger: true,
        expectedMessage: '7天'
      },
      {
        description: '支持7天退货不应触发',
        input: '网购商品支持7天无理由退货',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['网购', '网络购物', '线上购买'])) return null
      if (hasKeyword(text, ['不支持退货', '不可退货', '不支持7天', '不予退换', '不退不换'])) {
        return {
          triggered: true,
          constraintId: 'legal-consumer-seven-day-return',
          severity: 'error',
          message: '网购商品消费者有权7天无理由退货，不支持退货的约定无效（消费者权益保护法第25条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国消费者权益保护法', '第二十五条', '2014-03-15'),
            caveat: '定制商品、鲜活易腐等除外'
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-housing-deposit-limit',
    'legal',
    '租赁押金',
    '租赁押金超过2个月租金可能存在不合理条款（司法实践参考）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'low',
      source: makeLawSource(
        '司法实践参考',
        '各地法院裁判标准（无直接法条）',
        '2021-01-01',
        '租赁押金上限2个月租金为各地司法实践常见标准，非民法典直接规定'
      ),
      caveat: '2个月上限为部分地方法院裁判参考标准，非全国统一规定'
    },
    [
      {
        description: '押金为3个月租金应触发',
        input: '租赁押金为3个月租金共9000元',
        expectedTrigger: true,
        expectedMessage: '2个月'
      },
      {
        description: '押金为1个月租金不应触发',
        input: '租赁押金为1个月租金共3000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['押金', '租赁'])) return null
      const monthMatch = text.match(/押金[为约]?\s*(\d+)\s*个月?\s*(?:租金)?/)
      if (monthMatch) {
        const months = parseInt(monthMatch[1], 10)
        if (months > 2) {
          return {
            triggered: true,
            constraintId: 'legal-housing-deposit-limit',
            severity: 'warning',
            message: `租赁押金${months}个月租金超过通常2个月上限，可能存在不合理条款（司法实践参考）`,
            reliability: {
              confidence: 'low',
              source: makeLawSource('司法实践参考', '各地法院裁判标准（无直接法条）', '2021-01-01'),
              caveat: '2个月上限为部分地方法院裁判参考标准，非全国统一规定'
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-housing-lease-term-limit',
    'legal',
    '租赁期限',
    '租赁期限不得超过20年（民法典第705条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第七百零五条',
        '2021-01-01',
        '租赁期限不得超过二十年。超过二十年的，超过部分无效。租赁期限届满，当事人可以续订租赁合同；但是，约定的租赁期限自续订之日起不得超过二十年。'
      )
    },
    [
      {
        description: '租赁期限30年应触发',
        input: '房屋租赁期限为30年',
        expectedTrigger: true,
        expectedMessage: '20年'
      },
      {
        description: '租赁期限20年不应触发',
        input: '房屋租赁期限为20年',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['租赁'])) return null
      const yearMatch = text.match(/租赁期限[为约]?\s*(\d+)\s*年/)
      if (yearMatch) {
        const years = parseInt(yearMatch[1], 10)
        if (years > 20) {
          return {
            triggered: true,
            constraintId: 'legal-housing-lease-term-limit',
            severity: 'error',
            message: `租赁期限${years}年超过法定上限20年，超过部分无效（民法典第705条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国民法典', '第七百零五条', '2021-01-01')
            },
            automationLevel: 'full',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-housing-sale-does-not-break-lease',
    'legal',
    '买卖不破租赁',
    '租赁物所有权变动不影响租赁合同效力（民法典第725条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第七百二十五条',
        '2021-01-01',
        '租赁物在承租人按照租赁合同占有期限内发生所有权变动的，不影响租赁合同的效力。'
      )
    },
    [
      {
        description: '出售房屋终止租赁应触发',
        input: '房东出售房屋后终止租赁合同',
        expectedTrigger: true,
        expectedMessage: '买卖不破租赁'
      },
      {
        description: '出售房屋不影响租赁不应触发',
        input: '房东出售房屋但租赁合同继续有效',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['出售', '转让', '买卖'])) return null
      if (!hasKeyword(text, ['租赁'])) return null
      if (hasKeyword(text, ['终止租赁', '解除租赁', '终止合同', '解除合同'])) {
        return {
          triggered: true,
          constraintId: 'legal-housing-sale-does-not-break-lease',
          severity: 'error',
          message: '买卖不破租赁，房屋所有权变动不影响租赁合同效力（民法典第725条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国民法典', '第七百二十五条', '2021-01-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-securities-insider-trading',
    'legal',
    '内幕交易',
    '禁止利用内幕信息进行证券交易（证券法第53条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国证券法',
        '第五十三条',
        '2020-03-01',
        '证券交易内幕信息的知情人和非法获取内幕信息的人，在内幕信息公开前，不得买卖该公司的证券，或者泄露该信息，或者建议他人买卖该证券。'
      )
    },
    [
      {
        description: '内幕信息买入股票应触发',
        input: '利用未公开的内幕信息买入公司股票',
        expectedTrigger: true,
        expectedMessage: '内幕交易'
      },
      {
        description: '正常交易不应触发',
        input: '基于公开信息买入公司股票',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['内幕', '未公开', '未披露'])) return null
      if (hasKeyword(text, ['买入', '卖出', '交易'])) {
        return {
          triggered: true,
          constraintId: 'legal-securities-insider-trading',
          severity: 'error',
          message: '禁止利用内幕信息进行证券交易（证券法第53条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国证券法', '第五十三条', '2020-03-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-tax-individual-income-tax',
    'legal',
    '个人所得税',
    '个人所得税税率3%-45%（个人所得税法第2条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国个人所得税法',
        '第二条',
        '2019-01-01',
        '下列各项个人所得，应当缴纳个人所得税：（一）工资、薪金所得；（二）劳务报酬所得；（三）稿酬所得；（四）特许权使用费所得；（五）经营所得；（六）利息、股息、红利所得；（七）财产租赁所得；（八）财产转让所得；（九）偶然所得。'
      ),
      caveat: '综合所得适用3%-45%超额累进税率'
    },
    [
      {
        description: '个税率50%应触发',
        input: '个人所得税税率为50%',
        expectedTrigger: true,
        expectedMessage: '45%'
      },
      {
        description: '个税率30%不应触发',
        input: '个人所得税税率为30%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['个税', '个人所得税'])) return null
      const percentages = findEntitiesByType(ctx.entities, 'percentage')
      for (const pct of percentages) {
        const val = parseFloat(pct.normalized)
        if (val > 45 || val < 3) {
          return {
            triggered: true,
            constraintId: 'legal-tax-individual-income-tax',
            severity: 'warning',
            message: `个人所得税税率${val}%超出法定3%-45%范围（个人所得税法第2条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国个人所得税法', '第二条', '2019-01-01'),
              caveat: '综合所得适用3%-45%超额累进税率'
            },
            automationLevel: 'full',
            matchedEntities: [pct]
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-tax-corporate-income-tax',
    'legal',
    '企业所得税',
    '企业所得税税率25%，高新技术企业15%，小型微利企业20%（企业所得税法第4条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国企业所得税法',
        '第四条',
        '2008-01-01',
        '企业所得税的税率为25％。非居民企业取得本法第三条第三款规定的所得，适用税率为20％。'
      ),
      caveat: '高新技术企业15%，小型微利企业20%为优惠税率'
    },
    [
      {
        description: '企业所得税率30%应触发',
        input: '企业所得税税率为30%',
        expectedTrigger: true,
        expectedMessage: '25%'
      },
      {
        description: '企业所得税率25%不应触发',
        input: '企业所得税税率为25%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['企业所得税'])) return null
      if (hasKeyword(text, ['高新', '高新技术企业', '小微', '小型微利'])) return null
      const percentages = findEntitiesByType(ctx.entities, 'percentage')
      for (const pct of percentages) {
        const val = parseFloat(pct.normalized)
        if (val > 25) {
          return {
            triggered: true,
            constraintId: 'legal-tax-corporate-income-tax',
            severity: 'warning',
            message: `企业所得税税率${val}%超过法定25%（企业所得税法第4条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国企业所得税法', '第四条', '2008-01-01'),
              caveat: '高新技术企业15%，小型微利企业20%为优惠税率'
            },
            automationLevel: 'full',
            matchedEntities: [pct]
          }
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-tax-invoice-obligation',
    'legal',
    '发票',
    '经营者不得拒绝开具发票（税收征收管理法第21条）',
    'error',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国税收征收管理法',
        '第二十一条',
        '2015-02-28',
        '单位、个人在购销商品、提供或者接受经营服务以及从事其他经营活动中，应当按照规定开具、使用、取得发票。'
      )
    },
    [
      {
        description: '不开票优惠应触发',
        input: '不要发票可享受优惠，商家不开票给优惠',
        expectedTrigger: true,
        expectedMessage: '发票'
      },
      {
        description: '正常开票不应触发',
        input: '消费后商家依法开具发票',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (hasKeyword(text, ['不开票', '拒开', '无票', '不给发票', '不开发票']) && hasKeyword(text, ['优惠', '折扣', '便宜', '减价'])) {
        return {
          triggered: true,
          constraintId: 'legal-tax-invoice-obligation',
          severity: 'error',
          message: '经营者不得以优惠等理由拒绝开具发票（税收征收管理法第21条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国税收征收管理法', '第二十一条', '2015-02-28')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-corporate-director-duty',
    'legal',
    '董事义务',
    '董事、高管负有忠实勤勉义务（公司法第147条）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国公司法',
        '第一百四十七条',
        '2024-07-01',
        '董事、监事、高级管理人员应当遵守法律、行政法规和公司章程，对公司负有忠实义务和勤勉义务。'
      )
    },
    [
      {
        description: '董事自我交易应触发',
        input: '董事利用职务便利进行自我交易谋取私利',
        expectedTrigger: true,
        expectedMessage: '忠实义务'
      },
      {
        description: '正常履职不应触发',
        input: '董事依法勤勉履职，为公司利益决策',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['董事', '高管', '高级管理人员'])) return null
      if (hasKeyword(text, ['自我交易', '利益冲突', '关联交易', '挪用', '侵占', '私利', '谋取'])) {
        return {
          triggered: true,
          constraintId: 'legal-corporate-director-duty',
          severity: 'warning',
          message: '董事、高管负有忠实勤勉义务，不得利用职权谋取私利（公司法第147条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国公司法', '第一百四十七条', '2024-07-01')
          },
          automationLevel: 'full'
        }
      }
      return null
    },
    'full',
    undefined,
    'auto'
  ),

  createConstraint(
    'legal-labor-work-injury-report',
    'legal',
    '工伤申报',
    '用人单位应在30日内提出工伤认定申请（工伤保险条例第17条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '工伤保险条例',
        '第十七条',
        '2011-01-01',
        '职工发生事故伤害或者按照职业病防治法规定被诊断、鉴定为职业病，所在单位应当自事故伤害发生之日或者被诊断、鉴定为职业病之日起30日内，向统筹地区社会保险行政部门提出工伤认定申请。'
      )
    },
    [
      {
        description: '工伤60日后申报应触发',
        input: '员工发生工伤后60日才申报认定',
        expectedTrigger: true,
        expectedMessage: '30日'
      },
      {
        description: '工伤10日内申报不应触发',
        input: '员工发生工伤后10日内申报认定',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['工伤'])) return null
      if (!hasKeyword(text, ['申报', '认定', '申请'])) return null
      const dayMatch = text.match(/(\d+)\s*日[后以]?/)
      if (dayMatch) {
        const days = parseInt(dayMatch[1], 10)
        if (days > 30) {
          return {
            triggered: true,
            constraintId: 'legal-labor-work-injury-report',
            severity: 'info',
            message: `工伤${days}日后申报，超过30日法定期限（工伤保险条例第17条）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('工伤保险条例', '第十七条', '2011-01-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '请确认：是否在30日内申报工伤？',
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    },
    'semi',
    '请确认：是否在30日内申报工伤？',
    'auto'
  ),

  createConstraint(
    'legal-labor-collective-contract',
    'legal',
    '集体合同',
    '集体合同应经职工代表大会讨论通过（劳动合同法第51条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国劳动合同法',
        '第五十一条',
        '2008-01-01',
        '企业职工一方与用人单位通过平等协商，可以就劳动报酬、工作时间、休息休假、劳动安全卫生、保险福利等事项订立集体合同。集体合同草案应当提交职工代表大会或者全体职工讨论通过。'
      )
    },
    [
      {
        description: '集体合同未经职代会讨论应触发',
        input: '公司签订集体合同，未经职工代表大会讨论',
        expectedTrigger: true,
        expectedMessage: '职工代表大会'
      },
      {
        description: '集体合同经职代会通过不应触发',
        input: '公司集体合同草案经职工代表大会讨论通过',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['集体合同'])) return null
      const hasPassed = hasKeyword(text, ['讨论通过', '审议通过', '表决通过'])
      const hasNegative = hasKeyword(text, ['未经', '未提交', '未讨论', '未审议', '未经过'])
      if (hasNegative || !hasPassed) {
        return {
          triggered: true,
          constraintId: 'legal-labor-collective-contract',
          severity: 'info',
          message: '集体合同草案应提交职工代表大会或全体职工讨论通过（劳动合同法第51条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国劳动合同法', '第五十一条', '2008-01-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请确认：集体合同是否经职工代表大会讨论通过？'
        }
      }
      return null
    },
    'semi',
    '请确认：集体合同是否经职工代表大会讨论通过？',
    'auto'
  ),

  createConstraint(
    'legal-contract-standard-clause',
    'legal',
    '格式条款提示',
    '格式条款中免责条款应采取合理方式提示说明（民法典第496条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第四百九十六条',
        '2021-01-01',
        '提供格式条款的一方应当遵循公平原则确定当事人之间的权利和义务，并采取合理的方式提示对方注意免除或者减轻其责任等与对方有重大利害关系的条款，按照对方的要求，对该条款予以说明。'
      )
    },
    [
      {
        description: '格式条款免责未提示应触发',
        input: '本格式条款包含免责条款，未加粗提示',
        expectedTrigger: true,
        expectedMessage: '提示说明'
      },
      {
        description: '格式条款已提示说明不应触发',
        input: '本格式条款免责部分已加粗提示并经对方确认',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['格式条款', '标准合同', '格式合同'])) return null
      if (hasKeyword(text, ['免责', '减轻'])) {
        const hasNegative = hasKeyword(text, ['未提示', '未说明', '未加粗', '未标红', '未提醒', '未标注'])
        const hasAffirmative = hasKeyword(text, ['已提示', '已说明', '已加粗', '已标红', '已确认', '经对方确认'])
        if (hasNegative || !hasAffirmative) {
          return {
            triggered: true,
            constraintId: 'legal-contract-standard-clause',
            severity: 'info',
            message: '格式条款中免责/减轻责任条款应采取合理方式提示说明（民法典第496条）',
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国民法典', '第四百九十六条', '2021-01-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '请确认：格式条款中是否有免责条款的提示说明？'
          }
        }
      }
      return null
    },
    'semi',
    '请确认：格式条款中是否有免责条款的提示说明？',
    'auto'
  ),

  createConstraint(
    'legal-contract-guarantee-period',
    'legal',
    '保证期间',
    '未约定保证期间默认为主债务履行期届满之日起6个月（民法典第692条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第六百九十二条',
        '2021-01-01',
        '保证期间是确定保证人承担保证责任的期间，不发生中止、中断和延长。债权人与保证人可以约定保证期间，但是约定的保证期间早于主债务履行期限或者与主债务履行期限同时届满的，视为没有约定；没有约定或者约定不明确的，保证期间为主债务履行期限届满之日起六个月。'
      )
    },
    [
      {
        description: '保证未约定期间应触发',
        input: '甲方为乙方提供保证担保，未约定保证期间',
        expectedTrigger: true,
        expectedMessage: '6个月'
      },
      {
        description: '已约定保证期间不应触发',
        input: '甲方为乙方提供保证担保，保证期间为主债务届满之日起2年',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['保证', '担保'])) return null
      const hasPeriodMention = hasKeyword(text, ['保证期间', '担保期限', '保证期限'])
      const hasNoPeriod = hasKeyword(text, ['未约定', '未约定保证', '没有约定', '未规定'])
      const hasExplicitPeriod = hasKeyword(text, ['保证期间为', '担保期限为', '保证期限为', '届满之日起', '保证期至'])
      if (hasNoPeriod || (!hasExplicitPeriod && !hasPeriodMention)) {
        return {
          triggered: true,
          constraintId: 'legal-contract-guarantee-period',
          severity: 'info',
          message: '未约定保证期间，依法默认为主债务履行期届满之日起6个月（民法典第692条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国民法典', '第六百九十二条', '2021-01-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请确认：是否约定了保证期间？未约定则默认6个月'
        }
      }
      return null
    },
    'semi',
    '请确认：是否约定了保证期间？未约定则默认6个月',
    'auto'
  ),

  createConstraint(
    'legal-ip-patent-employee-reward',
    'legal',
    '职务发明奖励',
    '职务发明创造应给予发明人奖励（专利法第15条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国专利法',
        '第十五条',
        '2021-06-01',
        '被授予专利权的单位应当对职务发明创造的发明人或者设计人给予奖励；发明创造专利实施后，根据其推广应用的范围和取得的经济效益，对发明人或者设计人给予合理的报酬。'
      )
    },
    [
      {
        description: '职务发明未约定奖励应触发',
        input: '本职务发明创造由公司申请专利，未约定发明人奖励',
        expectedTrigger: true,
        expectedMessage: '奖励'
      },
      {
        description: '职务发明已约定奖励不应触发',
        input: '本职务发明创造公司给予发明人奖励和报酬',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['职务发明', '发明创造'])) return null
      const hasNoReward = hasKeyword(text, ['未约定奖励', '未约定报酬', '未给予奖励', '未支付报酬', '未约定发明人奖励'])
      const hasReward = hasKeyword(text, ['给予奖励', '支付报酬', '约定奖励', '给予发明人奖励'])
      if (hasNoReward || !hasReward) {
        return {
          triggered: true,
          constraintId: 'legal-ip-patent-employee-reward',
          severity: 'info',
          message: '职务发明创造应给予发明人奖励和报酬（专利法第15条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国专利法', '第十五条', '2021-06-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请确认：职务发明是否约定了发明人奖励？'
        }
      }
      return null
    },
    'semi',
    '请确认：职务发明是否约定了发明人奖励？',
    'auto'
  ),

  createConstraint(
    'legal-consumer-personal-info-protection',
    'legal',
    '个人信息保护',
    '收集个人信息应遵循最小必要原则（个人信息保护法第5条+第6条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国个人信息保护法',
        '第五条',
        '2021-11-01',
        '处理个人信息应当遵循合法、正当、必要和诚信原则，不得通过误导、欺诈、胁迫等方式处理个人信息。'
      ),
      caveat: '第六条要求最小必要原则，不得过度收集'
    },
    [
      {
        description: '收集身份证和通讯录应触发',
        input: '注册App需收集用户身份证号和通讯录',
        expectedTrigger: true,
        expectedMessage: '最小必要'
      },
      {
        description: '仅收集手机号不应触发',
        input: '注册App仅收集用户手机号用于验证',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['收集'])) return null
      if (hasKeyword(text, ['身份证', '银行', '通讯录', '位置', '人脸', '指纹', '行踪'])) {
        return {
          triggered: true,
          constraintId: 'legal-consumer-personal-info-protection',
          severity: 'info',
          message: '收集敏感个人信息应遵循最小必要原则，不得过度收集（个人信息保护法第5条、第6条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国个人信息保护法', '第五条', '2021-11-01'),
            caveat: '第六条要求最小必要原则，不得过度收集'
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请确认：收集的个人信息是否遵循最小必要原则？'
        }
      }
      return null
    },
    'semi',
    '请确认：收集的个人信息是否遵循最小必要原则？',
    'auto'
  ),

  createConstraint(
    'legal-corporate-capital-contribution',
    'legal',
    '出资义务',
    '股东应按期足额缴纳出资（公司法第28条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国公司法',
        '第二十八条',
        '2024-07-01',
        '股东应当按期足额缴纳公司章程规定的各自所认缴的出资额。股东以货币出资的，应当将货币出资足额存入有限责任公司在银行开设的账户；以非货币财产出资的，应当依法办理其财产权的转移手续。'
      )
    },
    [
      {
        description: '出资未到位应触发',
        input: '股东认缴出资100万元，但出资未到位',
        expectedTrigger: true,
        expectedMessage: '出资'
      },
      {
        description: '按时足额出资不应触发',
        input: '股东已按期足额缴纳认缴出资100万元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['出资'])) return null
      if (hasKeyword(text, ['未到位', '延期', '欠缴', '未缴纳', '未缴足'])) {
        return {
          triggered: true,
          constraintId: 'legal-corporate-capital-contribution',
          severity: 'info',
          message: '股东应按期足额缴纳出资，未到位需承担相应责任（公司法第28条）',
          reliability: {
            confidence: 'high',
            source: makeLawSource('中华人民共和国公司法', '第二十八条', '2024-07-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请确认：是否存在出资未到位的情况？延期出资是否经股东会同意？',
          matchedEntities: findEntitiesByType(ctx.entities, 'amount')
        }
      }
      return null
    },
    'semi',
    '请确认：是否存在出资未到位的情况？延期出资是否经股东会同意？',
    'auto'
  ),

  createConstraint(
    'legal-dispute-limitation-check',
    'legal',
    '诉讼时效适用',
    '人民法院不得主动适用诉讼时效（民法典第193条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第一百九十三条',
        '2021-01-01',
        '人民法院不得主动适用诉讼时效的规定。'
      )
    },
    [
      {
        description: '法院主动认定时效过期应触发',
        input: '法院认定诉讼时效已过，裁定驳回',
        expectedTrigger: true,
        expectedMessage: '主动适用'
      },
      {
        description: '被告提出时效抗辩不应触发',
        input: '被告提出诉讼时效抗辩，法院审查后驳回原告请求',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['法院', '人民法院'])) return null
      if (!hasKeyword(text, ['诉讼时效'])) return null
      if (!hasKeyword(text, ['认定', '裁定', '驳回'])) return null
      if (hasKeyword(text, ['过期', '已过', '届满'])) {
        const hasDefendant = hasKeyword(text, ['被告', '抗辩', '主张'])
        if (!hasDefendant) {
          return {
            triggered: true,
            constraintId: 'legal-dispute-limitation-check',
            severity: 'info',
            message: '人民法院不得主动适用诉讼时效，应由被告提出抗辩（民法典第193条）',
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国民法典', '第一百九十三条', '2021-01-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '请确认：诉讼时效是否由被告主动提出抗辩？'
          }
        }
      }
      return null
    },
    'semi',
    '请确认：诉讼时效是否由被告主动提出抗辩？',
    'auto'
  ),

  createConstraint(
    'legal-contract-formation-offer-acceptance',
    'legal',
    '要约',
    '要约内容应当具体确定（民法典第472条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第四百七十二条',
        '2021-01-01',
        '要约是希望与他人订立合同的意思表示，该意思表示应当符合下列条件：（一）内容具体确定；（二）表明经受要约人承诺，要约人即受该意思表示约束。'
      )
    },
    [
      {
        description: '要约缺少价格应触发',
        input: '本要约为购买商品的意思表示，但未约定价格和数量',
        expectedTrigger: true,
        expectedMessage: '具体确定'
      },
      {
        description: '要约内容完整不应触发',
        input: '本要约约定购买100件商品，单价50元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['要约'])) return null
      const hasNoKeyTerms = hasKeyword(text, ['未约定价格', '未约定数量', '缺少价格', '缺少数量', '未约定金额', '缺少金额'])
      const hasKeyTerms = hasKeyword(text, ['单价', '总价', '价格为', '金额为', '数量为'])
      if (hasNoKeyTerms || !hasKeyTerms) {
        return {
          triggered: true,
          constraintId: 'legal-contract-formation-offer-acceptance',
          severity: 'info',
          message: '要约内容应具体确定，缺少价格/金额/数量等关键要素（民法典第472条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国民法典', '第四百七十二条', '2021-01-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请人工审查：要约内容是否具体确定？'
        }
      }
      return null
    },
    'semi',
    '请人工审查：要约内容是否具体确定？',
    'auto'
  ),

  createConstraint(
    'legal-contract-simultaneous-performance',
    'legal',
    '同时履行',
    '一方未履行前对方有权拒绝其履行请求（民法典第525条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第五百二十五条',
        '2021-01-01',
        '当事人互负债务，没有先后履行顺序的，应当同时履行。一方在对方履行之前有权拒绝其履行请求。一方在对方履行债务不符合约定时，有权拒绝其相应的履行请求。'
      )
    },
    [
      {
        description: '同时履行一方未履行应触发',
        input: '双方应同时履行交货与付款义务，但一方未交付',
        expectedTrigger: true,
        expectedMessage: '同时履行'
      },
      {
        description: '先后履行顺序明确不应触发',
        input: '甲方先交付货物，乙方后支付货款',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['同时履行', '同时交付'])) return null
      return {
        triggered: true,
        constraintId: 'legal-contract-simultaneous-performance',
        severity: 'info',
        message: '同时履行抗辩权：一方未履行时对方有权拒绝（民法典第525条）',
        reliability: {
          confidence: 'medium',
          source: makeLawSource('中华人民共和国民法典', '第五百二十五条', '2021-01-01')
        },
        automationLevel: 'semi',
        requiresHumanConfirmation: true,
        humanJudgmentPrompt: '请人工审查：双方是否应同时履行？一方未履行时对方是否有权拒绝？'
      }
    },
    'semi',
    '请人工审查：双方是否应同时履行？一方未履行时对方是否有权拒绝？',
    'auto'
  ),

  createConstraint(
    'legal-contract-termination-notice',
    'legal',
    '合同解除通知',
    '解除合同应当通知对方（民法典第565条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第五百六十五条',
        '2021-01-01',
        '当事人一方依法主张解除合同的，应当通知对方。合同自通知到达对方时解除。'
      )
    },
    [
      {
        description: '解除合同未通知应触发',
        input: '一方解除合同协议，但未通知对方',
        expectedTrigger: true,
        expectedMessage: '通知'
      },
      {
        description: '解除合同已通知不应触发',
        input: '一方解除合同并已书面通知对方',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['解除合同', '解除协议'])) return null
      const hasNoNotice = hasKeyword(text, ['未通知', '未告知', '未送达', '未书面通知'])
      const hasNotice = hasKeyword(text, ['已通知', '已告知', '已送达', '已书面通知', '书面通知对方'])
      if (hasNoNotice || !hasNotice) {
        return {
          triggered: true,
          constraintId: 'legal-contract-termination-notice',
          severity: 'info',
          message: '解除合同应通知对方，合同自通知到达对方时解除（民法典第565条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国民法典', '第五百六十五条', '2021-01-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请人工审查：合同解除是否已通知对方？'
        }
      }
      return null
    },
    'semi',
    '请人工审查：合同解除是否已通知对方？',
    'auto'
  ),

  createConstraint(
    'legal-ip-copyright-ownership',
    'legal',
    '著作权归属',
    '著作权归属约定不得排除实际创作者权利（著作权法第11条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国著作权法',
        '第十一条',
        '2021-06-01',
        '著作权属于作者，本法另有规定的除外。创作作品的自然人是作者。由法人或者非法人组织主持，代表法人或者非法人组织意志创作，并由法人或者非法人组织承担责任的作品，法人或者非法人组织视为作者。'
      )
    },
    [
      {
        description: '著作权全归公司未提作者应触发',
        input: '本作品著作权归属公司所有',
        expectedTrigger: true,
        expectedMessage: '著作权归属'
      },
      {
        description: '著作权归属明确含作者权利不应触发',
        input: '本作品作者享有署名权，著作权其他权利归单位',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['著作权', '版权'])) return null
      if (hasKeyword(text, ['归属', '所有']) && hasKeyword(text, ['公司', '单位', '组织', '机构'])) {
        const hasAuthor = hasKeyword(text, ['作者', '创作者'])
        if (!hasAuthor) {
          return {
            triggered: true,
            constraintId: 'legal-ip-copyright-ownership',
            severity: 'info',
            message: '著作权归属约定可能排除了实际创作者的权利，请审查（著作权法第11条）',
            reliability: {
              confidence: 'medium',
              source: makeLawSource('中华人民共和国著作权法', '第十一条', '2021-06-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '请人工审查：著作权归属约定是否排除了实际创作者的权利？'
          }
        }
      }
      return null
    },
    'semi',
    '请人工审查：著作权归属约定是否排除了实际创作者的权利？',
    'auto'
  ),

  createConstraint(
    'legal-ip-patent-employee-invention',
    'legal',
    '职务发明申请权',
    '职务发明创造申请专利的权利属于单位（专利法第6条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国专利法',
        '第六条',
        '2021-06-01',
        '执行本单位的任务或者主要是利用本单位的物质技术条件所完成的发明创造为职务发明创造。职务发明创造申请专利的权利属于该单位；申请被批准后，该单位为专利权人。'
      )
    },
    [
      {
        description: '职务发明个人申请应触发',
        input: '本职务发明由发明人个人申请专利',
        expectedTrigger: true,
        expectedMessage: '申请专利的权利'
      },
      {
        description: '职务发明单位申请不应触发',
        input: '本职务发明由单位申请专利',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['职务发明'])) return null
      if (hasKeyword(text, ['个人申请', '自行申请'])) {
        return {
          triggered: true,
          constraintId: 'legal-ip-patent-employee-invention',
          severity: 'info',
          message: '职务发明创造申请专利的权利属于单位，个人不得自行申请（专利法第6条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国专利法', '第六条', '2021-06-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请人工审查：发明创造是否属于职务发明？申请专利的权利归属是否正确？'
        }
      }
      return null
    },
    'semi',
    '请人工审查：发明创造是否属于职务发明？申请专利的权利归属是否正确？',
    'auto'
  ),

  createConstraint(
    'legal-ip-trademark-registration',
    'legal',
    '商标注册',
    '使用未注册商标无专用权保护（商标法第4条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国商标法',
        '第四条',
        '2019-11-01',
        '自然人、法人或者其他组织在生产经营活动中，对其商品或者服务需要取得商标专用权的，应当向商标局申请商标注册。'
      )
    },
    [
      {
        description: '使用商标未注册应触发',
        input: '公司在产品上使用品牌商标进行销售',
        expectedTrigger: true,
        expectedMessage: '注册'
      },
      {
        description: '已申请商标注册不应触发',
        input: '公司已申请注册品牌商标',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['商标'])) return null
      if (hasKeyword(text, ['使用'])) {
        const hasRegistration = hasKeyword(text, ['注册', '申请注册', '已注册', '商标权'])
        if (!hasRegistration) {
          return {
            triggered: true,
            constraintId: 'legal-ip-trademark-registration',
            severity: 'info',
            message: '使用未注册商标不违法，但无法获得商标专用权保护，建议申请注册（商标法第4条）',
            reliability: {
              confidence: 'medium',
              source: makeLawSource('中华人民共和国商标法', '第四条', '2019-11-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '提醒：使用未注册商标不违法，但无法获得商标专用权保护。是否需要申请注册？'
          }
        }
      }
      return null
    },
    'semi',
    '提醒：使用未注册商标不违法，但无法获得商标专用权保护。是否需要申请注册？',
    'auto'
  ),

  createConstraint(
    'legal-consumer-safety-liability',
    'legal',
    '产品缺陷责任',
    '产品缺陷致损生产者应承担赔偿责任（消费者权益保护法第48条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国消费者权益保护法',
        '第四十八条',
        '2014-03-15',
        '经营者提供商品或者服务有下列情形之一的，除消费者权益保护法另有规定外，应当依照产品质量法和其他有关法律、法规的规定，承担民事责任。'
      )
    },
    [
      {
        description: '产品缺陷免责应触发',
        input: '本产品存在缺陷，但公司不承担任何责任',
        expectedTrigger: true,
        expectedMessage: '产品缺陷'
      },
      {
        description: '产品缺陷承担赔偿不应触发',
        input: '产品缺陷致损，公司依法承担赔偿责任',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['产品缺陷', '缺陷'])) return null
      if (hasKeyword(text, ['免责', '不承担', '不负责', '不负责任'])) {
        return {
          triggered: true,
          constraintId: 'legal-consumer-safety-liability',
          severity: 'info',
          message: '产品缺陷致损的生产者责任不可免责（消费者权益保护法第48条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国消费者权益保护法', '第四十八条', '2014-03-15')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请人工审查：产品是否存在缺陷？缺陷致损的生产者责任不可免责'
        }
      }
      return null
    },
    'semi',
    '请人工审查：产品是否存在缺陷？缺陷致损的生产者责任不可免责',
    'auto'
  ),

  createConstraint(
    'legal-housing-landlord-maintenance',
    'legal',
    '出租人修缮义务',
    '出租人默认承担租赁物维修义务（民法典第712条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国民法典',
        '第七百一十二条',
        '2021-01-01',
        '出租人应当履行租赁物的维修义务，但是当事人另有约定的除外。'
      )
    },
    [
      {
        description: '出租人不承担维修应触发',
        input: '租赁合同约定出租人不承担维修义务，租客自行维修',
        expectedTrigger: true,
        expectedMessage: '维修义务'
      },
      {
        description: '出租人承担维修不应触发',
        input: '租赁物由出租人负责维修',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['租赁'])) return null
      if (hasKeyword(text, ['维修', '修缮'])) {
        if (hasKeyword(text, ['出租人不承担', '自行维修', '租客负责', '承租人自行'])) {
          return {
            triggered: true,
            constraintId: 'legal-housing-landlord-maintenance',
            severity: 'info',
            message: '出租人默认承担维修义务，但合同可另有约定（民法典第712条）',
            reliability: {
              confidence: 'medium',
              source: makeLawSource('中华人民共和国民法典', '第七百一十二条', '2021-01-01')
            },
            automationLevel: 'semi',
            requiresHumanConfirmation: true,
            humanJudgmentPrompt: '提醒：出租人默认承担维修义务，但合同可另有约定。请检查是否有特别约定'
          }
        }
      }
      return null
    },
    'semi',
    '提醒：出租人默认承担维修义务，但合同可另有约定。请检查是否有特别约定',
    'auto'
  ),

  createConstraint(
    'legal-corporate-shareholder-rights',
    'legal',
    '股东会决议',
    '股东会决议程序应合规，股东有权请求撤销（公司法第22条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国公司法',
        '第二十二条',
        '2024-07-01',
        '公司股东会或者股东大会、董事会的决议内容违反法律、行政法规的无效。股东会或者股东大会、董事会的会议召集程序、表决方式违反法律、行政法规或者公司章程，或者决议内容违反公司章程的，股东可以自决议作出之日起六十日内，请求人民法院撤销。'
      )
    },
    [
      {
        description: '股东会决议程序问题应触发',
        input: '股东会决议未经法定程序表决通过',
        expectedTrigger: true,
        expectedMessage: '决议'
      },
      {
        description: '正常决议不应触发',
        input: '股东会决议经合法程序表决通过',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['股东会决议', '董事会决议'])) return null
      const hasProceduralIssue = hasKeyword(text, ['未经法定程序', '程序违法', '未经表决', '违规表决', '召集程序违法', '未通知股东'])
      const hasCompliant = hasKeyword(text, ['合法程序', '依法表决', '经合法程序', '表决通过', '依法召开'])
      if (hasProceduralIssue || !hasCompliant) {
        return {
          triggered: true,
          constraintId: 'legal-corporate-shareholder-rights',
          severity: 'info',
          message: '股东会决议程序应合规，违规决议股东有权请求撤销（公司法第22条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国公司法', '第二十二条', '2024-07-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '请人工审查：股东会决议程序是否合规？股东是否有权请求撤销？'
        }
      }
      return null
    },
    'semi',
    '请人工审查：股东会决议程序是否合规？股东是否有权请求撤销？',
    'auto'
  ),

  createConstraint(
    'legal-dispute-arbitration-agreement',
    'legal',
    '仲裁协议',
    '仲裁应当有明确的仲裁协议和仲裁机构（仲裁法第4条）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeLawSource(
        '中华人民共和国仲裁法',
        '第四条',
        '1995-09-01',
        '当事人采用仲裁方式解决纠纷，应当双方自愿，达成仲裁协议。没有仲裁协议，一方申请仲裁的，仲裁委员会不予受理。'
      )
    },
    [
      {
        description: '提及仲裁但无协议应触发',
        input: '双方约定通过仲裁解决纠纷',
        expectedTrigger: true,
        expectedMessage: '仲裁协议'
      },
      {
        description: '明确仲裁协议和机构不应触发',
        input: '双方签订仲裁协议，约定由北京仲裁委员会仲裁',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['仲裁'])) return null
      const hasAgreement = hasKeyword(text, ['仲裁协议', '仲裁条款', '仲裁机构', '仲裁委员会'])
      if (!hasAgreement) {
        return {
          triggered: true,
          constraintId: 'legal-dispute-arbitration-agreement',
          severity: 'info',
          message: '仲裁需有明确仲裁协议，请确认仲裁机构约定是否明确（仲裁法第4条）',
          reliability: {
            confidence: 'medium',
            source: makeLawSource('中华人民共和国仲裁法', '第四条', '1995-09-01')
          },
          automationLevel: 'semi',
          requiresHumanConfirmation: true,
          humanJudgmentPrompt: '提醒：合同中的仲裁条款即为仲裁协议。请确认仲裁机构约定是否明确'
        }
      }
      return null
    },
    'semi',
    '提醒：合同中的仲裁条款即为仲裁协议。请确认仲裁机构约定是否明确',
    'auto'
  )
]

export const FINANCE_CONSTRAINTS: DomainConstraint[] = [
  createConstraint(
    'finance-invoice-amount-match',
    'finance',
    '发票金额',
    '发票金额应与合同/订单金额一致',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeRegulationSource('中华人民共和国发票管理办法', '第二十一条', '2023-12-01'),
      caveat: '仅检查金额数值是否匹配，不验证发票真伪'
    },
    [
      {
        description: '发票金额与合同金额不一致应触发',
        input: '合同金额50000元，发票金额48000元',
        expectedTrigger: true,
        expectedMessage: '金额不一致'
      },
      {
        description: '金额一致不应触发',
        input: '合同金额50000元，发票金额50000元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const hasContract = hasKeyword(text, ['合同金额', '合同总价'])
      const hasInvoice = hasKeyword(text, ['发票金额', '开票金额'])
      if (hasContract && hasInvoice) {
        const amounts = findEntitiesByType(ctx.entities, 'amount')
        if (amounts.length >= 2) {
          const vals = amounts.map(a => parseFloat(a.normalized)).filter(v => v > 0)
          if (vals.length >= 2) {
            const diff = Math.abs(vals[0] - vals[1])
            if (diff > 0.01) {
              return {
                triggered: true,
                constraintId: 'finance-invoice-amount-match',
                severity: 'warning',
                message: `合同金额与发票金额不一致（差${diff.toFixed(2)}元），请核实`,
                reliability: {
                  confidence: 'medium',
                  source: makeRegulationSource('中华人民共和国发票管理办法', '第二十一条', '2023-12-01'),
                  caveat: '仅检查金额数值'
                },
                matchedEntities: amounts
              }
            }
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'finance-tax-rate-vat',
    'finance',
    '增值税率',
    '增值税率应符合法定标准（当前13%/9%/6%）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeLawSource('中华人民共和国增值税法', '第二条', '2026-01-01')
    },
    [
      {
        description: '增值税率20%应触发',
        input: '增值税税率为20%',
        expectedTrigger: true,
        expectedMessage: '增值税率'
      },
      {
        description: '增值税率13%不应触发',
        input: '增值税税率为13%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['增值税', 'VAT'])) return null
      const percentages = findEntitiesByType(ctx.entities, 'percentage')
      for (const pct of percentages) {
        const val = parseFloat(pct.normalized)
        if (val > 0 && ![6, 9, 13, 0, 1, 3, 5].includes(val)) {
          return {
            triggered: true,
            constraintId: 'finance-tax-rate-vat',
            severity: 'warning',
            message: `增值税率${val}%不是法定标准税率（法定税率：13%/9%/6%及简易征收率5%/3%/1%）`,
            reliability: {
              confidence: 'high',
              source: makeLawSource('中华人民共和国增值税法', '第二条', '2026-01-01')
            },
            matchedEntities: [pct]
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'finance-payment-terms-limit',
    'finance',
    '付款期限',
    '企业间付款期限一般不超过60天（中小企业保护条例）',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'low',
      source: makeRegulationSource('保障中小企业款项支付条例', '第八条', '2020-09-01'),
      caveat: '适用主体为机关/事业单位/大型企业向中小企业付款'
    },
    [
      {
        description: '付款期90天应触发',
        input: '付款期限为90天',
        expectedTrigger: true,
        expectedMessage: '付款期限'
      },
      {
        description: '付款期30天不应触发',
        input: '付款期限为30天',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      const payMatch = text.match(/付款期限[为约]?\s*(\d+)\s*天/)
      if (payMatch) {
        const days = parseInt(payMatch[1], 10)
        if (days > 60) {
          return {
            triggered: true,
            constraintId: 'finance-payment-terms-limit',
            severity: 'info',
            message: `付款期限${days}天，超过60天（保障中小企业款项支付条例第8条）`,
            reliability: {
              confidence: 'low',
              source: makeRegulationSource('保障中小企业款项支付条例', '第八条', '2020-09-01'),
              caveat: '适用主体为机关/事业单位/大型企业向中小企业付款'
            }
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'finance-depreciation-rate',
    'finance',
    '折旧率',
    '固定资产折旧年限和折旧率应在合理范围',
    'info',
    PRC_APPLICABILITY,
    {
      confidence: 'medium',
      source: makeStandardSource('企业会计准则第4号——固定资产', '第十七条', '2007-01-01'),
      caveat: '不同资产类别折旧年限不同'
    },
    [
      {
        description: '年折旧率80%应触发',
        input: '设备年折旧率为80%',
        expectedTrigger: true,
        expectedMessage: '折旧率'
      },
      {
        description: '年折旧率10%不应触发',
        input: '设备年折旧率为10%',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['折旧'])) return null
      const percentages = findEntitiesByType(ctx.entities, 'percentage')
      for (const pct of percentages) {
        const val = parseFloat(pct.normalized)
        if (val > 50) {
          return {
            triggered: true,
            constraintId: 'finance-depreciation-rate',
            severity: 'info',
            message: `年折旧率${val}%偏高，请核实资产类别与折旧年限是否合理（企业会计准则第4号）`,
            reliability: {
              confidence: 'medium',
              source: makeStandardSource('企业会计准则第4号——固定资产', '第十七条', '2007-01-01'),
              caveat: '不同资产类别折旧年限不同'
            },
            matchedEntities: [pct]
          }
        }
      }
      return null
    }
  ),

  createConstraint(
    'finance-large-transaction-flag',
    'finance',
    '大额交易',
    '大额交易需按规定报告（金融机构大额交易报告标准）',
    'warning',
    PRC_APPLICABILITY,
    {
      confidence: 'high',
      source: makeRegulationSource('金融机构大额交易和可疑交易报告管理办法', '第五条', '2022-07-01')
    },
    [
      {
        description: '单笔转账60万应触发',
        input: '单笔转账金额为60万元',
        expectedTrigger: true,
        expectedMessage: '大额交易'
      },
      {
        description: '单笔转账5万不应触发',
        input: '单笔转账金额为5万元',
        expectedTrigger: false
      }
    ],
    (ctx) => {
      const text = ctx.sourceText + ' ' + ctx.outputText
      if (!hasKeyword(text, ['转账', '汇款', '支付'])) return null
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(万元|万|元|块)/)
      if (amountMatch) {
        const num = parseFloat(amountMatch[1])
        const unit = amountMatch[2]
        const val = num * (unit === '万元' || unit === '万' ? 10000 : 1)
        if (val >= 500000) {
          return {
            triggered: true,
            constraintId: 'finance-large-transaction-flag',
            severity: 'warning',
            message: `单笔${amountMatch[0]}达到大额交易报告标准（50万元以上），需按规定报告`,
            reliability: {
              confidence: 'high',
              source: makeRegulationSource('金融机构大额交易和可疑交易报告管理办法', '第五条', '2022-07-01')
            },
            matchedEntities: findEntitiesByType(ctx.entities, 'amount')
          }
        }
      }
      return null
    }
  )
]

function initConstraintStore(): void {
  if (ACTIVE_CONSTRAINTS.length > 0) return
  for (const c of [...LEGAL_CONSTRAINTS, ...FINANCE_CONSTRAINTS]) {
    const validation = validateConstraintTestCases(c)
    if (validation.valid) {
      c.status = (c.automationLevel === 'full' && c.reviewType === 'auto') ? 'active' : 'testing'
    }
    ACTIVE_CONSTRAINTS.push(c)
  }
}

export function getAllConstraints(): DomainConstraint[] {
  initConstraintStore()
  return [...ACTIVE_CONSTRAINTS]
}

export function getConstraintsByDomain(domain: DomainConstraint['domain']): DomainConstraint[] {
  initConstraintStore()
  return ACTIVE_CONSTRAINTS.filter(c => c.domain === domain)
}

export function getConstraintsByAutomationLevel(level: DomainConstraint['automationLevel']): DomainConstraint[] {
  initConstraintStore()
  return ACTIVE_CONSTRAINTS.filter(c => c.automationLevel === level)
}

export function getActiveConstraints(): DomainConstraint[] {
  initConstraintStore()
  return ACTIVE_CONSTRAINTS.filter(c => c.status === 'active')
}

export function getConstraintById(id: string): DomainConstraint | undefined {
  initConstraintStore()
  return ACTIVE_CONSTRAINTS.find(c => c.id === id)
}

export function updateConstraintStatus(id: string, status: RuleStatus): boolean {
  initConstraintStore()
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return false
  constraint.status = status
  constraint.updatedAt = Date.now()
  return true
}

export function approveConstraint(id: string, reviewerName: string): boolean {
  initConstraintStore()
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return false
  constraint.reliability.source.verifiedBy = reviewerName
  constraint.reliability.source.verifiedAt = Date.now()
  constraint.status = 'active'
  constraint.updatedAt = Date.now()
  return true
}

export function recordConstraintTrigger(id: string, isFalsePositive: boolean): void {
  initConstraintStore()
  const constraint = ACTIVE_CONSTRAINTS.find(c => c.id === id)
  if (!constraint) return
  constraint.triggerCount++
  if (isFalsePositive) constraint.falsePositiveCount++
  constraint.lastTriggeredAt = Date.now()

  if (constraint.triggerCount >= 10) {
    const fpRate = constraint.falsePositiveCount / constraint.triggerCount
    if (fpRate > 0.3 && constraint.status === 'active') {
      constraint.status = 'deprecated'
      constraint.updatedAt = Date.now()
    } else if (fpRate > 0.2 && constraint.status === 'active') {
      if (constraint.reliability.confidence === 'high') {
        constraint.reliability.confidence = 'medium'
      } else if (constraint.reliability.confidence === 'medium') {
        constraint.reliability.confidence = 'low'
      }
      constraint.updatedAt = Date.now()
    }
  }

  if (constraint.status === 'testing' && constraint.triggerCount >= 5) {
    const fpRate = constraint.falsePositiveCount / constraint.triggerCount
    if (fpRate < 0.2) {
      constraint.status = 'active'
      constraint.updatedAt = Date.now()
    }
  }
}

export function runConstraints(
  context: ConstraintCheckContext,
  domain?: DomainConstraint['domain']
): ConstraintResult[] {
  initConstraintStore()
  const constraints = domain
    ? ACTIVE_CONSTRAINTS.filter(c => c.domain === domain)
    : ACTIVE_CONSTRAINTS

  context.entities = extractEntities(context.sourceText + ' ' + context.outputText)

  const results: ConstraintResult[] = []
  for (const constraint of constraints) {
    if (constraint.status !== 'active' && constraint.status !== 'testing') continue
    try {
      const result = constraint.check(context)
      if (result) {
        results.push(result)
        recordConstraintTrigger(constraint.id, false)
      }
    } catch {
      // constraint check errors are non-critical
    }
  }

  return results
}

export function validateConstraintTestCases(constraint: DomainConstraint): {
  valid: boolean
  errors: string[]
  passedTests: number
  failedTests: number
} {
  const errors: string[] = []

  if (!constraint.reliability.source.name) {
    errors.push('Missing source name')
  }
  if (!constraint.reliability.source.article) {
    errors.push('Missing source article')
  }
  if (!constraint.reliability.source.effectiveDate) {
    errors.push('Missing source effective date')
  }
  if (constraint.testCases.length < 2) {
    errors.push('Must have at least 2 test cases')
  }

  let passedTests = 0
  let failedTests = 0

  for (const tc of constraint.testCases) {
    const context: ConstraintCheckContext = {
      entities: extractEntities(tc.input),
      sourceText: tc.input,
      outputText: '',
      stepResults: {},
      manifestRoles: [constraint.domain]
    }

    try {
      const result = constraint.check(context)
      const triggered = result !== null
      if (triggered === tc.expectedTrigger) {
        passedTests++
      } else {
        failedTests++
        errors.push(`Test case "${tc.description}" failed: expected ${tc.expectedTrigger ? 'trigger' : 'no trigger'}, got ${triggered ? 'trigger' : 'no trigger'}`)
      }
    } catch (err) {
      failedTests++
      errors.push(`Test case "${tc.description}" threw error: ${(err as Error).message}`)
    }
  }

  return {
    valid: errors.length === 0 && failedTests === 0,
    errors,
    passedTests,
    failedTests
  }
}

export function validateAllConstraints(): {
  total: number
  valid: number
  invalid: number
  details: { id: string; valid: boolean; errors: string[]; passedTests: number; failedTests: number }[]
} {
  initConstraintStore()
  const details = ACTIVE_CONSTRAINTS.map(c => {
    const result = validateConstraintTestCases(c)
    return { id: c.id, ...result }
  })

  return {
    total: details.length,
    valid: details.filter(d => d.valid).length,
    invalid: details.filter(d => !d.valid).length,
    details
  }
}
