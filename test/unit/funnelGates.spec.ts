import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseFunnelGates, describeGateOverrides, FUNNEL_GATE_DEFAULTS } from '@/services/funnelGates'
import { DEFAULT_FUNNEL_GATES } from '@/kernel/funnel'

// G-15（2026-09-25 修复）：门值此前永远等于 funnel.ts 的硬编码常量（FunnelConfig.gates 支持覆盖，
// 但没有任何生产调用方传入）。本模块是配置通道——可调 + 可观测，且坏配置 fail-safe 回退默认。
describe('漏斗门值配置 · funnelGates', () => {
  it('未配置时逐字节等于默认（0.6 / 0.9 / 0.6）', () => {
    expect(parseFunnelGates(null)).toEqual(DEFAULT_FUNNEL_GATES)
    expect(parseFunnelGates(undefined)).toEqual(DEFAULT_FUNNEL_GATES)
    expect(FUNNEL_GATE_DEFAULTS).toEqual(DEFAULT_FUNNEL_GATES)
    // 2026-09-30：l05Pass 由 0.8 降到 0.6（L0.5 内层硬门移除后，本 gate 成为唯一过门判定点）
    expect(FUNNEL_GATE_DEFAULTS.l05Pass).toBe(0.6)
    expect(FUNNEL_GATE_DEFAULTS.l05Auto).toBe(0.9)
    expect(FUNNEL_GATE_DEFAULTS.l1Pass).toBe(0.6)
  })

  it('合法覆盖生效，未提到的字段保持默认', () => {
    const g = parseFunnelGates({ l05Pass: 0.75, l1Pass: 0.5 })
    expect(g).toEqual({ l05Pass: 0.75, l05Auto: 0.9, l1Pass: 0.5 })
  })

  it('坏值一律忽略并回退默认（fail-safe：坏配置绝不变成"门永远不通过"）', () => {
    const g = parseFunnelGates({ l05Pass: 1.5, l05Auto: -0.1, l1Pass: 'x' })
    expect(g).toEqual(DEFAULT_FUNNEL_GATES)
    expect(parseFunnelGates({ l05Pass: Number.NaN })).toEqual(DEFAULT_FUNNEL_GATES)
    expect(parseFunnelGates('not-an-object')).toEqual(DEFAULT_FUNNEL_GATES)
  })

  it('边界值 0 与 1 合法', () => {
    expect(parseFunnelGates({ l05Pass: 0 })).toEqual({ ...DEFAULT_FUNNEL_GATES, l05Pass: 0 })
    expect(parseFunnelGates({ l05Auto: 1 })).toEqual({ ...DEFAULT_FUNNEL_GATES, l05Auto: 1 })
  })

  it('describeGateOverrides 只列出合法覆盖字段（可观测）', () => {
    expect(describeGateOverrides({ l05Pass: 0.7, l1Pass: 2 })).toEqual(['l05Pass'])
    expect(describeGateOverrides(null)).toEqual([])
  })
})

describe('G-15 接线：route 传入可配置门值', () => {
  const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')

  it('两处 kernelRegistry.route 都传入 loadFunnelGates() 的门值', () => {
    const calls = src.match(/kernelRegistry\.route\(content, ctx[^)]*\)/g) || []
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toContain('loadFunnelGates')
  })

  it('门值来自 vault config（可持久化调整，不需要改代码/重编译）', () => {
    expect(src).toContain("vault.read('config', 'holo-funnel-gates')")
  })
})
