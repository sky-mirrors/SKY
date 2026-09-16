import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/vault', () => ({
  vault: {
    list: vi.fn(async () => []),
    read: vi.fn(async () => null),
    writeThrough: vi.fn()
  }
}))

import {
  computeBidScore,
  resolveCompetition,
  QualityEmaStore,
  EMA_OUTCOME_SUCCESS,
  EMA_OUTCOME_FAILURE,
  EMA_OUTCOME_NEGATIVE_FEEDBACK,
  runShadowEvaluation,
  type PackBidder,
  type EmaPersistence,
  type ShadowAuditEntry
} from '@/kernel/competition'

function makeBidder(over: Partial<PackBidder> & { packId: string }): PackBidder {
  return { confidence: 0.8, weight: 1, ema: 1, seq: 0, ...over }
}

/** 内存 EmaPersistence：list 返回 'packId:value' 形式的原始全键（模拟 vault 客户端行为） */
function makePersistence(over: { list?: string[]; read?: Map<string, string> } = {}): EmaPersistence & {
  written: Map<string, string>
} {
  const written = new Map<string, string>()
  return {
    written,
    list: vi.fn(async () => over.list ?? []),
    read: vi.fn(async (_ns: string, key: string) => over.read?.get(key) ?? null),
    writeThrough: vi.fn((_ns: string, key: string, value: string) => { written.set(key, value) })
  }
}

describe('M16：竞标分 computeBidScore', () => {
  it('竞标分 = 置信度 × weight × 质量EMA', () => {
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: 0.8, weight: 1.5, ema: 0.5 }))).toBeCloseTo(0.6)
  })

  it('confidence 非有限数按 0 计 → 竞标分 0', () => {
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: Number.NaN }))).toBe(0)
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: Number.POSITIVE_INFINITY }))).toBe(0)
  })

  it('weight 非有限数回退 1、ema 非有限数回退初始 1.0', () => {
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: 0.5, weight: Number.NaN }))).toBeCloseTo(0.5)
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: 0.5, ema: Number.NaN }))).toBeCloseTo(0.5)
  })

  it('负值输入 clamp 到 0，不产生负分', () => {
    expect(computeBidScore(makeBidder({ packId: 'p-a', confidence: -0.5, weight: 2, ema: 2 }))).toBe(0)
  })
})

describe('M16：竞争消解 resolveCompetition', () => {
  it('少于 2 个投标者 → null（无竞争）', () => {
    expect(resolveCompetition([])).toBeNull()
    expect(resolveCompetition([makeBidder({ packId: 'p-a' })])).toBeNull()
  })

  it('竞标分降序：高分者胜，败者列表降序', () => {
    const high = makeBidder({ packId: 'p-high', confidence: 0.9, seq: 2 })
    const mid = makeBidder({ packId: 'p-mid', confidence: 0.6, seq: 1 })
    const low = makeBidder({ packId: 'p-low', confidence: 0.3, seq: 0 })
    const r = resolveCompetition([low, high, mid])
    expect(r?.winner.packId).toBe('p-high')
    expect(r?.losers.map(l => l.packId)).toEqual(['p-mid', 'p-low'])
  })

  it('竞标分平分 → weight 高者胜', () => {
    const heavy = makeBidder({ packId: 'p-heavy', confidence: 0.5, weight: 2, seq: 5 })
    const light = makeBidder({ packId: 'p-light', confidence: 0.5, weight: 1, seq: 0 })
    const r = resolveCompetition([light, heavy])
    expect(r?.winner.packId).toBe('p-heavy')
  })

  it('竞标分与 weight 全平 → seq 小者胜（注册顺序确定性兜底）', () => {
    const first = makeBidder({ packId: 'p-first', confidence: 0.5, weight: 1, seq: 0 })
    const second = makeBidder({ packId: 'p-second', confidence: 0.5, weight: 1, seq: 1 })
    const r = resolveCompetition([second, first])
    expect(r?.winner.packId).toBe('p-first')
    expect(r?.losers[0].packId).toBe('p-second')
  })
})

