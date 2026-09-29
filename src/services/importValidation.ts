/**
 * D-1：数据导入的 schema 校验。
 *
 * 导入文件是不可信输入，而原 applyImport 把 api-config / vectors / knowledge 逐字段
 * 原样写进 vault：伪造的 provider baseUrl 可直接承载后续全部 LLM 流量（甚至对话内容外发），
 * 伪造的 chunk/向量可注入 RAG 上下文。此模块只做**结构性**校验（类型 / 协议 / 形状），
 * 不合法即由调用方整体拒绝导入（fail-closed），不做静默放行。
 *
 * D-1 强化（2026-09-27 亲验坐实后补）：
 *   ① baseUrl 除协议外还判 host 是否指向内网/保留地址——复用 `./privateHost`（与运行时
 *      isHostAllowed 同源）。原实现只验 `http(s)://` 前缀，放行内网 baseUrl，直到运行时
 *      `llm:chatCompletion` 才拦，属「校验点与使用点不一致」。
 *   ② 向量校验加**维度检查**（VECTOR_DIM）并要求 vector 必须存在——原实现只看结构，
 *      错维/缺向量会静默入库、检索期表现为相似度失真而非明确报错。
 *   ③ **不采信**导入的 `vectorIsPseudo`：该字段可被伪造为 false 让伪向量冒充真实向量
 *      永久使用；改为剥离该字段，交本地 needsReembedding 保守判为「需重嵌入」。
 *   ④ 失败原因随 rejected 一并返回（原只回键名）。
 */

import { isPrivateHostname } from './privateHost'
import { VECTOR_DIM } from './embedder'

export interface ValidationResult {
  ok: boolean
  reason?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isHttpUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim())
}

/** 取 URL 的 hostname（含 IPv6 括号形态）；无法解析返回 null */
function hostOf(raw: string): string | null {
  try {
    const host = new URL(raw.trim()).hostname
    return host || null
  } catch {
    return null
  }
}

/**
 * api-config：providers 必须是数组；每项须有字符串 id；
 * baseUrl 若存在须为 http(s) 且 host 不指向内网/保留地址。
 */
export function validateImportedApiConfig(section: unknown): ValidationResult {
  if (!isPlainObject(section)) return { ok: false, reason: '不是对象' }
  const providers = section.providers
  if (providers !== undefined) {
    if (!Array.isArray(providers)) return { ok: false, reason: 'providers 不是数组' }
    for (const p of providers) {
      if (!isPlainObject(p)) return { ok: false, reason: 'provider 条目不是对象' }
      if (typeof p.id !== 'string' || p.id.length === 0) return { ok: false, reason: 'provider 缺少字符串 id' }
      if (p.baseUrl !== undefined) {
        if (!isHttpUrl(p.baseUrl)) {
          return { ok: false, reason: `provider baseUrl 非 http(s) 协议: ${String(p.baseUrl).slice(0, 60)}` }
        }
        const host = hostOf(p.baseUrl as string)
        if (!host) {
          return { ok: false, reason: `provider baseUrl 无法解析出主机名: ${String(p.baseUrl).slice(0, 60)}` }
        }
        if (isPrivateHostname(host)) {
          return { ok: false, reason: `provider baseUrl 指向内网/保留地址，已拒绝: ${host}` }
        }
      }
    }
  }
  return { ok: true }
}

/** knowledge：entries 须为对象数组且每项含字符串 id；groups 若存在须为数组 */
export function validateImportedKnowledge(section: unknown): ValidationResult {
  if (!isPlainObject(section)) return { ok: false, reason: '不是对象' }
  const entries = section.entries
  if (entries !== undefined) {
    if (!Array.isArray(entries)) return { ok: false, reason: 'entries 不是数组' }
    for (const e of entries) {
      if (!isPlainObject(e)) return { ok: false, reason: '知识条目不是对象' }
      if (typeof e.id !== 'string' || e.id.length === 0) return { ok: false, reason: '知识条目缺少字符串 id' }
    }
  }
  const groups = section.groups
  if (groups !== undefined && !Array.isArray(groups)) return { ok: false, reason: 'groups 不是数组' }
  return { ok: true }
}

export interface VectorsValidationResult {
  valid: Record<string, string>
  /** 结构非法（或维度不符）的键 + 原因（D-1：原只回键名） */
  rejected: { key: string; reason: string }[]
}

function isValidChunkArray(parsed: unknown): { ok: boolean; reason?: string } {
  if (!Array.isArray(parsed)) return { ok: false, reason: '不是数组' }
  for (const c of parsed) {
    if (!isPlainObject(c)) return { ok: false, reason: '元素不是对象' }
    if (typeof c.text !== 'string') return { ok: false, reason: '元素缺字符串 text' }
    if (!Array.isArray(c.vector) || !c.vector.every(n => typeof n === 'number' && Number.isFinite(n))) {
      return { ok: false, reason: 'vector 缺失或非数值数组' }
    }
    if (c.vector.length !== VECTOR_DIM) {
      return { ok: false, reason: `向量维度不符：期望 ${VECTOR_DIM}，实得 ${c.vector.length}` }
    }
    if (c.chunkIndex !== undefined && typeof c.chunkIndex !== 'number') return { ok: false, reason: 'chunkIndex 非数值' }
    if (c.tokens !== undefined && typeof c.tokens !== 'number') return { ok: false, reason: 'tokens 非数值' }
  }
  return { ok: true }
}

/**
 * vectors：只接受 `holo-kb-chunks-` 前缀键，且值须能解析为 ChunkRecord 数组
 * （每项含字符串 text、数值数组 vector，且维度须为 VECTOR_DIM）。
 * 非法键逐条落入 rejected（含原因），由调用方决定拒绝整段还是丢弃。
 * 通过者剥离 `vectorIsPseudo`——不采信导入值，交本地 needsReembedding 重判。
 */
export function validateImportedVectors(section: unknown): VectorsValidationResult {
  const valid: Record<string, string> = {}
  const rejected: { key: string; reason: string }[] = []
  if (!isPlainObject(section)) {
    return { valid, rejected: Object.keys(section ?? {}).map(key => ({ key, reason: 'section 不是对象' })) }
  }

  for (const [key, value] of Object.entries(section)) {
    if (!key.startsWith('holo-kb-chunks-')) { rejected.push({ key, reason: '键名前缀不是 holo-kb-chunks-' }); continue }
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      rejected.push({ key, reason: 'JSON 解析失败' })
      continue
    }
    const check = isValidChunkArray(parsed)
    if (!check.ok) { rejected.push({ key, reason: check.reason || '结构非法' }); continue }
    // D-1：不采信导入的 vectorIsPseudo（可伪造的 false 会让伪向量被当真实向量永久使用）；
    // 剥离后 needsReembedding 因字段缺失而保守判为「需重嵌入」，由本地 embedder 重新判定。
    const sanitized = (parsed as Record<string, unknown>[]).map(c =>
      Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'vectorIsPseudo'))
    )
    valid[key] = JSON.stringify(sanitized)
  }
  return { valid, rejected }
}
