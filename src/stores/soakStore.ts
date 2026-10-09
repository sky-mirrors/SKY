import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

/**
 * 浸泡验证数据管道（A6 批，R15 旧六层退役的证据采集层）：
 * - funnel:shadow-diff 完整结构化报告（含 legacyTrail/traceId/match 判定）与 funnel:routed 记录
 *   此前仅存内存 eventLog（cap 50、文本化，重启即失）——本 store 补 vault 持久化
 * - 未启用 shadow（vault config:holo-funnel-shadow != '1'）时零订阅零开销
 * - 纯 store 层（node 环境可单测）；记录 interface 本地定义，
 *   不 import hotplugStore/dialogStore（避免拉入 UI 依赖链）
 * - 持久化：内存 unshift → cap 500 → writeThrough 整数组（人工浸泡频率下读-改-写可接受）
 */

export interface SoakShadowRecord {
  ts: number
  /** 上游已截断 80 字（dialogStore.runFunnelShadow） */
  input: string
  funnelKind: string
  funnelSource?: string
  funnelIntent?: string
  legacyEndpoint: string
  funnelEndpoint: string
  /** null = 暂停点类终点，无法自动判定，待人工核对 */
  match: boolean | null
  durationMs: number
  /** C-11：请求级 traceId（与 probe/cost 记录按请求归因） */
  traceId?: string
  legacyTrail: string[]
}

/** 与 hotplugStore.FunnelRoutedRecord 字段同构（本地定义避免跨 store import） */
export interface SoakRoutedRecord {
  handled: boolean
  kind: string
  source?: string
  intent?: string
  autoExecutable?: boolean
  ts: number
  traceId?: string
}

export interface SoakSummary {
  shadowTotal: number
  matchCount: number
  mismatchCount: number
  manualReviewCount: number
  /** 一致率 = match / (match + mismatch)，不含 match=null 待核对样本；分母为 0 时为 0 */
  matchRate: number
  routedTotal: number
  handledCount: number
  firstTs: number | null
  lastTs: number | null
}

export interface SoakReport {
  generatedAt: number
  summary: SoakSummary
  byFunnelSource: Record<string, number>
  byFunnelKind: Record<string, number>
  avgShadowDurationMs: number
  maxShadowDurationMs: number
  mismatchSamples: SoakShadowRecord[]
  manualReviewSamples: SoakShadowRecord[]
}

