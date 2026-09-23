/**
 * api-config 的多源读取（vault 优先、文件回退）——主进程侧统一入口。
 *
 * 事故背景（2026-09-23，见 .rivet/HANDOFF.md 追加二十三/二十四）：
 *   主进程三处（llm:chatCompletion / llm:listModels / llm:stream）只读
 *   `<userData>\store\api-config.json`；而渲染进程 apiStore.saveToStorage 实际写的是
 *   vault（`secure:holo-api-config` 立即落盘 + `api:holo-api-config` writeThrough 备份）。
 *   该文件的唯一写入者是 `store:write('api-config', …)`，渲染层从未调用 ⇒ 文件长期是
 *   `{}`（甚至含 BOM）⇒ 主进程查不到 provider ⇒ 云端调用与判卷全部报
 *   `Provider '…' not found` ⇒ 考试 0%。
 *
 * 本模块是**纯候选源解析**（零 electron 依赖，便于单测）：调用方按优先级给出候选源，
 * 取第一个「可解析且有效」的配置。真实数据源（vaultRead / 文件）由 callers 注入。
 */

export interface ApiConfigProvider {
  id: string
  name?: string
  baseUrl: string
  authType?: string
  apiKey?: string
  modelsEndpoint?: string
  chatFormat?: string
  models?: Array<{ id: string; name: string }>
  isReachable?: boolean
  lastCheckedAt?: number
}

export interface StoredApiConfig {
  baseUrl?: string
  providers?: ApiConfigProvider[]
}

export interface ApiConfigSource {
  /** 用于告警定位（如 `vault:secure:holo-api-config`、`file:api-config.json`） */
  label: string
  /** 返回原始字符串（可以是 JSON 文本、带 BOM 的 JSON、空串或 null） */
  read: () => string | null | undefined
}

/** 剥 BOM：2026-09-23 曾因 BOM(3)+`{}`(2) 使 JSON.parse 抛错、配置"看起来是空的" */
export function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/**
 * 有效性门槛：空对象 `{}` 不算有效配置——否则陈旧/损坏的源会短路后续回退源，
 * 正是本次事故的形态（`api-config.json` = 2 字节 `{}`）。
 */
export function isUsableApiConfig(value: unknown): value is StoredApiConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as StoredApiConfig
  return Array.isArray(v.providers) || typeof v.baseUrl === 'string'
}

/**
 * 按优先级遍历候选源，返回第一个可解析且有效的配置。
 * 某个源读失败/解析失败只告警并继续——不允许单个源把整条读取链带崩。
 */
export function pickApiConfig(sources: ApiConfigSource[]): StoredApiConfig | null {
  for (const source of sources) {
    let raw: string | null | undefined
    try {
      raw = source.read()
    } catch (err) {
      // 典型：vault 库未打开时 getDb 抛 'Database not opened'
      console.warn(`[api-config] ${source.label} 读取失败：`, String(err).slice(0, 120))
      continue
    }
    if (!raw) continue
    const cleaned = stripBom(raw)
    try {
      const parsed: unknown = JSON.parse(cleaned)
      if (isUsableApiConfig(parsed)) return parsed
      console.warn(`[api-config] ${source.label} 不含 providers/baseUrl，跳过`)
    } catch (err) {
      console.warn(
        `[api-config] ${source.label} 解析失败（前 80 字：${cleaned.slice(0, 80)}）：`,
        String(err).slice(0, 120)
      )
    }
  }
  return null
}