describe('M16：质量 EMA 存储 QualityEmaStore', () => {
  it('初始值 1.0（未记录与 load 后均回退 1.0）', () => {
    const store = new QualityEmaStore(makePersistence())
    expect(store.get('p-unknown')).toBe(1.0)
  })

  it('EMA 更新：ema = 0.9×ema + 0.1×outcome，连续失败单调收敛向 0', () => {
    const store = new QualityEmaStore(makePersistence())
    store.update('p-a', EMA_OUTCOME_FAILURE)
    expect(store.get('p-a')).toBeCloseTo(0.9)
    store.update('p-a', EMA_OUTCOME_FAILURE)
    expect(store.get('p-a')).toBeCloseTo(0.81)
    store.update('p-a', EMA_OUTCOME_FAILURE)
    expect(store.get('p-a')).toBeCloseTo(0.729)
  })

  it('负反馈 outcome=0.2 与成功 outcome=1.0 的混合更新', () => {
    const store = new QualityEmaStore(makePersistence())
    store.update('p-a', EMA_OUTCOME_NEGATIVE_FEEDBACK)
    expect(store.get('p-a')).toBeCloseTo(0.9 * 1.0 + 0.1 * 0.2)
    store.update('p-a', EMA_OUTCOME_SUCCESS)
    expect(store.get('p-a')).toBeCloseTo(0.9 * 0.92 + 0.1 * 1.0)
  })

  it('outcome 越界 clamp 到 [0,1]，EMA 结果永不越界', () => {
    const store = new QualityEmaStore(makePersistence())
    store.update('p-a', 5)
    expect(store.get('p-a')).toBe(1.0)
    store.update('p-b', -3)
    expect(store.get('p-b')).toBeCloseTo(0.9)
    store.update('p-b', Number.NaN)
    expect(store.get('p-b')).toBeCloseTo(0.81)
  })

  it('update 经 writeThrough 持久化到 packStats 命名空间', () => {
    const persistence = makePersistence()
    const store = new QualityEmaStore(persistence)
    store.update('p-a', EMA_OUTCOME_FAILURE)
    expect(persistence.written.get('p-a')).toBe('0.9')
    expect(persistence.writeThrough).toHaveBeenCalledWith('packStats', 'p-a', '0.9')
  })

  it('writeThrough 抛错不阻断内存 EMA 更新', () => {
    const persistence = makePersistence()
    persistence.writeThrough = vi.fn(() => { throw new Error('disk full') })
    const store = new QualityEmaStore(persistence)
    expect(() => store.update('p-a', EMA_OUTCOME_FAILURE)).not.toThrow()
    expect(store.get('p-a')).toBeCloseTo(0.9)
  })

  it('load()：合法键值装载并 clamp；非法 packId / 非数 / 越界 / 空值全部跳过', async () => {
    const persistence = makePersistence({
      list: ['packStats:p-ok', 'packStats:Bad_Id', 'packStats:p-over', 'packStats:p-nan', 'packStats:p-null'],
      read: new Map([
        ['p-ok', '0.5'],
        ['Bad_Id', '0.7'],
        ['p-over', '2.5'],
        ['p-nan', 'abc'],
        ['p-null', 'ignored']
      ])
    })
    // read 对 p-null 返回 null（Map 中占位值不生效）
    persistence.read = vi.fn(async (_ns: string, key: string) =>
      key === 'p-null' ? null : (persistence.written.get(key) ?? null))
    const readMap = new Map([['p-ok', '0.5'], ['p-over', '2.5'], ['p-nan', 'abc']])
    persistence.read = vi.fn(async (_ns: string, key: string) => readMap.get(key) ?? null)

    const store = new QualityEmaStore(persistence)
    await store.load()
    expect(store.get('p-ok')).toBe(0.5)
    expect(store.get('p-over')).toBe(1.0)
    // 非法条目回退初始 1.0
    expect(store.get('Bad_Id')).toBe(1.0)
    expect(store.get('p-nan')).toBe(1.0)
    expect(store.get('p-null')).toBe(1.0)
  })

  it('load()：list 抛错静默返回，不影响后续 get', async () => {
    const persistence = makePersistence()
    persistence.list = vi.fn(async () => { throw new Error('io') })
    const store = new QualityEmaStore(persistence)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get('p-a')).toBe(1.0)
  })

  it('load()：单键 read 抛错跳过，其余键正常装载', async () => {
    const persistence = makePersistence({ list: ['packStats:p-ok', 'packStats:p-err'] })
    const readMap = new Map([['p-ok', '0.4']])
    persistence.read = vi.fn(async (_ns: string, key: string) => {
      if (key === 'p-err') throw new Error('io')
      return readMap.get(key) ?? null
    })
    const store = new QualityEmaStore(persistence)
    await store.load()
    expect(store.get('p-ok')).toBe(0.4)
    expect(store.get('p-err')).toBe(1.0)
  })
})