const SOAK_NS = 'soak'
const SHADOW_KEY = 'shadow-reports'
const ROUTED_KEY = 'routed-records'
const MAX_RECORDS = 500
const MISMATCH_SAMPLE_LIMIT = 10

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export const useSoakStore = defineStore('soak', () => {
  const shadowRecords = ref<SoakShadowRecord[]>([])
  const routedRecords = ref<SoakRoutedRecord[]>([])
  const soakEnabled = ref(false)
  const lastExportPath = ref('')

  let disposers: Array<() => void> = []
  let initialized = false

  const soakSummary = computed<SoakSummary>(() => {
    const shadows = shadowRecords.value
    const matchCount = shadows.filter(r => r.match === true).length
    const mismatchCount = shadows.filter(r => r.match === false).length
    const manualReviewCount = shadows.filter(r => r.match === null).length
    const judged = matchCount + mismatchCount
    const routed = routedRecords.value
    const tsList = shadows.map(r => r.ts)
    return {
      shadowTotal: shadows.length,
      matchCount,
      mismatchCount,
      manualReviewCount,
      matchRate: judged > 0 ? matchCount / judged : 0,
      routedTotal: routed.length,
      handledCount: routed.filter(r => r.handled).length,
      firstTs: tsList.length > 0 ? Math.min(...tsList) : null,
      lastTs: tsList.length > 0 ? Math.max(...tsList) : null
    }
  })

  function persistShadow(): void {
    vault.writeThrough(SOAK_NS, SHADOW_KEY, JSON.stringify(shadowRecords.value))
  }

  function persistRouted(): void {
    vault.writeThrough(SOAK_NS, ROUTED_KEY, JSON.stringify(routedRecords.value))
  }

  /**
   * 幂等初始化：读 shadow 开关 → 未启用直接返回（零订阅）；
   * 启用则 load 既有记录（坏 JSON 容错置空）并订阅两事件。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    try {
      soakEnabled.value = (await vault.read('config', 'holo-funnel-shadow')) === '1'
    } catch {
      soakEnabled.value = false
    }
    if (!soakEnabled.value) return

    shadowRecords.value = parseArray<SoakShadowRecord>(await vault.read(SOAK_NS, SHADOW_KEY))
    routedRecords.value = parseArray<SoakRoutedRecord>(await vault.read(SOAK_NS, ROUTED_KEY))

    disposers.push(
      globalBus.on('funnel:shadow-diff', p => {
        const d = p as SoakShadowRecord & { funnel?: { kind: string; source?: string; intent?: string } }
        // 上游契约（dialogStore.runFunnelShadow）：{input, funnel{kind,source,intent}, legacyEndpoint, funnelEndpoint, match, durationMs, traceId, legacyTrail}
        const record: SoakShadowRecord = {
          ts: Date.now(),
          input: String(d.input ?? ''),
          funnelKind: String(d.funnel?.kind ?? d.funnelKind ?? ''),
          funnelSource: d.funnel?.source ?? d.funnelSource,
          funnelIntent: d.funnel?.intent ?? d.funnelIntent,
          legacyEndpoint: String(d.legacyEndpoint ?? ''),
          funnelEndpoint: String(d.funnelEndpoint ?? ''),
          match: typeof d.match === 'boolean' ? d.match : null,
          durationMs: Number(d.durationMs) || 0,
          traceId: d.traceId,
          legacyTrail: Array.isArray(d.legacyTrail) ? d.legacyTrail.slice(0, 30).map(String) : []
        }
        shadowRecords.value.unshift(record)
        if (shadowRecords.value.length > MAX_RECORDS) {
          shadowRecords.value.length = MAX_RECORDS
        }
        persistShadow()
      }),
      globalBus.on('funnel:routed', p => {
        const d = p as SoakRoutedRecord
        routedRecords.value.unshift({
          handled: Boolean(d.handled),
          kind: String(d.kind ?? ''),
          source: d.source,
          intent: d.intent,
          autoExecutable: d.autoExecutable,
          ts: Number(d.ts) || Date.now(),
          traceId: d.traceId
        })
        if (routedRecords.value.length > MAX_RECORDS) {
          routedRecords.value.length = MAX_RECORDS
        }
        persistRouted()
      })
    )
  }

  function buildReport(): SoakReport {
    const shadows = shadowRecords.value
    const summary = soakSummary.value
    const byFunnelSource: Record<string, number> = {}
    const byFunnelKind: Record<string, number> = {}
    for (const r of routedRecords.value) {
      const key = r.source || '(none)'
      byFunnelSource[key] = (byFunnelSource[key] ?? 0) + 1
    }
    for (const r of shadows) {
      const key = r.funnelKind || '(none)'
      byFunnelKind[key] = (byFunnelKind[key] ?? 0) + 1
    }
    const durations = shadows.map(r => r.durationMs)
    return {
      generatedAt: Date.now(),
      summary,
      byFunnelSource,
      byFunnelKind,
      avgShadowDurationMs: durations.length > 0 ? durations.reduce((s, v) => s + v, 0) / durations.length : 0,
      maxShadowDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      mismatchSamples: shadows.filter(r => r.match === false).slice(0, MISMATCH_SAMPLE_LIMIT),
      manualReviewSamples: shadows.filter(r => r.match === null).slice(0, MISMATCH_SAMPLE_LIMIT)
    }
  }

  /** 导出 JSON 报告（照 benchmarkRunner.exportReport 的 fileWrite 模式）；返回文件路径或 null */
  async function exportSoakReport(): Promise<string | null> {
    const json = JSON.stringify(buildReport(), null, 2)
    try {
      const api = (window as unknown as { electronAPI?: { resolvePath?: (p: string) => Promise<string>; fileWrite?: (args: { filePath: string; content: string }) => Promise<{ success: boolean; error?: string }> } }).electronAPI
      const home = (await api?.resolvePath?.('%USERPROFILE%')) || 'C:\\Users\\Default'
      const filePath = `${home}\\Desktop\\SKY\\soak-report.json`
      const result = await api?.fileWrite?.({ filePath, content: json })
      if (result?.success) {
        lastExportPath.value = filePath
        return filePath
      }
    } catch {
      // best-effort：导出失败返回 null，UI 提示未成功
    }
    return null
  }

  /** 退订 + 复位（测试用；生产不调） */
  function dispose(): void {
    for (const d of disposers) {
      try { d() } catch { /* best-effort */ }
    }
    disposers = []
    initialized = false
    shadowRecords.value = []
    routedRecords.value = []
    soakEnabled.value = false
    lastExportPath.value = ''
  }

  return {
    shadowRecords,
    routedRecords,
    soakEnabled,
    soakSummary,
    lastExportPath,
    init,
    buildReport,
    exportSoakReport,
    dispose
  }
})
