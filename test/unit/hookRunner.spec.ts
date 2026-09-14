import { describe, it, expect, vi } from 'vitest'
import {
  HookRunner,
  runAdvisories,
  mergeAdvisories,
  runVetoGate,
  runOverrideWithFallback,
  type AdvisoryHookEntry,
  type VetoHookEntry,
  type OverrideHookEntry,
  type AdvisoryContribution,
  type VetoResult,
  type OverrideOutcome,
  type HookRunnerEvent
} from '@/kernel/hooks'

function advisory(pluginId: string, layer: AdvisoryHookEntry['layer'], fn: (input: string) => AdvisoryContribution): Omit<AdvisoryHookEntry, 'seq'> {
  return { pluginId, layer, contribute: (input) => fn(input) }
}

function veto(pluginId: string, position: VetoHookEntry['position'], fn: () => VetoResult): Omit<VetoHookEntry, 'seq'> {
  return { pluginId, position, check: () => fn() }
}

function overrideEntry(pluginId: string, layer: OverrideHookEntry['layer'], priority: number, impl: OverrideHookEntry['impl']): Omit<OverrideHookEntry, 'seq'> {
  return { pluginId, layer, priority, impl }
}

describe('M13：顾问贡献确定性合并', () => {
  it('scoreDelta 按注册顺序累加', () => {
    const merged = mergeAdvisories([{ scoreDelta: 0.1 }, { scoreDelta: -0.05 }, {}])
    expect(merged.scoreDelta).toBeCloseTo(0.05)
  })

  it('candidates 追加 + 按 id 去重保留首个', () => {
    const merged = mergeAdvisories([
      { candidates: [{ id: 'a', score: 1 }, { id: 'b', score: 2 }] },
      { candidates: [{ id: 'b', score: 99 }, { id: 'c' }] }
    ])
    expect(merged.candidates!.map(c => c.id)).toEqual(['a', 'b', 'c'])
    expect((merged.candidates!.find(c => c.id === 'b') as { score?: number }).score).toBe(2)
  })

  it('keywords 并集且保留出现顺序', () => {
    const merged = mergeAdvisories([
      { keywords: ['劳动合同', '试用期'] },
      { keywords: ['试用期', '竞业限制'] }
    ])
    expect(merged.keywords).toEqual(['劳动合同', '试用期', '竞业限制'])
  })

  it('fewShots 按序追加，超上限截断 + warning', () => {
    const warnings: string[] = []
    const merged = mergeAdvisories([
      { fewShots: ['fs1', 'fs2'] },
      { fewShots: ['fs3', 'fs4'] }
    ], warnings, { fewShotLimit: 3 })
    expect(merged.fewShots).toEqual(['fs1', 'fs2', 'fs3'])
    expect(warnings.some(w => w.includes('few-shots-truncated'))).toBe(true)
  })

  it('terminology 键冲突先注册者胜 + warning', () => {
    const warnings: string[] = []
    const merged = mergeAdvisories([
      { terminology: { 合同: 'contract', 侵权: 'tort' } },
      { terminology: { 合同: 'agreement', 担保: 'guarantee' } }
    ], warnings)
    expect(merged.terminology).toEqual({ 合同: 'contract', 侵权: 'tort', 担保: 'guarantee' })
    expect(warnings.some(w => w.includes('terminology-conflict'))).toBe(true)
  })

  it('exploreTemplate 先注册者胜，冲突 + warning', () => {
    const warnings: string[] = []
    const merged = mergeAdvisories([{ exploreTemplate: { name: 'A' } }, { exploreTemplate: { name: 'B' } }], warnings)
    expect(merged.exploreTemplate).toEqual({ name: 'A' })
    expect(warnings.some(w => w.includes('explore-template-conflict'))).toBe(true)
  })

  it('全部空贡献 → 空对象，无字段', () => {
    expect(mergeAdvisories([{}, {}, {}])).toEqual({})
  })

  it('非法字段宽容忽略（NaN scoreDelta / 非 string keyword）', () => {
    const merged = mergeAdvisories([
      { scoreDelta: Number.NaN },
      { keywords: ['ok', 123 as unknown as string] }
    ])
    expect(merged.scoreDelta).toBeUndefined()
    expect(merged.keywords).toEqual(['ok'])
  })
})

