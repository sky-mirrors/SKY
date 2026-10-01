import { describe, it, expect } from 'vitest'
import { groupProbes, isDimmed, shortId } from '@/services/probeGrouping'
import type { ProbeSnapshot } from '@/models'

/**
 * 2026-10-01：调试窗的探针三级分组从组件内联抽出后补的测试。
 * 重点锁定**跨组全局序号**——时间旅行滑块的 dimmed 判定依赖它；
 * 用组内索引会在第二个组之后错乱（这正是当初把 dimmed 弄丢的原因，且几轮后才发现）。
 */
const probe = (over: Partial<ProbeSnapshot>): ProbeSnapshot => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  stepNum: 1,
  manifestId: 'm',
  source: 'llm',
  sourceDetail: 'x',
  toolName: 't',
  inputSnapshot: {},
  outputSnapshot: 'o',
  timestamp: Date.now(),
  durationMs: 10,
  ...over
})

describe('groupProbes —— 会话/轮次两级分组', () => {
  it('同 sessionId+traceId 归为一组，不同轮次分开', () => {
    const groups = groupProbes([
      probe({ sessionId: 'sA', traceId: 't1', stepNum: 1 }),
      probe({ sessionId: 'sA', traceId: 't1', stepNum: 2 }),
      probe({ sessionId: 'sA', traceId: 't2', stepNum: 1 }),
      probe({ sessionId: 'sB', traceId: 't3', stepNum: 1 })
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].probes).toHaveLength(2)
    expect(groups[1].probes).toHaveLength(1)
    expect(groups[2].probes).toHaveLength(1)
  })

  it('保持到达顺序（首个出现的组在前）', () => {
    const groups = groupProbes([
      probe({ sessionId: 'sB', traceId: 't9' }),
      probe({ sessionId: 'sA', traceId: 't1' })
    ])
    expect(groups[0].sessionId).toBe('sB')
    expect(groups[1].sessionId).toBe('sA')
  })

  it('缺 sessionId/traceId 时落入未归属组并可读', () => {
    const groups = groupProbes([probe({})])
    expect(groups[0].sessionLabel).toBe('(未归属会话)')
    expect(groups[0].traceLabel).toBe('(未归属轮次)')
  })

  it('累计该轮的 token 与成本（无 tokenUsage 的探针不参与）', () => {
    const groups = groupProbes([
      probe({ sessionId: 's', traceId: 't', tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostCny: 0.002 } }),
      probe({ sessionId: 's', traceId: 't', tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostCny: 0.001 } }),
      probe({ sessionId: 's', traceId: 't' })
    ])
    expect(groups[0].tokens).toBe(165)
    expect(groups[0].cost).toBeCloseTo(0.003, 6)
  })

  it('**globalIdx 跨组连续递增**（这是 dimmed 判定正确的前提）', () => {
    const groups = groupProbes([
      probe({ sessionId: 'sA', traceId: 't1' }),
      probe({ sessionId: 'sA', traceId: 't1' }),
      probe({ sessionId: 'sB', traceId: 't2' }),
      probe({ sessionId: 'sB', traceId: 't2' })
    ])
    const flat = groups.flatMap(g => g.probes.map(p => p.globalIdx))
    expect(flat).toEqual([0, 1, 2, 3])
    // 第二个组内若用组内索引会得到 [0,1]——那正是错乱的来源
    expect(groups[1].probes.map(p => p.globalIdx)).toEqual([2, 3])
  })

  it('空输入返回空数组（不抛）', () => {
    expect(groupProbes([])).toEqual([])
  })
})

describe('isDimmed —— 时间旅行淡化判定', () => {
  it('timeTravelIdx < 0（全部）时一律不淡化', () => {
    const [g] = groupProbes([probe({ sessionId: 's', traceId: 't' }), probe({ sessionId: 's', traceId: 't' })])
    expect(g.probes.every(p => !isDimmed(p, -1))).toBe(true)
  })

  it('已执行到第 N 步时，其后的步骤淡化——且跨组连续', () => {
    const groups = groupProbes([
      probe({ sessionId: 'sA', traceId: 't1' }),
      probe({ sessionId: 'sA', traceId: 't1' }),
      probe({ sessionId: 'sB', traceId: 't2' }),
      probe({ sessionId: 'sB', traceId: 't2' })
    ])
    const flat = groups.flatMap(g => g.probes)
    // 拖到第 2 步（idx=1）：前两个不淡化，后两个淡化
    expect(flat.map(p => isDimmed(p, 1))).toEqual([false, false, true, true])
    // 拖到第 3 步（idx=2）：只有最后一个淡化
    expect(flat.map(p => isDimmed(p, 2))).toEqual([false, false, false, true])
  })
})

describe('shortId', () => {
  it('长 id 取尾 8 位并加省略号，短 id 原样', () => {
    // 'session-1790858023577-abc1' 的末 8 位是 '577-abc1'
    expect(shortId('session-1790858023577-abc1')).toBe('…577-abc1')
    expect(shortId('t1')).toBe('t1')
  })
})
