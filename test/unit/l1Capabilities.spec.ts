import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  L1_CAPABILITIES,
  isKnownL1Capability,
  auditRequiredL1,
  describeRequiredL1
} from '@/services/l1Capabilities'
import l2Manifests from '@/data/l2Manifests'

// G-11（2026-09-25 修复）：requiredL1 此前全仓零消费者，且 `l1-media-ops` 是悬空引用
// （唯一声明它的「音视频处理」manifest 指向了一个全仓零定义的 id）。本模块是它的权威定义点。
describe('L1 能力注册表 · l1Capabilities', () => {
  it('登记了全部 9 个被 requiredL1 引用的能力（含此前悬空的 l1-media-ops）', () => {
    for (const id of [
      'l1-model-gateway', 'l1-knowledge-feeder', 'l1-task-translator', 'l1-pipeline-builder',
      'l1-workspace-memory', 'l1-result-beautifier', 'l1-doc-convert', 'l1-image-ops', 'l1-media-ops'
    ]) {
      expect(isKnownL1Capability(id)).toBe(true)
      expect(L1_CAPABILITIES[id]).toBeTruthy()
    }
    expect(isKnownL1Capability('l1-not-a-real-capability')).toBe(false)
  })

  it('现网 l2Manifests 的 requiredL1 无一处悬空引用（审计干净）', () => {
    expect(auditRequiredL1(l2Manifests)).toEqual([])
  })

  it('审计能抓出悬空引用（反例：本条若不成立，G-11 就等于没修）', () => {
    const bad = [
      { identity: { id: 'm-bad', name: '坏 manifest' }, routing: { requiredL1: ['l1-task-translator', 'l1-ghost'] } }
    ]
    const v = auditRequiredL1(bad)
    expect(v).toHaveLength(1)
    expect(v[0].manifestId).toBe('m-bad')
    expect(v[0].missing).toEqual(['l1-ghost'])
  })

  it('describeRequiredL1 映射为可读标签，未登记 id 原样保留（不吞问题）', () => {
    expect(describeRequiredL1(['l1-task-translator'])).toEqual([L1_CAPABILITIES['l1-task-translator']])
    expect(describeRequiredL1(['l1-ghost'])).toEqual(['l1-ghost'])
    expect(describeRequiredL1(undefined)).toEqual([])
  })
})

// 源码级接线断言：守住「requiredL1 真被消费/校验」两条不变量，防回退为只写不读。
describe('G-11 接线：消费 + 校验', () => {
  const kernel = readFileSync(join(process.cwd(), 'src/kernels/default/index.ts'), 'utf-8')
  const plugin = readFileSync(join(process.cwd(), 'src/kernels/default/plugin.ts'), 'utf-8')

  it('plan.needs 经 manifestPlanNeeds 消费 requiredL1', () => {
    expect(kernel).toContain('function manifestPlanNeeds')
    expect(kernel).toContain('m.routing.requiredL1')
    expect(kernel).not.toContain('needs: m.routing.keywords.slice(0, 3),')
  })

  it('内核挂载期审计 requiredL1 完整性（warn 暴露，不静默）', () => {
    expect(plugin).toContain('auditRequiredL1')
    expect(plugin).toContain('logger.warn')
  })
})