describe('M5.2：顾问执行（注册顺序 / 单个失败跳过）', () => {
  it('按 seq 排序执行，失败跳过 + warning，其余继续', () => {
    const runner = new HookRunner()
    const order: string[] = []
    runner.registerAdvisory(advisory('p1', 'L2', () => { order.push('p1'); return { scoreDelta: 0.1 } }))
    runner.registerAdvisory(advisory('p2', 'L2', () => { order.push('p2'); throw new Error('boom') }))
    runner.registerAdvisory(advisory('p3', 'L2', () => { order.push('p3'); return { scoreDelta: 0.2 } }))
    runner.registerAdvisory(advisory('p4', 'L0', () => { order.push('p4'); return { scoreDelta: 99 } }))

    const result = runAdvisories(runner.getAdvisories('L2'), '输入', {})
    expect(order).toEqual(['p1', 'p2', 'p3'])
    expect(result.merged.scoreDelta).toBeCloseTo(0.3)
    expect(result.warnings).toEqual([`advisory-failed{pluginId=p2, layer=L2}: boom`])
  })

  it('hasPermission=false → 跳过 + warning（M14 运行时复查）', () => {
    const runner = new HookRunner()
    runner.registerAdvisory({ ...advisory('p1', 'L1', () => ({ scoreDelta: 1 })), hasPermission: false })
    const result = runAdvisories(runner.getAdvisories('L1'), 'x', {})
    expect(result.merged).toEqual({})
    expect(result.warnings[0]).toContain('advisory-skip{pluginId=p1')
  })
})

describe('M6：否决门', () => {
  it('全量评估不短路：block 出现后其余钩子仍被调用', () => {
    const calls: string[] = []
    const hooks: VetoHookEntry[] = [
      { ...veto('p1', 'pre-output', () => { calls.push('p1'); return { veto: true, severity: 'block', reason: 'r1' } }), seq: 1 },
      { ...veto('p2', 'pre-output', () => { calls.push('p2'); return { veto: true, severity: 'warn', reason: 'r2' } }), seq: 2 }
    ]
    const report = runVetoGate(hooks, {}, {})
    expect(calls).toEqual(['p1', 'p2'])
    expect(report.blocked).toBe(true)
    // 聚合报告列出全部触发项（block 与 warn），按注册顺序
    expect(report.entries).toEqual([
      { pluginId: 'p1', severity: 'block', reason: 'r1' },
      { pluginId: 'p2', severity: 'warn', reason: 'r2' }
    ])
  })

  it('仅 warn → 不 block，警告随报告返回', () => {
    const hooks: VetoHookEntry[] = [
      { ...veto('p1', 'pre-output', () => ({ veto: true, severity: 'warn', reason: 'w' })), seq: 1 }
    ]
    const report = runVetoGate(hooks, {}, {})
    expect(report.blocked).toBe(false)
    expect(report.entries).toHaveLength(1)
  })

  it('钩子抛错 → 默认 fail-open（视作无意见）+ warning', () => {
    const hooks: VetoHookEntry[] = [
      { ...veto('p1', 'pre-execute', () => { throw new Error('crash') }), seq: 1 }
    ]
    const report = runVetoGate(hooks, {}, {})
    expect(report.blocked).toBe(false)
    expect(report.entries).toEqual([])
    expect(report.warnings[0]).toContain('veto-hook-error{pluginId=p1}')
    expect(report.warnings[0]).toContain('fail-open')
  })

  it('严格模式：钩子抛错 → fail-closed（block + generic reason）', () => {
    const hooks: VetoHookEntry[] = [
      { ...veto('p1', 'pre-execute', () => { throw new Error('crash') }), seq: 1 }
    ]
    const report = runVetoGate(hooks, {}, {}, { strict: true })
    expect(report.blocked).toBe(true)
    expect(report.entries[0]).toEqual({ pluginId: 'p1', severity: 'block', reason: 'strict-mode: veto hook failed' })
  })

  it('humanJudgmentPrompt 收集（路由人工复核暂停点）', () => {
    const hooks: VetoHookEntry[] = [
      { ...veto('p1', 'pre-output', () => ({ veto: true, severity: 'block', reason: 'r', humanJudgmentPrompt: '请人工复核金额' })), seq: 1 }
    ]
    const report = runVetoGate(hooks, {}, {})
    expect(report.humanJudgmentPrompts).toEqual(['请人工复核金额'])
  })

  it('按 position 过滤（pre-execute 不跑 pre-output 钩子）', () => {
    const runner = new HookRunner()
    const preExec = vi.fn(() => ({ veto: false, severity: 'warn', reason: '' }))
    const preOut = vi.fn(() => ({ veto: false, severity: 'warn', reason: '' }))
    runner.registerVeto(veto('p1', 'pre-execute', preExec))
    runner.registerVeto(veto('p2', 'pre-output', preOut))
    runVetoGate(runner.getVetoes('pre-execute'), {}, {})
    expect(preExec).toHaveBeenCalledOnce()
    expect(preOut).not.toHaveBeenCalled()
  })
})

