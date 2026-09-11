export const MOCK_ENTITY_COMPANY = {
  text: '华为技术有限公司',
  type: 'company',
  startIndex: 0,
  endIndex: 7,
  confidence: 0.95
}

export const MOCK_ENTITY_AMOUNT = {
  text: '100万元',
  type: 'amount',
  startIndex: 20,
  endIndex: 24,
  confidence: 0.88
}

export const MOCK_ENTITY_LAW_ARTICLE = {
  text: '第123条',
  type: 'law_article',
  startIndex: 30,
  endIndex: 34,
  confidence: 0.92
}

export const MOCK_ENTITY_DATE = {
  text: '2024年1月1日',
  type: 'date',
  startIndex: 40,
  endIndex: 49,
  confidence: 0.99
}

export const MOCK_ENTITY_PERSON = {
  text: '张三',
  type: 'person',
  startIndex: 50,
  endIndex: 52,
  confidence: 0.85
}

export const MOCK_ENTITIES = [
  MOCK_ENTITY_COMPANY,
  MOCK_ENTITY_AMOUNT,
  MOCK_ENTITY_LAW_ARTICLE,
  MOCK_ENTITY_DATE,
  MOCK_ENTITY_PERSON
]

export const MOCK_SOURCE_TEXT = '华为技术有限公司在2024年1月1日向张三支付了100万元，依据第123条规定。'

export const MOCK_OUTPUT_TEXT = '根据第123条，华为公司向张三支付100万元。'
