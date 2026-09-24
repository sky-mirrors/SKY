/**
 * D-1：数据导入的 schema 校验。
 *
 * 导入文件是不可信输入，而原 applyImport 把 api-config / vectors / knowledge 逐字段
 * 原样写进 vault：伪造的 provider baseUrl 可直接承载后续全部 LLM 流量（甚至对话内容外发），
 * 伪造的 chunk/向量可注入 RAG 上下文。此模块只做**结构性**校验（类型 / 协议 / 形状），
 * 不合法即由调用方整体拒绝导入（fail-closed），不做静默放行。
 */

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

/** api-config：providers 必须是数组；每项须有字符串 id；baseUrl 若存在须为 http(s) */
export function validateImportedApiConfig(section: unknown): ValidationResult {
  if (!isPlainObject(section)) return { ok: false, reason: '不是对象' }
  const providers = section.providers
  if (providers !== undefined) {
    if (!Array.isArray(providers)) return { ok: false, reason: 'providers 不是数组' }
    for (const p of providers) {
      if (!isPlainObject(p)) return { ok: false, reason: 'provider 条目不是对象' }
      if (typeof p.id !== 'string' || p.id.length === 0) return { ok: false, reason: 'provider 缺少字符串 id' }
      if (p.baseUrl !== undefined && !isHttpUrl(p.baseUrl)) {
        return { ok: false, reason: `provider baseUrl 非 http(s) 协议: ${String(p.baseUrl).slice(0, 60)}` }
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
  rejected: string[]
}

function isValidChunkArray(parsed: unknown): boolean {
  if (!Array.isArray(parsed)) return false
  return parsed.every(c => {
    if (!isPlainObject(c)) return false
    if (typeof c.text !== 'string') return false
    if (c.vector !== undefined) {
      if (!Array.isArray(c.vector) || !c.vector.every(n => typeof n === 'number' && Number.isFinite(n))) return false
    }
    if (c.chunkIndex !== undefined && typeof c.chunkIndex !== 'number') return false
    if (c.tokens !== undefined && typeof c.tokens !== 'number') return false
    return true
  })
}

/**
 * vectors：只接受 `holo-kb-chunks-` 前缀键，且值须能解析为 ChunkRecord 数组
 * （每项含字符串 text；vector/chunkIndex/tokens 若存在类型须正确）。
 * 非法键逐条落入 rejected，由调用方决定拒绝整段还是丢弃。
 */
export function validateImportedVectors(section: unknown): VectorsValidationResult {
  const valid: Record<string, string> = {}
  const rejected: string[] = []
  if (!isPlainObject(section)) return { valid, rejected: Object.keys(section ?? {}) }

  for (const [key, value] of Object.entries(section)) {
    if (!key.startsWith('holo-kb-chunks-')) { rejected.push(key); continue }
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      rejected.push(key)
      continue
    }
    if (!isValidChunkArray(parsed)) { rejected.push(key); continue }
    valid[key] = raw
  }
  return { valid, rejected }
}