describe('M7：覆盖槽竞争', () => {
  it('槽空 → 直接入槽', () => {
    const runner = new HookRunner()
    const r = runner.registerOverride(overrideEntry('p1', 'L2', 0, () => ({ miss: true })))
    expect(r.ok).toBe(true)
    expect(runner.getOverrideOccupant('L2')?.pluginId).toBe('p1')
  })

  it('新者 priority 更高 → 替换 + displaced 事件', () => {
    const events: HookRunnerEvent[] = []
    const runner = new HookRunner(e => events.push(e))
    runner.registerOverride(overrideEntry('p1', 'L2', 0, () => ({ miss: true })))
    const r = runner.registerOverride(overrideEntry('p2', 'L2', 10, () => ({ miss: true })))
    expect(r.ok).toBe(true)
    expect(runner.getOverrideOccupant('L2')?.pluginId).toBe('p2')
    expect(events).toEqual([{ type: 'override-displaced', layer: 'L2', incumbent: 'p1', challenger: 'p2' }])
  })

  it('priority 相等或更低 → 拒绝 + conflict 事件，占用者不变', () => {
    const events: HookRunnerEvent[] = []
    const runner = new HookRunner(e => events.push(e))
    runner.registerOverride(overrideEntry('p1', 'L3', 5, () => ({ miss: true })))
    const lower = runner.registerOverride(overrideEntry('p2', 'L3', 4, () => ({ miss: true })))
    const equal = runner.registerOverride(overrideEntry('p3', 'L3', 5, () => ({ miss: true })))
    expect(lower.ok).toBe(false)
    expect(equal.ok).toBe(false)
    expect(runner.getOverrideOccupant('L3')?.pluginId).toBe('p1')
    expect(events.filter(e => e.type === 'override-conflict')).toHaveLength(2)
  })

  it('unmount 释放槽 → 不自动晋升，槽空', () => {
    const events: HookRunnerEvent[] = []
    const runner = new HookRunner(e => events.push(e))
    runner.registerOverride(overrideEntry('p1', 'L2', 10, () => ({ miss: true })))
    runner.registerOverride(overrideEntry('p2', 'L2', 0, () => ({ miss: true }))) // 被拒
    runner.unregisterPlugin('p1')
    expect(runner.getOverrideOccupant('L2')).toBeUndefined()
    expect(events).toContainEqual({ type: 'override-released', layer: 'L2', pluginId: 'p1' })
    // 被拒的 p2 不晋升
    expect(runner.getOverrideOccupant('L2')).toBeUndefined()
  })

  it('不同层互不影响', () => {
    const runner = new HookRunner()
    runner.registerOverride(overrideEntry('p1', 'L0', 1, () => ({ miss: true })))
    const r = runner.registerOverride(overrideEntry('p2', 'L2', 0, () => ({ miss: true })))
    expect(r.ok).toBe(true)
    expect(runner.getOverrideOccupant('L0')?.pluginId).toBe('p1')
    expect(runner.getOverrideOccupant('L2')?.pluginId).toBe('p2')
  })
})

