import { describe, it, expect, vi } from 'vitest'
import {
  runFunnel,
  applyScoreDelta,
  DEFAULT_FUNNEL_GATES,
  type FunnelBaseContext,
  type FunnelConfig,
  type LayerResult
} from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import type { TaskPlan } from '@/models'

function plan(intent: string): TaskPlan {
  return { intent, needs: [], steps: [{ step: 1, description: intent, tool: 'llm_generate', depends_on: [], params: {}, expectedOutput: '' }] }
}

const miss = (): LayerResult => ({ kind: 'miss' })

interface TestCtx extends FunnelBaseContext {
  data?: string
}

function makeConfig(overrides: Partial<FunnelConfig<TestCtx>> = {}): FunnelConfig<TestCtx> {
  return {
    layers: {
      l0: miss,
      l05: miss,
      l1: miss,
      l2: miss,
      l3: miss,
      l4: (input: string) => ({ kind: 'plan', plan: plan(`explore:${input}`) })
    },
    hooks: new HookRunner<LayerResult>(),
    ...overrides
  }
}

describe('M5：六层漏斗编排核', () => {
  it('L0 命中 → 直接产出计划，不跑后续层', async () => {
    const calls: string[] = []
    const config = makeConfig({
      layers: {
        l0: () => { calls.push('L0'); return { kind: 'plan', plan: plan('l0') } },
        l05: () => { calls.push('L0.5'); return miss() },
        l1: () => { calls.push('L1'); return miss() },
        l2: () => { calls.push('L2'); return miss() },
        l3: () => { calls.push('L3'); return miss() },
        l4: () => { calls.push('L4'); return { kind: 'plan', plan: plan('l4') } }
      }
    })
    const outcome = await runFunnel(config, '读文件', {})
    expect(outcome.kind).toBe('plan')
    if (outcome.kind === 'plan') {
      expect(outcome.source).toBe('L0')
      expect(outcome.plan.intent).toBe('l0')
      expect(outcome.autoExecutable).toBe(false)
    }
    expect(calls).toEqual(['L0'])
  })

  it('逐层降级：L0/L0.5/L1 miss → L2 命中', async () => {
    const calls: string[] = []
    const config = makeConfig({
      layers: {
        l0: () => { calls.push('L0'); return miss() },
        l05: () => { calls.push('L0.5'); return miss() },
        l1: () => { calls.push('L1'); return miss() },
        l2: () => { calls.push('L2'); return { kind: 'plan', plan: plan('l2'), macroManifestId: 'm1' } },
        l3: () => { calls.push('L3'); return miss() },
        l4: () => { calls.push('L4'); return { kind: 'plan', plan: plan('l4') } }
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(calls).toEqual(['L0', 'L0.5', 'L1', 'L2'])
    if (outcome.kind === 'plan') {
      expect(outcome.source).toBe('L2')
      expect(outcome.macroManifestId).toBe('m1')
    }
  })

  it('L0.5 门评估：score < 0.8 降级；0.8-0.9 过门但需确认；≥0.9 且无 shell 自动执行', async () => {
    const mk = (score: number, tool = 'llm_generate') => makeConfig({
      layers: {
        l0: miss,
        l05: () => ({ kind: 'plan', plan: { intent: 'x', needs: [], steps: [{ step: 1, description: '', tool, depends_on: [], params: {}, expectedOutput: '' }] }, score }),
        l1: miss, l2: miss, l3: miss,
        l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })

    const low = await runFunnel(mk(0.79), 'x', {})
    expect(low.kind).toBe('plan')
    expect((low as { source: string }).source).toBe('L4') // 降级到底

    const mid = await runFunnel(mk(0.85), 'x', {})
    expect((mid as { source: string }).source).toBe('L0.5')
    expect((mid as { autoExecutable: boolean }).autoExecutable).toBe(false)

    const high = await runFunnel(mk(0.95), 'x', {})
    expect((high as { autoExecutable: boolean }).autoExecutable).toBe(true)

    const highShell = await runFunnel(mk(0.95, 'shell_exec'), 'x', {})
    expect((highShell as { autoExecutable: boolean }).autoExecutable).toBe(false)
  })

  it('L1 门评估：score < 0.6 降级', async () => {
    const config = makeConfig({
      layers: {
        l0: miss, l05: miss,
        l1: () => ({ kind: 'plan', plan: plan('l1'), score: 0.5 }),
        l2: miss, l3: miss,
        l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L4')
  })

  it('门值可由内核插件配置（激进内核调低 L0.5 门）', async () => {
    const config = makeConfig({
      gates: { l05Pass: 0.5 },
      layers: {
        l0: miss,
        l05: () => ({ kind: 'plan', plan: plan('l05'), score: 0.6 }),
        l1: miss, l2: miss, l3: miss, l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L0.5')
    expect(DEFAULT_FUNNEL_GATES.l05Pass).toBe(0.8)
  })

  it('advisory scoreDelta 叠加到 L0.5 匹配分（影响过门）', async () => {
    const hooks = new HookRunner<LayerResult>()
    hooks.registerAdvisory({ pluginId: 'p1', layer: 'L0.5', contribute: () => ({ scoreDelta: 0.15 }) })
    const config = makeConfig({
      hooks,
      layers: {
        l0: miss,
        l05: (_input, merged) => ({ kind: 'plan', plan: plan('l05'), score: applyScoreDelta(0.7, merged) }),
        l1: miss, l2: miss, l3: miss, l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L0.5')
  })

  it('override 替换层实现：miss 透传降级', async () => {
    const hooks = new HookRunner<LayerResult>()
    hooks.registerOverride({ pluginId: 'p1', layer: 'L0', priority: 0, impl: () => ({ kind: 'miss' }) })
    const l0 = vi.fn(() => ({ kind: 'plan', plan: plan('default-l0') }))
    const config = makeConfig({
      hooks,
      layers: {
        l0,
        l05: miss, l1: miss, l2: miss, l3: miss,
        l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(l0).not.toHaveBeenCalled()
    expect((outcome as { source: string }).source).toBe('L4')
  })

  it('override 抛错 → 回退默认实现（用户请求不因覆盖质量失败）', async () => {
    const hooks = new HookRunner<LayerResult>()
    hooks.registerOverride({ pluginId: 'p1', layer: 'L2', priority: 0, impl: () => { throw new Error('bad impl') } })
    const config = makeConfig({
      hooks,
      layers: {
        l0: miss, l05: miss, l1: miss,
        l2: () => ({ kind: 'plan', plan: plan('default-l2') }),
        l3: miss, l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L2')
    expect((outcome as { plan: TaskPlan }).plan.intent).toBe('default-l2')
  })

  it('层实现抛错 → 视为未命中降级 + 不中断管线', async () => {
    const config = makeConfig({
      layers: {
        l0: () => { throw new Error('L0 crash') },
        l05: () => { throw new Error('L05 crash') },
        l1: miss,
        l2: () => ({ kind: 'plan', plan: plan('l2') }),
        l3: miss, l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L2')
  })

  it('全部层未命中且 L4 抛错 → all-layers-failed', async () => {
    const config = makeConfig({
      layers: {
        l0: miss, l05: miss, l1: miss, l2: miss, l3: miss,
        l4: () => { throw new Error('explore crashed') }
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(outcome.kind).toBe('error')
    expect((outcome as { error: string }).error).toBe('all-layers-failed')
  })

  it('空输入 → 跳过 L0-L3 直达 L4', async () => {
    const calls: string[] = []
    const config = makeConfig({
      layers: {
        l0: () => { calls.push('L0'); return { kind: 'plan', plan: plan('l0') } },
        l05: () => { calls.push('L0.5'); return miss() },
        l1: () => { calls.push('L1'); return miss() },
        l2: () => { calls.push('L2'); return miss() },
        l3: () => { calls.push('L3'); return miss() },
        l4: () => { calls.push('L4'); return { kind: 'plan', plan: plan('l4') } }
      }
    })
    const outcome = await runFunnel(config, '', { isEmptyInput: true })
    expect(calls).toEqual(['L4'])
    expect((outcome as { source: string }).source).toBe('L4')
  })

  it('pre-execute 否决门：block → 中止并返回聚合报告', async () => {
    const hooks = new HookRunner<LayerResult>()
    hooks.registerVeto({ pluginId: 'p1', position: 'pre-execute', check: () => ({ veto: true, severity: 'block', reason: '违规' }) })
    hooks.registerVeto({ pluginId: 'p2', position: 'pre-execute', check: () => ({ veto: true, severity: 'warn', reason: '提醒' }) })
    const config = makeConfig({
      hooks,
      layers: {
        l0: () => ({ kind: 'plan', plan: plan('l0') }),
        l05: miss, l1: miss, l2: miss, l3: miss, l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.veto.blocked).toBe(true)
      // 聚合列出全部触发项（block + warn）
      expect(outcome.veto.entries).toEqual([
        { pluginId: 'p1', severity: 'block', reason: '违规' },
        { pluginId: 'p2', severity: 'warn', reason: '提醒' }
      ])
    }
  })

  it('humanJudgmentPrompt 非空 → 保守不执行（blocked 返回）', async () => {
    const hooks = new HookRunner<LayerResult>()
    hooks.registerVeto({
      pluginId: 'p1', position: 'pre-execute',
      check: () => ({ veto: true, severity: 'warn', reason: '需复核', humanJudgmentPrompt: '请人工确认' })
    })
    const config = makeConfig({
      hooks,
      layers: { l0: () => ({ kind: 'plan', plan: plan('l0') }), l05: miss, l1: miss, l2: miss, l3: miss, l4: miss }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(outcome.kind).toBe('blocked')
  })

  it('L3 进入时触发 beforeLlm 簇点位；拒绝 → budget-blocked（不降级 L4）', async () => {
    const beforeLlm = vi.fn(async () => ({ allowed: false, reason: 'budget exceeded' }))
    const l4 = vi.fn(() => ({ kind: 'plan', plan: plan('l4') }))
    const config = makeConfig({
      layers: {
        l0: miss, l05: miss, l1: miss, l2: miss,
        l3: () => ({ kind: 'plan', plan: plan('l3') }),
        l4
      }
    })
    const outcome = await runFunnel(config, 'x', { beforeLlm })
    expect(beforeLlm).toHaveBeenCalledOnce()
    expect(l4).not.toHaveBeenCalled()
    expect(outcome.kind).toBe('budget-blocked')
    if (outcome.kind === 'budget-blocked') expect(outcome.reason).toBe('budget exceeded')
  })

  it('beforeLlm 拒绝一次后，同请求内不再重复触发（llmGateChecked）', async () => {
    let callCount = 0
    const beforeLlm = vi.fn(async () => { callCount++; return { allowed: true } })
    const config = makeConfig({
      layers: {
        l0: miss, l05: miss, l1: miss, l2: miss,
        l3: () => ({ kind: 'plan', plan: plan('l3') }),
        l4: () => ({ kind: 'plan', plan: plan('l4') })
      }
    })
    await runFunnel(config, 'x', { beforeLlm })
    expect(callCount).toBe(1)
  })

  it('交互暂停点产出不经否决门（candidates/intent-confirm/slot-fill/mcp-direct）', async () => {
    const hooks = new HookRunner<LayerResult>()
    const veto = vi.fn(() => ({ veto: true, severity: 'block', reason: 'x' }))
    hooks.registerVeto({ pluginId: 'p1', position: 'pre-execute', check: veto })
    const config = makeConfig({
      hooks,
      layers: {
        l0: miss, l05: miss, l1: miss,
        l2: () => ({ kind: 'candidates', candidates: [{ id: 'a', name: 'A', score: 0.9 }] }),
        l3: miss, l4: miss
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect(outcome.kind).toBe('candidates')
    expect(veto).not.toHaveBeenCalled()
  })

  it('M15：请求开始快照——在途请求不受中途注册的钩子影响', async () => {
    const hooks = new HookRunner<LayerResult>()
    const config = makeConfig({
      hooks,
      layers: {
        l0: miss, l05: miss, l1: miss, l2: miss, l3: miss,
        l4: async () => {
          // 在途期间新注册的 advisory 不影响本请求
          hooks.registerAdvisory({ pluginId: 'late', layer: 'L4', contribute: () => ({ scoreDelta: 100 }) })
          return { kind: 'plan', plan: plan('l4') }
        }
      }
    })
    const outcome = await runFunnel(config, 'x', {})
    expect((outcome as { source: string }).source).toBe('L4')
  })
})