describe('M16：影子评估 runShadowEvaluation（规格 9.1 零副作用）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('空 packIds → no-op，不落任何审计', async () => {
    const auditSink = vi.fn()
    await runShadowEvaluation([], { content: 'x' }, { auditSink })
    expect(auditSink).not.toHaveBeenCalled()
  })

  it('无钩子 pack → wouldVeto=false 记录仍落审计', async () => {
    const entries: ShadowAuditEntry[] = []
    await runShadowEvaluation(['p-a'], { content: 'x' }, { auditSink: e => entries.push(e) })
    expect(entries).toHaveLength(1)
    expect(entries[0].packId).toBe('p-a')
    expect(entries[0].wouldVeto).toBe(false)
    expect(entries[0].severity).toBeUndefined()
  })

  it('钩子否决（block）→ wouldVeto=true + severity/reason 透传', async () => {
    const entries: ShadowAuditEntry[] = []
    const vetoes = [{
      pluginId: 'p-a',
      check: () => ({ veto: true, severity: 'block' as const, reason: '风险输出' })
    }]
    await runShadowEvaluation(['p-a'], { content: 'x' }, { vetoes, auditSink: e => entries.push(e) })
    expect(entries[0].wouldVeto).toBe(true)
    expect(entries[0].severity).toBe('block')
    expect(entries[0].reason).toBe('风险输出')
  })

  it('钩子否决（非 block severity）→ severity 记为 warn', async () => {
    const entries: ShadowAuditEntry[] = []
    const vetoes = [{
      pluginId: 'p-a',
      check: () => ({ veto: true, severity: 'warn' as const, reason: '低置信' })
    }]
    await runShadowEvaluation(['p-a'], {}, { vetoes, auditSink: e => entries.push(e) })
    expect(entries[0].severity).toBe('warn')
  })

  it('单个钩子抛错 → 按"未否决"记录且绝不影响主流程', async () => {
    const entries: ShadowAuditEntry[] = []
    const vetoes = [
      { pluginId: 'p-bad', check: () => { throw new Error('boom') } },
      { pluginId: 'p-good', check: () => ({ veto: false }) }
    ]
    await expect(runShadowEvaluation(['p-bad', 'p-good'], {}, { vetoes, auditSink: e => entries.push(e) })).resolves.toBeUndefined()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ packId: 'p-bad', wouldVeto: false })
    expect(entries[1]).toMatchObject({ packId: 'p-good', wouldVeto: false })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('auditSink 抛错被吞掉，不中断后续 pack 的审计', async () => {
    const entries: ShadowAuditEntry[] = []
    const auditSink = vi.fn((e: ShadowAuditEntry) => {
      if (e.packId === 'p-first') throw new Error('sink down')
      entries.push(e)
    })
    await expect(runShadowEvaluation(['p-first', 'p-second'], {}, { auditSink })).resolves.toBeUndefined()
    expect(entries.map(e => e.packId)).toEqual(['p-second'])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('缺省 auditSink → console.log 输出（不抛错）', async () => {
    await expect(runShadowEvaluation(['p-a'], {})).resolves.toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('shadow-eval'))
  })
})

describe('M16：EMA outcome 常量（规格 9.1）', () => {
  it('成功=1.0 / 失败=0.0 / 负反馈=0.2', () => {
    expect(EMA_OUTCOME_SUCCESS).toBe(1.0)
    expect(EMA_OUTCOME_FAILURE).toBe(0.0)
    expect(EMA_OUTCOME_NEGATIVE_FEEDBACK).toBe(0.2)
  })
})
