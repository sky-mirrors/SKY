import { describe, it, expect } from 'vitest'
import {
  constraintsToDrafts,
  draftsToConstraints,
  formatKeywordGroups,
  parseKeywordGroups,
  type RuleDraft
} from '@/components/packs/packRules'

/** 顺序确定性 id 生成器（便于断言）。 */
function seqGen(prefix = 'gen') {
  let n = 0
  return () => `${prefix}-${++n}`
}

function draft(over: Partial<RuleDraft> = {}): RuleDraft {
  return { id: '', keywords: '', message: '', ref: '', severity: 'warning', ...over }
}

describe('触发词分组：parse / format 互逆', () => {
  it('分号分组、组内逗号、去空白', () => {
    expect(parseKeywordGroups('a, b ; c')).toEqual([['a', 'b'], ['c']])
  })

  it('空段过滤；空串 → 空数组', () => {
    expect(parseKeywordGroups(';;a,,b;')).toEqual([['a', 'b']])
    expect(parseKeywordGroups('')).toEqual([])
  })

  it('format 与 parse 互逆，坏输入回落空串', () => {
    expect(formatKeywordGroups(parseKeywordGroups('竞业限制,竞业禁止;补偿'))).toBe('竞业限制,竞业禁止;补偿')
    expect(formatKeywordGroups(null)).toBe('')
    expect(formatKeywordGroups('x')).toBe('')
  })
})

describe('规则往返：整体幂等', () => {
  it('草稿 → constraints → 草稿，字段零漂移', () => {
    const drafts: RuleDraft[] = [
      draft({ id: 'p-rule-a1', keywords: '竞业限制,竞业禁止;补偿', message: '注意竞业限制期限', ref: '劳动合同法 第二十三条', severity: 'warning' }),
      draft({ id: 'p-rule-b2', keywords: '资本充足率', message: '核对资本充足率口径', ref: '商业银行法 第三十九条', severity: 'info' })
    ]
    expect(constraintsToDrafts(draftsToConstraints(drafts, seqGen()))).toEqual(drafts)
  })

  it('回归：依据不因多次往返累积「见上」占位', () => {
    let d: RuleDraft[] = [draft({ id: 'p-rule-1', keywords: 'k', message: 'm', ref: '民法典 第五百条', severity: 'info' })]
    for (let i = 0; i < 3; i++) d = constraintsToDrafts(draftsToConstraints(d, seqGen()))
    expect(d[0].ref).toBe('民法典 第五百条')
    expect(d[0].ref).not.toContain('见上')
  })
})

describe('约束 id 稳定性', () => {
  const a = draft({ id: 'demo-rule-a', keywords: 'ka', message: 'ma', ref: 'ra' })
  const b = draft({ id: 'demo-rule-b', keywords: 'kb', message: 'mb', ref: 'rb' })
  const c = draft({ id: 'demo-rule-c', keywords: 'kc', message: 'mc', ref: 'rc' })

  it('已有 id 原样复用', () => {
    expect(draftsToConstraints([a, b, c], seqGen()).map(x => x.id)).toEqual(['demo-rule-a', 'demo-rule-b', 'demo-rule-c'])
  })

  it('删掉中间一条后其余 id 不变（旧实现会整体前移）', () => {
    expect(draftsToConstraints([a, c], seqGen()).map(x => x.id)).toEqual(['demo-rule-a', 'demo-rule-c'])
  })

  it('重排顺序时 id 跟随内容，不跟随下标', () => {
    expect(draftsToConstraints([c, a], seqGen()).map(x => x.id)).toEqual(['demo-rule-c', 'demo-rule-a'])
  })

  it('空 id 用 genId 生成，同批去重', () => {
    expect(draftsToConstraints([draft(), draft()], seqGen('new')).map(x => x.id)).toEqual(['new-1', 'new-2'])
  })

  it('genId 偶发重复时重试至唯一', () => {
    const seq = ['dup', 'dup', 'uniq']
    let i = 0
    const g = () => seq[Math.min(i++, seq.length - 1)]
    expect(new Set(draftsToConstraints([draft(), draft()], g).map(x => x.id)).size).toBe(2)
  })
})

describe('constraintsToDrafts 容错', () => {
  it('非数组 → 空数组', () => {
    expect(constraintsToDrafts(null)).toEqual([])
    expect(constraintsToDrafts({})).toEqual([])
  })

  it('跳过非对象项', () => {
    expect(constraintsToDrafts([1, null, 'x', true])).toEqual([])
  })

  it('severity 缺失回落 warning', () => {
    expect(constraintsToDrafts([{ id: 'x' }])[0].severity).toBe('warning')
  })

  it('message 回落 description', () => {
    expect(constraintsToDrafts([{ id: 'x', description: '来自描述' }])[0].message).toBe('来自描述')
  })
})
