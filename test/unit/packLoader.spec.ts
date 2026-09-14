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
  ingestPackText: vi.fn(async (text: string, packId: string, label?: string): Promise<KnowledgeEntry> => {
    if (text === 'FAIL') throw new Error('embedder down')
    return {
      id: `kb-${packId}-${label}`,
      filename: label ?? 'x',
      fileType: 'text/plain',
      chunks: 1,
      fingerprint: `fp-${label}`,
      createdAt: 0,
      ownerType: 'global',
      partition: 'pack',
      partitionId: packId
    }
  }),
  deleteKnowledgeEntry: vi.fn(async (_entryId: string): Promise<boolean> => true)
}))

import { PackLoader } from '@/host/pack/loader'
import type {
  PackExecution,
  PackKnowledgeFile,
  PackLifecycleEvent,
  PackSource,
  PackEvaluatorModule
} from '@/host/pack/types'
import {
  getAllConstraints,
  getExternalConstraintIds,
  removeExternalConstraints,
  runConstraints
} from '@/services/domainConstraints'
import { ingestPackText, deleteKnowledgeEntry } from '@/services/knowledgeBase'

interface PackData {
  manifest: unknown
  constraints?: unknown
  knowledge?: PackKnowledgeFile[]
  evaluators?: Record<string, PackEvaluatorModule>
  execution?: PackExecution | null
}

function makeSource(packs: Record<string, PackData>, opts?: { failListKnowledge?: boolean }): PackSource {
  return {
    listPackIds: () => Object.keys(packs),
    readManifest: (id: string) => packs[id]?.manifest ?? null,
    readConstraints: (id: string) => packs[id]?.constraints ?? null,
    listKnowledge: (id: string) => {
      if (opts?.failListKnowledge) throw new Error('fs broken')
      return packs[id]?.knowledge ?? []
    },
    listEvaluators: (id: string) => packs[id]?.evaluators ?? {},
    readExecution: (id: string) => packs[id]?.execution ?? null
  }
}

const GOOD_MANIFEST = {
  id: 'testpack',
  name: '测试包',
  version: '1.0.0',
  license: 'open-source',
  domain: 'legal',
  capabilities: {
    hooks: { advisory: ['L1'], veto: ['pre-output'], override: [] },
    clusters: []
  },
  compatibility: { minHostVersion: '0.1.0' }
}

const VALID_CONSTRAINT = {
  id: 'pack-test-alpha',
  category: '测试类目',
  description: '触发词命中即告警',
  severity: 'warning',
  applicability: { jurisdiction: 'PRC' },
  reliability: {
    confidence: 'high',
    source: { type: 'law', name: '测试法', article: '第一条', effectiveDate: '2024-01-01' }
  },
  automationLevel: 'full',
  reviewType: 'auto',
  trigger: { keywords: ['特殊触发词'] },
  action: { severity: 'warning', messageTemplate: '命中特殊触发词', requireHumanReview: false },
  evaluator: null,
  testCases: [
    { description: '命中', input: '文本包含特殊触发词', expectedTrigger: true },
    { description: '不命中', input: '普通文本', expectedTrigger: false }
  ]
}

function makeLoader(packs: Record<string, PackData>, opts?: { failListKnowledge?: boolean }): { loader: PackLoader; events: PackLifecycleEvent[] } {
  const loader = new PackLoader({ source: makeSource(packs, opts) })
  const events: PackLifecycleEvent[] = []
  loader.onLifecycle(e => events.push(e))
  return { loader, events }
}

