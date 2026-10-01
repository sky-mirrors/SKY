import type { ProbeSnapshot } from '@/models'

/**
 * 2026-10-01（从 DebugWindowPage.vue 抽出，为可测性）：
 * 调试窗的「会话 → 轮次 → 步骤」三级呈现，此前把分组逻辑内联在组件里，
 * 既测不到、也出过事——加分组时把时间旅行滑块的 `dimmed` 判定从「列表位置」改成
 * 「组内位置」，导致淡化范围跨组错乱，好几轮后才发现。
 *
 * 这里把它抽成纯函数：`globalIdx` 是**跨组全局序号**，滑块的 dimmed 判定必须用它
 * （用组内索引会在第二个组之后错乱）。
 */

export interface GroupedProbe extends ProbeSnapshot {
  /** 跨组全局序号——时间旅行滑块的 dimmed 判定依据 */
  globalIdx: number
}

export interface ProbeGroup {
  key: string
  sessionId?: string
  sessionLabel: string
  traceId?: string
  traceLabel: string
  probes: GroupedProbe[]
  /** 该组（一轮对话）的 token 合计与估算成本 */
  tokens: number
  cost: number
}

/** id 太长（session-1790858023577-abc1）——取尾 8 位，足以人眼区分且不撑破行宽 */
export function shortId(id: string): string {
  return id.length > 10 ? `…${id.slice(-8)}` : id
}

/**
 * 把平铺的探针列表折成「会话 → 轮次」两级分组，并按到达顺序累计 token/成本。
 * 保持插入顺序（首个出现的组在前），组内亦然，便于看时序。
 */
export function groupProbes(probes: readonly ProbeSnapshot[]): ProbeGroup[] {
  const byKey = new Map<string, ProbeGroup>()
  let globalIdx = 0
  for (const p of probes) {
    const sid = p.sessionId
    const tid = p.traceId
    const key = `${sid ?? '-'}|${tid ?? '-'}`
    let g = byKey.get(key)
    if (!g) {
      g = {
        key,
        sessionId: sid,
        sessionLabel: sid ? shortId(sid) : '(未归属会话)',
        traceId: tid,
        traceLabel: tid ? `轮次 ${shortId(tid)}` : '(未归属轮次)',
        probes: [],
        tokens: 0,
        cost: 0
      }
      byKey.set(key, g)
    }
    g.probes.push({ ...p, globalIdx: globalIdx++ })
    if (p.tokenUsage) {
      g.tokens += p.tokenUsage.totalTokens
      g.cost += p.tokenUsage.estimatedCostCny
    }
  }
  return [...byKey.values()]
}

/** 某探针在时间旅行滑块下是否应被淡化（true = 该步尚未执行到） */
export function isDimmed(probe: GroupedProbe, timeTravelIdx: number): boolean {
  return timeTravelIdx >= 0 && probe.globalIdx > timeTravelIdx
}
