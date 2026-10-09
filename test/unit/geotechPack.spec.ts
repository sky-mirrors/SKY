import { describe, it, expect, beforeAll } from 'vitest'
import { packLoader, initPackRuntime } from '@/host/packRuntime'
import { getExternalConstraintIds, runConstraints } from '@/services/domainConstraints'

/**
 * geotech（岩土工程）包：从「内置源发现」到「约束真的会触发」的端到端行为验证。
 *
 * 为什么需要这一份：`test/integration/hotplugAcceptance.spec.ts` 只断言**约束总数**，
 * 它证明不了 geotech 的约束在真实输入下会命中——而"新加了 4 条约束"如果只是挂载成功
 * 却永不触发，对用户等于没加。这里用与生产同一条路径（initPackRuntime + runConstraints）
 * 输入真实说法，断言命中。
 */

const GEOTECH_CONSTRAINT_IDS = [
  'geotech-antifloat-level',
  'geotech-bearing-capacity-terms',
  'geotech-slope-stability-factor',
  'geotech-spt-correction'
]

function fires(text: string) {
  return runConstraints({
    entities: [],
    sourceText: text,
    outputText: '',
    stepResults: {},
    manifestRoles: ['geotech']
  })
}

describe('geotech pack：内置发现与约束注入', () => {
  beforeAll(async () => {
    await initPackRuntime()
  })

  it('经内置源自动发现并挂载，domain = geotech', () => {
    const mounted = packLoader.listMounted().find(m => m.id === 'geotech')
    expect(mounted).toBeDefined()
    expect(mounted!.domain).toBe('geotech')
  })

  it('4 条约束全部注入，且进入外部约束集合', () => {
    expect(packLoader.getMountedConstraintIds('geotech').sort()).toEqual(GEOTECH_CONSTRAINT_IDS)
    expect(getExternalConstraintIds()).toEqual(expect.arrayContaining(GEOTECH_CONSTRAINT_IDS))
  })
})

describe('geotech 约束行为：真实输入是否真的触发', () => {
  beforeAll(async () => {
    await initPackRuntime()
  })

  it('承载力「特征值/极限值/设计值」混用 → 触发', () => {
    const hit = fires('地基承载力特征值和极限值到底有什么区别，报告里该写哪个')
    expect(hit.some(r => r.constraintId === 'geotech-bearing-capacity-terms')).toBe(true)
  })

  it('标准贯入击数未修正就查表 → 触发', () => {
    const hit = fires('标贯击数 N 值能直接查承载力表吗，需要做杆长修正吗')
    expect(hit.some(r => r.constraintId === 'geotech-spt-correction')).toBe(true)
  })

  it('抗浮设防水位取实测水位 → 触发', () => {
    const hit = fires('地下室抗浮设计的设防水位怎么取，直接用勘察报告里的地下水位行吗')
    expect(hit.some(r => r.constraintId === 'geotech-antifloat-level')).toBe(true)
  })

  it('边坡稳定安全系数未按工况分档 → 触发', () => {
    const hit = fires('这个边坡的稳定安全系数取多少合适，下雨工况要另取吗')
    expect(hit.some(r => r.constraintId === 'geotech-slope-stability-factor')).toBe(true)
  })

  it('反例：与岩土无关的输入不触发任何 geotech 约束', () => {
    const hits = fires('帮我把这份周报整理成 300 字').filter(r => r.constraintId.startsWith('geotech-'))
    expect(hits).toEqual([])
  })
})
