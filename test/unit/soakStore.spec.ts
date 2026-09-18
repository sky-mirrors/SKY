import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

// ===== 可控 vault 存储 + fileWrite mock（真实 vault 单例 + 真实 globalBus）=====
let vaultData: Record<string, string | null> = {}
const fileWriteMock = vi.fn().mockResolvedValue({ success: true })

vi.stubGlobal('window', {
  electronAPI: {
    vaultRead: vi.fn().mockImplementation((ns: string, key: string) =>
      Promise.resolve(vaultData[`${ns}:${key}`] ?? null)),
    vaultWrite: vi.fn().mockResolvedValue(undefined),
    vaultDelete: vi.fn().mockResolvedValue(undefined),
    fileWrite: fileWriteMock,
    resolvePath: vi.fn().mockResolvedValue('C:\\Users\\Test')
  }
})

import { useSoakStore } from '@/stores/soakStore'
import type { SoakShadowRecord } from '@/stores/soakStore'

/** 上游契约（dialogStore.runFunnelShadow :655-670）：嵌套 funnel 对象 + 顶层 legacyTrail */
function makeShadowPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: '帮我审查这份合同',
    funnel: { kind: 'plan', source: 'l1-task-translator', intent: 'contract-review' },
    legacyEndpoint: 'l2',
    funnelEndpoint: 'l1-task-translator',
    match: true,
    durationMs: 120,
    traceId: 'trace-1',
    legacyTrail: ['[L1] 翻译', '[L2] 候选'],
    ...overrides
  }
}

function makeRoutedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handled: true,
    kind: 'plan',
    source: 'l1-task-translator',
    intent: 'contract-review',
    autoExecutable: true,
    ts: 1700000000000,
    traceId: 'trace-1',
    ...overrides
  }
}

describe('soakStore（浸泡验证数据管道，A6/R15）', () => {
  beforeEach(() => {
    vaultData = {}
    vault.clearCache()
    globalBus.clear()
    fileWriteMock.mockClear()
    const pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    useSoakStore().dispose()
    globalBus.clear()
  })

  it('未启用（holo-funnel-shadow != "1"）：init 零订阅，事件不收集', async () => {
    const store = useSoakStore()
    await store.init()

    expect(store.soakEnabled).toBe(false)
    globalBus.emit('funnel:shadow-diff', makeShadowPayload())
    globalBus.emit('funnel:routed', makeRoutedPayload())

    expect(store.shadowRecords).toHaveLength(0)
    expect(store.routedRecords).toHaveLength(0)
  })

  it('启用：init 幂等（重复调用不重复订阅）', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()
    await store.init()

    globalBus.emit('funnel:shadow-diff', makeShadowPayload())

    expect(store.shadowRecords).toHaveLength(1)
  })

  it('funnel:shadow-diff → unshift + vault 持久化（readCache 可见，字段映射正确）', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()

    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: false, durationMs: 300 }))

    expect(store.shadowRecords).toHaveLength(1)
    const r = store.shadowRecords[0]
    expect(r.input).toBe('帮我审查这份合同')
    expect(r.funnelKind).toBe('plan')
    expect(r.funnelSource).toBe('l1-task-translator')
    expect(r.funnelIntent).toBe('contract-review')
    expect(r.match).toBe(false)
    expect(r.durationMs).toBe(300)
    expect(r.traceId).toBe('trace-1')
    expect(r.legacyTrail).toEqual(['[L1] 翻译', '[L2] 候选'])

    const persisted = vault.readCache('soak', 'shadow-reports')
    expect(persisted).toBeTruthy()
    const parsed = JSON.parse(persisted!) as SoakShadowRecord[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].match).toBe(false)
  })

  it('funnel:routed → unshift + vault 持久化', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()

    globalBus.emit('funnel:routed', makeRoutedPayload({ handled: false, kind: 'direct' }))

    expect(store.routedRecords).toHaveLength(1)
    expect(store.routedRecords[0].handled).toBe(false)
    expect(store.routedRecords[0].kind).toBe('direct')
    expect(store.routedRecords[0].ts).toBe(1700000000000)
    expect(vault.readCache('soak', 'routed-records')).toContain('"kind":"direct"')
  })

  it('cap 500：灌 502 条只保留最新 500', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()

    for (let i = 0; i < 502; i++) {
      globalBus.emit('funnel:shadow-diff', makeShadowPayload({ input: `样本-${i}` }))
    }

    expect(store.shadowRecords).toHaveLength(500)
    // unshift 保最新：首条是最后 emit 的样本-501
    expect(store.shadowRecords[0].input).toBe('样本-501')
  })

  it('load 容错：坏 JSON 置空不抛，好数据正常载入', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    vaultData['soak:shadow-reports'] = '{broken json'
    vaultData['soak:routed-records'] = JSON.stringify([
      { handled: true, kind: 'plan', source: 'l1', ts: 1700000000000 }
    ])

    const store = useSoakStore()
    await store.init()

    expect(store.shadowRecords).toHaveLength(0)
    expect(store.routedRecords).toHaveLength(1)
    expect(store.routedRecords[0].kind).toBe('plan')
  })

  it('soakSummary 数学：match 3 / mismatch 1 / null 2 → matchRate=0.75、manualReviewCount=2', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()

    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: true }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: true }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: true }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: false }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: null }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: null }))
    globalBus.emit('funnel:routed', makeRoutedPayload({ handled: true }))
    globalBus.emit('funnel:routed', makeRoutedPayload({ handled: false }))

    const s = store.soakSummary
    expect(s.shadowTotal).toBe(6)
    expect(s.matchCount).toBe(3)
    expect(s.mismatchCount).toBe(1)
    expect(s.manualReviewCount).toBe(2)
    expect(s.matchRate).toBeCloseTo(0.75)
    expect(s.routedTotal).toBe(2)
    expect(s.handledCount).toBe(1)
    expect(s.firstTs).not.toBeNull()
    expect(s.lastTs).not.toBeNull()
  })

  it('exportSoakReport：fileWrite 落盘 soak-report.json + 报告结构完整', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: false }))
    globalBus.emit('funnel:shadow-diff', makeShadowPayload({ match: true }))

    const path = await store.exportSoakReport()

    expect(path).toContain('soak-report.json')
    expect(fileWriteMock).toHaveBeenCalledTimes(1)
    const arg = fileWriteMock.mock.calls[0][0] as { filePath: string; content: string }
    expect(arg.filePath).toContain('soak-report.json')
    const report = JSON.parse(arg.content)
    expect(report.summary.shadowTotal).toBe(2)
    expect(report.summary.mismatchCount).toBe(1)
    expect(report.mismatchSamples).toHaveLength(1)
    expect(report.mismatchSamples[0].match).toBe(false)
    expect(report.byFunnelKind['plan']).toBe(2)
    expect(report.generatedAt).toBeGreaterThan(0)
    expect(store.lastExportPath).toBe(path)
  })

  it('dispose 后 emit 不再计入', async () => {
    vaultData['config:holo-funnel-shadow'] = '1'
    const store = useSoakStore()
    await store.init()
    store.dispose()

    globalBus.emit('funnel:shadow-diff', makeShadowPayload())

    expect(store.shadowRecords).toHaveLength(0)
    expect(store.soakEnabled).toBe(false)
  })
})
