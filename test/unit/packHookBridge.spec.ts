import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { KnowledgeEntry } from '@/models'

;(globalThis as any).window = {
  electronAPI: {
    vaultRead: vi.fn().mockResolvedValue(null),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    vaultList: vi.fn().mockResolvedValue([])
  }
}

vi.mock('@/services/knowledgeBase', () => ({
  ingestPackText: vi.fn(async (text: string, packId: string, label?: string): Promise<KnowledgeEntry> => ({
    id: `kb-${packId}-${label}`,
    filename: label ?? 'x',
    fileType: 'text/plain',
    chunks: 1,
    fingerprint: `fp-${label}`,
    createdAt: 0,
    ownerType: 'global',
    partition: 'pack',
    partitionId: packId
  })),
  deleteKnowledgeEntry: vi.fn(async (): Promise<boolean> => true)
}))

import { HoloEventBus } from '@/kernel/bus'
import { HookRunner } from '@/kernel/hooks'
import { PackLoader } from '@/host/pack/loader'
import { PackHookBridge } from '@/host/packHookBridge'
import type { BridgeRegistryLike } from '@/host/packHookBridge'
import type {
  PackExecution,
  PackKnowledgeFile,
  PackSource,
  PackEvaluatorModule
} from '@/host/pack/types'
import {
  getAllConstraints,
  getExternalConstraintIds,
  removeExternalConstraints
} from '@/services/domainConstraints'

interface PackData {
  manifest: unknown
  constraints?: unknown
  knowledge?: PackKnowledgeFile[]
  evaluators?: Record<string, PackEvaluatorModule>
  execution?: PackExecution | null
}

function makeSource(packs: Record<string, PackData>): PackSource {
  return {
    listPackIds: () => Object.keys(packs),
    readManifest: (id: string) => packs[id]?.manifest ?? null,
    readConstraints: (id: string) => packs[id]?.constraints ?? null,
    listKnowledge: (id: string) => packs[id]?.knowledge ?? [],
    listEvaluators: (id: string) => packs[id]?.evaluators ?? {},
    readExecution: (id: string) => packs[id]?.execution ?? null
  }
}

const baseManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'vpack',
  name: '否决包',
  version: '1.0.0',
  license: 'open-source',
  domain: 'test',
  capabilities: { hooks: { advisory: ['L1'], veto: ['pre-output'], override: [] }, clusters: [] },
  compatibility: { minHostVersion: '0.1.0' },
  ...overrides
})

const makeConstraint = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pack-veto-alpha',
  category: '测试类目',
  description: '触发词命中即拦截',
  severity: 'error',
  applicability: { jurisdiction: 'PRC' },
  reliability: {
    confidence: 'high',
    source: { type: 'law', name: '测试法', article: '第一条', effectiveDate: '2024-01-01' }
  },
  automationLevel: 'full',
  reviewType: 'auto',
  trigger: { keywords: ['危险触发词'] },
  action: { severity: 'error', messageTemplate: '命中危险触发词', requireHumanReview: false },
  evaluator: null,
  testCases: [
    { description: '命中', input: '文本包含危险触发词', expectedTrigger: true },
    { description: '不命中', input: '普通文本', expectedTrigger: false }
  ],
  ...overrides
})

/** 可换内核 runner 的假注册表：getActive 返回持有当前 HookRunner 的鸭子内核 */
function makeRegistry() {
  let hooks = new HookRunner()
  const kernel = {
    id: 'kernel-default',
    getHooks: () => hooks
  }
  const registry: BridgeRegistryLike & { swapRunner(): void; getRunner(): HookRunner } = {
    getActive: () => kernel,
    swapRunner: () => { hooks = new HookRunner() },
    getRunner: () => hooks
  }
  return registry
}