describe('PackLoader M8：加载、校验、事务回滚与适配器注入', () => {
  let loader: PackLoader
  let events: PackLifecycleEvent[]

  beforeEach(() => {
    vi.mocked(ingestPackText).mockClear()
    vi.mocked(deleteKnowledgeEntry).mockClear()
  })

  afterEach(() => {
    const ids = getExternalConstraintIds()
    if (ids.length > 0) removeExternalConstraints(ids)
  })

  it('pack.json 缺失 → not-found 失败 + pack:mount-failed 事件', async () => {
    ;({ loader, events } = makeLoader({ ghost: { manifest: null } }))
    const result = await loader.mountPack('ghost')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('manifest')
      expect(result.error.reason).toBe('not-found')
    }
    expect(events.some(e => e.type === 'pack:mount-failed')).toBe(true)
  })

  it('manifest 缺必填字段 → schema 失败且错误指向字段路径', async () => {
    const bad = { ...GOOD_MANIFEST, capabilities: undefined, domain: '' }
    ;({ loader, events } = makeLoader({ testpack: { manifest: bad } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('manifest')
      expect(result.error.reason).toBe('schema')
      expect(result.error.detail).toContain('pack.json#/capabilities')
      expect(result.error.detail).toContain('pack.json#/domain')
    }
  })

  it('minHostVersion 不满足 → incompatible 拒载', async () => {
    const manifest = { ...GOOD_MANIFEST, compatibility: { minHostVersion: '9.0.0' } }
    ;({ loader, events } = makeLoader({ testpack: { manifest } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.reason).toBe('incompatible')
    }
  })

  it('constraints.json schema 错误 → boundary 失败且错误精确到 items/N/字段', async () => {
    const badConstraint = { ...VALID_CONSTRAINT, trigger: undefined }
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [badConstraint] } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('boundary')
      expect(result.error.reason).toBe('schema')
      expect(result.error.detail).toContain('constraints.json#/items/0/trigger')
    }
    expect(getExternalConstraintIds()).not.toContain('pack-test-alpha')
  })

  it('evaluator 文件缺失 → boundary schema 失败（module not found）', async () => {
    const withEvaluator = { ...VALID_CONSTRAINT, evaluator: 'boundary/evaluators/nope.ts' }
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [withEvaluator] } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('boundary')
      expect(result.error.detail).toContain('module not found: boundary/evaluators/nope.ts')
    }
  })

  it('knowledge 层失败 → 逆序回滚已摄取条目 + 不产生 pack:mounted', async () => {
    ;({ loader, events } = makeLoader({
      testpack: {
        manifest: GOOD_MANIFEST,
        knowledge: [
          { filename: 'a.txt', text: '第一条内容' },
          { filename: 'b.txt', text: 'FAIL' }
        ]
      }
    }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('knowledge')
    }
    expect(deleteKnowledgeEntry).toHaveBeenCalledWith('kb-testpack-a.txt')
    expect(events.some(e => e.type === 'pack:mounted')).toBe(false)
    expect(events.some(e => e.type === 'pack:mount-failed')).toBe(true)
  })

  it('listKnowledge 抛错 → 走失败路径而非未处理 rejection', async () => {
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST } }, { failListKnowledge: true }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('knowledge')
      expect(result.error.reason).toBe('internal')
    }
  })

  it('正常挂载：约束注入 runConstraints 管道 + pack:mounted 事件', async () => {
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [VALID_CONSTRAINT] } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.constraints.total).toBe(1)
      expect(result.constraints.disabled).toBe(0)
    }
    expect(getExternalConstraintIds()).toContain('pack-test-alpha')
    expect(getAllConstraints().some(c => c.id === 'pack-test-alpha')).toBe(true)
    expect(events.some(e => e.type === 'pack:mounted')).toBe(true)

    const fired = runConstraints({
      entities: [],
      sourceText: '这段话里出现了特殊触发词',
      outputText: '',
      stepResults: {},
      manifestRoles: []
    })
    expect(fired.some(r => r.constraintId === 'pack-test-alpha')).toBe(true)
  })

  it('mount 自检失败：坏一条禁一条（draft）不阻挂载 + warning', async () => {
    const broken = {
      ...VALID_CONSTRAINT,
      id: 'pack-test-broken',
      testCases: [
        { description: '期望触发但不触发', input: '普通文本', expectedTrigger: true },
        { description: '不触发', input: '另一段普通文本', expectedTrigger: false }
      ]
    }
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [VALID_CONSTRAINT, broken] } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.constraints.total).toBe(2)
      expect(result.constraints.disabled).toBe(1)
      expect(result.warnings.some(w => w.startsWith('constraint-self-check-failed:pack-test-broken'))).toBe(true)
    }
    const disabledConstraint = getAllConstraints().find(c => c.id === 'pack-test-broken')
    expect(disabledConstraint?.status).toBe('draft')

    // draft 不进 runConstraints 结果
    const fired = runConstraints({
      entities: [],
      sourceText: '普通文本',
      outputText: '',
      stepResults: {},
      manifestRoles: []
    })
    expect(fired.some(r => r.constraintId === 'pack-test-broken')).toBe(false)
  })

  it('与已装载约束同 id → 先装载者优先跳过 + warning（避免双重拦截）', async () => {
    const shared = { ...VALID_CONSTRAINT, id: 'legal-labor-contract-written' }
    ;({ loader, events } = makeLoader({
      testpack: { manifest: GOOD_MANIFEST, constraints: [shared] },
      testpack2: { manifest: { ...GOOD_MANIFEST, id: 'testpack2' }, constraints: [shared] }
    }))
    const first = await loader.mountPack('testpack')
    expect(first.ok).toBe(true)
    const second = await loader.mountPack('testpack2')
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.warnings.some(w => w.includes('constraint-skipped:legal-labor-contract-written') && w.includes('duplicate-id'))).toBe(true)
    }
    expect(getExternalConstraintIds().filter(id => id === 'legal-labor-contract-written')).toHaveLength(1)
  })

  it('重复 mount 同一 pack → already-mounted 拒绝', async () => {
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [VALID_CONSTRAINT] } }))
    await loader.mountPack('testpack')
    const second = await loader.mountPack('testpack')
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.reason).toBe('already-mounted')
    }
  })

  it('缺 constraints.json → 空边界层合法（挂载成功，0 条约束）', async () => {
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST } }))
    const result = await loader.mountPack('testpack')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.constraints.total).toBe(0)
    }
  })

  it('unmount：约束摘除 + 知识条目删除 + invalidateByPack + pack:unmounted 事件', async () => {
    ;({ loader, events } = makeLoader({
      testpack: {
        manifest: GOOD_MANIFEST,
        constraints: [VALID_CONSTRAINT],
        knowledge: [{ filename: 'law.txt', text: '劳动合同法第十条' }]
      }
    }))
    await loader.mountPack('testpack')
    expect(getExternalConstraintIds()).toContain('pack-test-alpha')

    const unmount = await loader.unmountPack('testpack')
    expect(unmount.ok).toBe(true)
    expect(unmount.removedConstraints).toBe(1)
    expect(unmount.removedKnowledge).toBe(1)
    expect(deleteKnowledgeEntry).toHaveBeenCalledWith('kb-testpack-law.txt')
    expect(getExternalConstraintIds()).not.toContain('pack-test-alpha')
    expect(getAllConstraints().some(c => c.id === 'pack-test-alpha')).toBe(false)
    expect(events.some(e => e.type === 'pack:unmounted')).toBe(true)
    expect(loader.isMounted('testpack')).toBe(false)
  })

  it('reloadPack（M19）：完整 unmount + mount 循环 + pack:reloaded 事件', async () => {
    ;({ loader, events } = makeLoader({ testpack: { manifest: GOOD_MANIFEST, constraints: [VALID_CONSTRAINT] } }))
    await loader.mountPack('testpack')
    const reload = await loader.reloadPack('testpack')
    expect(reload.ok).toBe(true)
    expect(events.filter(e => e.type === 'pack:unmounted').length).toBe(1)
    expect(events.filter(e => e.type === 'pack:mounted').length).toBe(2)
    expect(events.some(e => e.type === 'pack:reloaded')).toBe(true)
    expect(getExternalConstraintIds()).toContain('pack-test-alpha')
    await loader.unmountPack('testpack')
  })
})
