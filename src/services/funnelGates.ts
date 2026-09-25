/**
 * 漏斗门值配置（G-15 修复，2026-09-25）
 *
 * G-15 现状：L0.5 门 0.8/0.9、L1 门 0.6 是 `funnel.ts` 里的启发式常量，**无任何证据**表明
 * 「0.8 置信 ≈ 80% 正确率」——LIFECYCLE-GAPS 称之为"有数学外衣的直觉"。`FunnelConfig.gates`
 * 本就支持逐次覆盖，但没有任何生产调用方传入 ⇒ 永远等于默认值，既不可调也不可观测。
 *
 * 本模块提供**可调 + 可观测**的配置通道：
 *   - `parseFunnelGates(raw)`：把持久化配置（vault `config/holo-funnel-gates` 的 JSON）解析为门值，
 *     只接受 [0,1] 的有限数，其余（类型错、越界、NaN）一律忽略并回退默认——fail-safe，绝不把
 *     一个坏配置变成"门永远不通过"。
 *   - `describeGateOverrides(raw)`：列出**被配置覆盖**的字段（探针/日志用），使门值不再不可见。
 *
 * 说明：本模块只解决"可调 + 可观测"，不宣称完成了统计校准——真正的校准要有测量数据（当前没有）。
 */

import { DEFAULT_FUNNEL_GATES, type FunnelGates } from '@/kernel/funnel'

const GATE_KEYS = ['l05Pass', 'l05Auto', 'l1Pass'] as const

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

/** 解析门值覆盖：坏值一律忽略、回退默认（fail-safe）。 */
export function parseFunnelGates(raw: unknown): FunnelGates {
  const out: FunnelGates = { ...DEFAULT_FUNNEL_GATES }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Record<string, unknown>
  for (const k of GATE_KEYS) {
    if (isUnit(obj[k])) out[k] = obj[k] as number
  }
  return out
}

/** 被配置覆盖（且合法）的字段名——用于探针/日志展示"哪些门值被调过"。 */
export function describeGateOverrides(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  return GATE_KEYS.filter(k => isUnit(obj[k]))
}

/** 默认门值（供测试与文档引用，避免在多处重复字面量）。 */
export const FUNNEL_GATE_DEFAULTS: Readonly<FunnelGates> = Object.freeze({ ...DEFAULT_FUNNEL_GATES })