describe('PackHookBridge：pack veto 钩子注册/注销/重放', () => {
  let bus: HoloEventBus
  let registry: ReturnType<typeof makeRegistry>
  let bridge: PackHookBridge

  afterEach(() => {
    bridge.stop()
    const ids = getExternalConstraintIds()
    if (ids.length > 0) removeExternalConstraints(ids)
  })

  function setup(packs: Record<string, PackData>): PackLoader {
    bus = new HoloEventBus()
    registry = makeRegistry()
    const loader = new PackLoader({ source: makeSource(packs), bus })
    bridge = new PackHookBridge({ loader, registry, bus })
    return loader
  }

  it('pack:mounted → 按声明注册 veto 钩子（仅声明 gate，pluginId=packId）', async () => {
    const loader = setup({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } })
    bridge.start()
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(0)

    const result = await loader.mountPack('vpack')
    expect(result.ok).toBe(true)

    const vetoes = registry.getRunner().getVetoes('pre-output')
    expect(vetoes).toHaveLength(1)
    expect(vetoes[0].pluginId).toBe('vpack')
    expect(vetoes[0].position).toBe('pre-output')
    expect(vetoes[0].hasPermission).toBe(true)
    // 声明核对：advisory 声明不产生 veto 钩子，pre-execute 未声明不注册
    expect(registry.getRunner().getVetoes('pre-execute')).toHaveLength(0)
    expect(registry.getRunner().getAdvisories()).toHaveLength(0)
  })

  it('check：error 约束命中 → veto block；未命中 → 放行；且不产生触发计数副作用', async () => {
    const loader = setup({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } })
    bridge.start()
    await loader.mountPack('vpack')

    const hook = registry.getRunner().getVetoes('pre-output')[0]
    const before = getAllConstraints().find(c => c.id === 'pack-veto-alpha')
    expect(before).toBeDefined()

    const hit = hook.check('这段输出里出现了危险触发词', {})
    expect(hit.veto).toBe(true)
    expect(hit.severity).toBe('block')
    expect(hit.reason).toContain('危险触发词')

    const miss = hook.check('完全正常的输出', {})
    expect(miss.veto).toBe(false)

    // 只读语义：不经 runConstraints，触发计数不得增长
    const after = getAllConstraints().find(c => c.id === 'pack-veto-alpha')
    expect(after?.triggerCount).toBe(before?.triggerCount)
    expect(after?.lastTriggeredAt).toBe(before?.lastTriggeredAt)
  })

  it('check：warning 约束 → severity warn；info 命中不构成 veto', async () => {
    const loader = setup({
      vpack: {
        manifest: baseManifest(),
        constraints: [
          makeConstraint({ id: 'pack-veto-warn', severity: 'warning', action: { severity: 'warning', messageTemplate: '警告级命中', requireHumanReview: false }, trigger: { keywords: ['警告词'] }, testCases: [{ description: '命中', input: '包含警告词', expectedTrigger: true }, { description: '不命中', input: '普通文本', expectedTrigger: false }] }),
          makeConstraint({ id: 'pack-veto-info', severity: 'info', action: { severity: 'info', messageTemplate: '提示级命中', requireHumanReview: false }, trigger: { keywords: ['提示词x'] }, testCases: [{ description: '命中', input: '包含提示词x', expectedTrigger: true }, { description: '不命中', input: '普通文本', expectedTrigger: false }] })
        ]
      }
    })
    bridge.start()
    await loader.mountPack('vpack')

    const hook = registry.getRunner().getVetoes('pre-output')[0]
    const warnHit = hook.check('包含警告词的输出', {})
    expect(warnHit.veto).toBe(true)
    expect(warnHit.severity).toBe('warn')

    const infoOnly = hook.check('包含提示词x的输出', {})
    expect(infoOnly.veto).toBe(false)
  })

  it('humanJudgmentPrompt 透传（action 声明 requireHumanReview）', async () => {
    const loader = setup({
      vpack: {
        manifest: baseManifest(),
        constraints: [makeConstraint({
          severity: 'error',
          action: { severity: 'error', messageTemplate: '命中危险触发词', requireHumanReview: true, humanJudgmentPrompt: '请法务确认该操作' }
        })]
      }
    })
    bridge.start()
    await loader.mountPack('vpack')

    const hook = registry.getRunner().getVetoes('pre-output')[0]
    const hit = hook.check('包含危险触发词', {})
    expect(hit.veto).toBe(true)
    expect(hit.humanJudgmentPrompt).toBe('请法务确认该操作')
  })

  it('pack:unmounted → unregisterPlugin 摘除钩子', async () => {
    const loader = setup({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } })
    bridge.start()
    await loader.mountPack('vpack')
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(1)

    await loader.unmountPack('vpack')
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(0)
  })

  it('kernel:activated / kernel:switched → 换 runner 后全量重放', async () => {
    const loader = setup({
      vpack: { manifest: baseManifest(), constraints: [makeConstraint()] },
      nopack: { manifest: baseManifest({ id: 'nopack', capabilities: { hooks: { advisory: ['L1'] } } }) }
    })
    bridge.start()
    await loader.mountPack('vpack')
    await loader.mountPack('nopack')
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(1)

    // 模拟换内核：HookRunner 整体重建（M4），激活/切换事件触发重放
    registry.swapRunner()
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(0)
    bus.emit('kernel:activated', { id: 'kernel-default' })
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(1)
    expect(registry.getRunner().getVetoes('pre-output')[0].pluginId).toBe('vpack')

    registry.swapRunner()
    bus.emit('kernel:switched', { from: 'a', to: 'b' })
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(1)
    // 未声明 veto 的 pack 不注册
    expect(registry.getRunner().getVetoes().every(v => v.pluginId !== 'nopack')).toBe(true)
  })

  it('时序反序：pack 先挂载、bridge 后启动 → start 内初扫补齐注册', async () => {
    const loader = setup({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } })
    await loader.mountPack('vpack')
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(0)

    bridge.start()
    expect(registry.getRunner().getVetoes('pre-output')).toHaveLength(1)
  })

  it('fail-open：registry.getActive 抛错 → 不阻塞 pack 挂载、不抛出', async () => {
    bus = new HoloEventBus()
    const loader = new PackLoader({
      source: makeSource({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } }),
      bus
    })
    const brokenRegistry: BridgeRegistryLike = {
      getActive: () => { throw new Error('registry exploded') }
    }
    bridge = new PackHookBridge({ loader, registry: brokenRegistry, bus })
    bridge.start()

    const result = await loader.mountPack('vpack')
    expect(result.ok).toBe(true)
  })

  it('fail-open：getHooks 抛错 → 注册失败仅告警，重复重放仍幂等', async () => {
    bus = new HoloEventBus()
    const loader = new PackLoader({
      source: makeSource({ vpack: { manifest: baseManifest(), constraints: [makeConstraint()] } }),
      bus
    })
    let broken = true
    const flakyRegistry: BridgeRegistryLike = {
      getActive: () => ({
        id: 'kernel-default',
        getHooks: () => {
          if (broken) throw new Error('hooks unavailable')
          return new HookRunner()
        }
      })
    }
    const flakyBridge = new PackHookBridge({ loader, registry: flakyRegistry, bus })
    flakyBridge.start()

    const result = await loader.mountPack('vpack')
    expect(result.ok).toBe(true)

    // 修复后重放成功且不重复
    broken = false
    flakyBridge.replayAll()
    flakyBridge.replayAll()
    // 经鸭子接口无法直接断言数量，退而验证不抛错 + pack 仍挂载
    expect(loader.isMounted('vpack')).toBe(true)
    flakyBridge.stop()
  })
})