describe('M15：请求级快照', () => {
  it('快照后 unmount → 快照仍持引用（在途请求跑完）', () => {
    const runner = new HookRunner()
    const contribute = vi.fn(() => ({ scoreDelta: 1 }))
    runner.registerAdvisory({ pluginId: 'p1', layer: 'L2', contribute })
    const snap = runner.snapshot()
    runner.unregisterPlugin('p1')
    expect(runner.getAdvisories('L2')).toHaveLength(0)
    // 快照不受注册表清理影响
    const result = runAdvisories(snap.advisories.filter(h => h.layer === 'L2'), 'x', {})
    expect(result.merged.scoreDelta).toBe(1)
    expect(contribute).toHaveBeenCalledOnce()
  })

  it('快照后新注册 → 快照不可见（新请求才见）', () => {
    const runner = new HookRunner()
    runner.registerAdvisory(advisory('p1', 'L2', () => ({ scoreDelta: 1 })))
    const snap = runner.snapshot()
    runner.registerAdvisory(advisory('p2', 'L2', () => ({ scoreDelta: 100 })))
    const result = runAdvisories(snap.advisories.filter(h => h.layer === 'L2'), 'x', {})
    expect(result.merged.scoreDelta).toBe(1)
  })

  it('覆盖槽快照：unmount 后在途请求仍用旧 occupant，新请求见槽空', async () => {
    const runner = new HookRunner()
    runner.registerOverride(overrideEntry('p1', 'L2', 0, () => ({ miss: false, value: 'old-impl' })))
    const snap = runner.snapshot()
    runner.unregisterPlugin('p1')

    const inFlight = await runOverrideWithFallback(
      snap.overrideOccupants['L2'],
      () => ({ miss: false, value: 'default' }),
      'x', null, {}, { timeoutMs: 100, layer: 'L2' }
    )
    expect(inFlight.outcome).toEqual({ miss: false, value: 'old-impl' })

    const newRequest = await runOverrideWithFallback(
      runner.getOverrideOccupant('L2'),
      () => ({ miss: false, value: 'default' }),
      'x', null, {}, { timeoutMs: 100, layer: 'L2' }
    )
    expect(newRequest.outcome).toEqual({ miss: false, value: 'default' })
    expect(newRequest.usedOverride).toBe(false)
  })
})

describe('M5.4：覆盖执行回退兜底', () => {
  it('impl 抛错 → 回退默认实现 + 审计事件', async () => {
    const occupant: OverrideHookEntry = {
      pluginId: 'p1', layer: 'L2', priority: 0, seq: 1,
      impl: () => { throw new Error('impl bug') }
    }
    const result = await runOverrideWithFallback(
      occupant, () => ({ miss: false, value: 'default' }), 'x', null, {}, { timeoutMs: 100, layer: 'L2' }
    )
    expect(result.outcome).toEqual({ miss: false, value: 'default' })
    expect(result.usedOverride).toBe(false)
    expect(result.audit).toEqual({ type: 'override:fallback', layer: 'L2', pluginId: 'p1', reason: 'impl bug' })
  })

  it('impl 超时 → 回退默认实现 + 审计事件', async () => {
    const occupant: OverrideHookEntry = {
      pluginId: 'p1', layer: 'L3', priority: 0, seq: 1,
      impl: () => new Promise<OverrideOutcome>(() => { /* 永不 resolve */ })
    }
    const startedAt = Date.now()
    const result = await runOverrideWithFallback(
      occupant, () => ({ miss: false, value: 'default' }), 'x', null, {}, { timeoutMs: 30, layer: 'L3' }
    )
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25)
    expect(result.outcome).toEqual({ miss: false, value: 'default' })
    expect(result.audit?.reason).toContain('timeout')
  })

  it('impl 正常返回 → 直接采用，不走默认', async () => {
    const occupant: OverrideHookEntry = {
      pluginId: 'p1', layer: 'L1', priority: 0, seq: 1,
      impl: () => ({ miss: false, value: 'custom' })
    }
    const result = await runOverrideWithFallback(
      occupant, () => ({ miss: false, value: 'default' }), 'x', null, {}, { timeoutMs: 100, layer: 'L1' }
    )
    expect(result.outcome).toEqual({ miss: false, value: 'custom' })
    expect(result.usedOverride).toBe(true)
    expect(result.audit).toBeUndefined()
  })

  it('impl 返回 miss:true → 原样透传（层未命中，降级由内核决定）', async () => {
    const occupant: OverrideHookEntry = {
      pluginId: 'p1', layer: 'L0', priority: 0, seq: 1,
      impl: () => ({ miss: true })
    }
    const result = await runOverrideWithFallback(
      occupant, () => ({ miss: false, value: 'default' }), 'x', null, {}, { timeoutMs: 100, layer: 'L0' }
    )
    expect(result.outcome).toEqual({ miss: true })
    expect(result.usedOverride).toBe(true)
  })
})
