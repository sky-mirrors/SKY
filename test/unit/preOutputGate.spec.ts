import { describe, it, expect, vi } from 'vitest'
import { createDefaultKernelPlugin } from '@/kernels/default/plugin'
import type { DefaultKernelPlugin } from '@/kernels/default/plugin'
import { runVetoGate, type VetoHookEntry, type VetoResult } from '@/kernel/hooks'

/** 构造一个注册了若干 pre-output 钩子的默认内核插件 */
function pluginWithVetoes(hooks: Array<(payload: unknown) => VetoResult>): DefaultKernelPlugin {
  const plugin = createDefaultKernelPlugin()
  const runner = plugin.getHooks()
  for (const [i, check] of hooks.entries()) {
    runner.registerVeto({
      pluginId: `pack-${i}`,
      position: 'pre-output',
      hasPermission: true,
      check: (payload: unknown) => check(payload)
    })
  }
  return plugin
}

describe('DefaultKernelPlugin.runPreOutputGate（A2-9 pre-output 门）', () => {
  it('无钩子 → 无门：blocked=false 且零 entries（天然 fail-open）', () => {
    const plugin = createDefaultKernelPlugin()
    const report = plugin.runPreOutputGate('任意输出', {})
    expect(report.blocked).toBe(false)
    expect(report.entries).toHaveLength(0)
    expect(report.warnings).toHaveLength(0)
    expect(report.humanJudgmentPrompts).toHaveLength(0)
  })

  it('block 级命中 → blocked=true 且 entries 携带 pluginId/reason', () => {
    const plugin = pluginWithVetoes([
      () => ({ veto: true, severity: 'block', reason: '金额超限' })
    ])
    const report = plugin.runPreOutputGate('转账 100 万', {})
    expect(report.blocked).toBe(true)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ pluginId: 'pack-0', severity: 'block', reason: '金额超限' })
  })

  it('warn 级命中 → 记录 entries 但不 blocked', () => {
    const plugin = pluginWithVetoes([
      () => ({ veto: true, severity: 'warn', reason: '建议人工复核' })
    ])
    const report = plugin.runPreOutputGate('普通输出', {})
    expect(report.blocked).toBe(false)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].severity).toBe('warn')
  })

  it('钩子抛错：默认 fail-open 放行；strictVeto=true → fail-closed 拦截', () => {
    const boom: () => VetoResult = () => { throw new Error('hook exploded') }
    const plugin = pluginWithVetoes([boom])

    const lax = plugin.runPreOutputGate('输出', {})
    expect(lax.blocked).toBe(false)
    expect(lax.warnings.some(w => w.includes('fail-open'))).toBe(true)

    const strict = plugin.runPreOutputGate('输出', { strictVeto: true })
    expect(strict.blocked).toBe(true)
    expect(strict.entries[0].reason).toContain('strict-mode')
  })

  it('humanJudgmentPrompt 非空 → 聚合进报告（适配层据此保守拦截）', () => {
    const plugin = pluginWithVetoes([
      () => ({ veto: true, severity: 'block', reason: '高风险操作', humanJudgmentPrompt: '请法务确认' })
    ])
    const report = plugin.runPreOutputGate('高风险内容', {})
    expect(report.humanJudgmentPrompts).toEqual(['请法务确认'])
  })

  it('hasPermission=false 的钩子被跳过并告警', () => {
    const plugin = createDefaultKernelPlugin()
    plugin.getHooks().registerVeto({
      pluginId: 'no-perm-pack',
      position: 'pre-output',
      hasPermission: false,
      check: () => ({ veto: true, severity: 'block', reason: '不应生效' })
    })
    const report = plugin.runPreOutputGate('输出', {})
    expect(report.blocked).toBe(false)
    expect(report.warnings.some(w => w.includes('no-perm-pack'))).toBe(true)
  })

  it('门取注册表现值：route 返回后新注册的钩子在下次门调用生效（非请求级快照）', async () => {
    const plugin = createDefaultKernelPlugin()
    // 模拟 route() 已返回后再挂载 pack（经 packHookBridge 注册）
    const before = plugin.runPreOutputGate('输出', {})
    expect(before.blocked).toBe(false)

    plugin.getHooks().registerVeto({
      pluginId: 'late-pack',
      position: 'pre-output',
      hasPermission: true,
      check: () => ({ veto: true, severity: 'block', reason: '后到钩子生效' })
    })
    const after = plugin.runPreOutputGate('输出', {})
    expect(after.blocked).toBe(true)
  })

  it('payload 原样透传给钩子 check', () => {
    const seen: unknown[] = []
    const plugin = pluginWithVetoes([(payload: unknown) => {
      seen.push(payload)
      return { veto: false, severity: 'warn', reason: '' }
    }])
    plugin.runPreOutputGate('最终输出文本', {})
    expect(seen).toEqual(['最终输出文本'])
  })
})

describe('runVetoGate 聚合（pre-output 门底层语义回归）', () => {
  it('全量评估不短路：多个 block 全部入 entries', () => {
    const hooks: VetoHookEntry[] = [
      { pluginId: 'a', position: 'pre-output', seq: 1, check: () => ({ veto: true, severity: 'block', reason: 'A' }) },
      { pluginId: 'b', position: 'pre-output', seq: 2, check: () => ({ veto: true, severity: 'block', reason: 'B' }) }
    ]
    const report = runVetoGate(hooks, 'x', {})
    expect(report.blocked).toBe(true)
    expect(report.entries.map(e => e.reason)).toEqual(['A', 'B'])
  })

  it('check 返回非对象 → 视为无否决（防御）', () => {
    const hooks = [
      { pluginId: 'bad', position: 'pre-output' as const, seq: 1, check: () => null as unknown as VetoResult }
    ]
    const report = runVetoGate(hooks, 'x', {})
    expect(report.blocked).toBe(false)
    expect(report.entries).toHaveLength(0)
  })

  it('vetoes 未注册时 unregisterPlugin 幂等（桥的注销路径）', () => {
    const plugin = createDefaultKernelPlugin()
    expect(() => plugin.getHooks().unregisterPlugin('ghost')).not.toThrow()
  })

  it('unmount 后 HookRunner 重建（换内核 = 换钩子表，M4/M15）', async () => {
    const plugin = createDefaultKernelPlugin()
    plugin.getHooks().registerVeto({
      pluginId: 'p', position: 'pre-output', hasPermission: true,
      check: () => ({ veto: true, severity: 'block', reason: 'x' })
    })
    await plugin.unmount()
    expect(plugin.getHooks().getVetoes()).toHaveLength(0)
  })
})
