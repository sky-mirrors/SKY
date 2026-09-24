// M20：provider 降级链（规格 10.2 / M20）——远程 API 请求失败时按序回退：
// active provider → 其余 ollama 格式 providers → 隐式 Ollama 默认端点（按 baseUrl 去重）。
// per-request 透明降级：不改 activeProvider，请求结束后配置原样。
// 探测结果 TTL 缓存为模块级基础设施状态（成功 300s；失败按连续失败次数
// 5s→10s→20s→40s→60s 递增退避），非 #2 所指"请求态放模块全局"——请求态一律走函数参数传递。
import { ModelInfo, ProviderConfig } from '@/models'
import { probeOllama, OllamaProbeResult, OLLAMA_DEFAULT_BASE } from './ollamaProvider'

export const IMPLICIT_OLLAMA_PROVIDER_ID = 'implicit-ollama'

/** 持续失败时的负缓存上限：连续失败退避到该档后不再增长 */
export const PROBE_TTL_FAIL_MS = 60_000
/** 首次失败的负缓存时长——一次闪断只封 5s，不把本地端点按 60s 处置 */
export const PROBE_TTL_FAIL_BASE_MS = 5_000
export const PROBE_TTL_OK_MS = 300_000

/**
 * 失败退避档位：5s → 10s → 20s → 40s → 60s(上限)。
 * 为什么分级：探测自身 3s 超时、端点拒绝连接时多为毫秒级返回，首档短能让
 * 「抖一下的 Ollama」在下一个请求就重新参与降级链；连续失败则迅速升到上限，
 * 不对真正宕掉的端点按请求反复付探测成本。
 */
export function failTtlFor(streak: number): number {
  const n = Math.max(1, Math.floor(streak))
  return Math.min(PROBE_TTL_FAIL_BASE_MS * 2 ** (n - 1), PROBE_TTL_FAIL_MS)
}

export interface DegradeTarget {
  providerId: string
  name: string
  baseUrl: string
  chatFormat: ProviderConfig['chatFormat']
  implicit: boolean
  models: ModelInfo[]
}

export interface DegradeEventPayload {
  fromProviderId: string
  fromName: string
  toProviderId: string
  toName: string
  reason: string
  timestamp: number
}

/** 最小总线结构——HoloEventBus 天然满足；纯服务不直接 import 单例，便于测试注入 */
export interface DegradeBus {
  emit(channel: string, payload?: unknown): void
  request(channel: string, payload?: unknown): unknown
}

interface ProbeCacheEntry {
  ok: boolean
  models: ModelInfo[]
  error?: string
  expiresAt: number
  /** 连续失败次数（成功即清零）——决定失败 TTL 档位 */
  failStreak: number
}

const probeCache = new Map<string, ProbeCacheEntry>()

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').toLowerCase()
}

function toTarget(p: ProviderConfig): DegradeTarget {
  return {
    providerId: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    chatFormat: p.chatFormat,
    implicit: false,
    models: p.models || []
  }
}

/**
 * 构建降级链：active provider 打头（调用方先按原路径直试，失败才回退），
 * 尾部追加全部 ollama 格式 provider 与隐式默认端点，baseUrl 归一化去重。
 */
export function buildProviderChain(activeProviderId: string | undefined, providers: ProviderConfig[]): DegradeTarget[] {
  const chain: DegradeTarget[] = []
  const seen = new Set<string>()
  const active = providers.find(p => p.id === activeProviderId)
  if (active) {
    chain.push(toTarget(active))
    seen.add(normalizeBase(active.baseUrl))
  }
  for (const p of providers) {
    if (p.id === activeProviderId) continue
    if (p.chatFormat !== 'ollama') continue
    const key = normalizeBase(p.baseUrl)
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(toTarget(p))
  }
  if (!seen.has(normalizeBase(OLLAMA_DEFAULT_BASE))) {
    chain.push({
      providerId: IMPLICIT_OLLAMA_PROVIDER_ID,
      name: 'Ollama(隐式)',
      baseUrl: OLLAMA_DEFAULT_BASE,
      chatFormat: 'ollama',
      implicit: true,
      models: []
    })
  }
  return chain
}

/**
 * 错误可降级分类：网络失败 / 5xx / 超时 / 429 可回退本地；
 * 401/403/404（认证/不存在）与调用方主动 AbortError 不降级——换本地模型救不了配置错误。
 */
export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof DOMException) {
    if (err.name === 'AbortError') return false
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  const statusMatch = msg.match(/(?:API error|Ollama API error)\s+(\d{3})/)
  if (statusMatch) {
    const status = Number(statusMatch[1])
    if (status === 401 || status === 403 || status === 404) return false
    if (status >= 500 && status < 600) return true
    if (status === 429) return true
    return false
  }
  if (/timeout|timed out|TimeoutError/i.test(msg)) return true
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return true
  return false
}

function cacheEntry(result: OllamaProbeResult, now: number, prevStreak: number): ProbeCacheEntry {
  if (result.ok) {
    return { ok: true, models: result.models, expiresAt: now + PROBE_TTL_OK_MS, failStreak: 0 }
  }
  const failStreak = prevStreak + 1
  return {
    ok: false,
    models: result.models,
    error: result.error,
    expiresAt: now + failTtlFor(failStreak),
    failStreak
  }
}

/** 探测降级目标可达性（带 TTL 缓存）——ollamaProvider.probeOllama 自身不抛 */
export async function probeChainTarget(target: DegradeTarget, now: number = Date.now()): Promise<OllamaProbeResult> {
  const key = normalizeBase(target.baseUrl)
  const cached = probeCache.get(key)
  if (cached && cached.expiresAt > now) {
    return { ok: cached.ok, models: cached.models, error: cached.error }
  }
  const result = await probeOllama(target.baseUrl)
  // 已过期条目的连续失败计数继续累计——退避计的是「连续失败」，不是「本次探测」
  probeCache.set(key, cacheEntry(result, now, cached?.failStreak ?? 0))
  return result
}

/** 实际调用结果回写缓存（成功延寿 300s 并清零失败计数 / 失败按连续次数递增退避），供后续请求复用 */
export function markChainResult(target: DegradeTarget, ok: boolean, now: number = Date.now()): void {
  const key = normalizeBase(target.baseUrl)
  const prev = probeCache.get(key)
  if (ok) {
    probeCache.set(key, {
      ok: true,
      models: prev?.models || [],
      expiresAt: now + PROBE_TTL_OK_MS,
      failStreak: 0
    })
    return
  }
  const failStreak = (prev?.failStreak ?? 0) + 1
  probeCache.set(key, {
    ok: false,
    models: [],
    error: prev?.error || 'request failed',
    expiresAt: now + failTtlFor(failStreak),
    failStreak
  })
}

/** 测试辅助：清空探测缓存 */
export function clearProbeCache(): void {
  probeCache.clear()
}

/** 为降级目标挑选模型：目标自身模型清单优先，探测结果兜底 */
export function pickOllamaModel(target: DegradeTarget, probe: OllamaProbeResult): string {
  return target.models[0]?.id || probe.models[0]?.id || ''
}

/**
 * 降级事件广播：
 * - bus.emit('llm-degraded') 供域层/调试面板订阅（emit 只达 on() 监听器）
 * - bus.request('notification:add') 触达 registerHandler（notificationStore，
 *   内部按 settings.apiDegrade 开关过滤，此处无需重复判断）
 */
export function emitDegraded(
  bus: DegradeBus,
  from: { providerId: string; name: string },
  to: DegradeTarget,
  reason: string
): void {
  const payload: DegradeEventPayload = {
    fromProviderId: from.providerId,
    fromName: from.name,
    toProviderId: to.providerId,
    toName: to.name,
    reason,
    timestamp: Date.now()
  }
  bus.emit('llm-degraded', payload)
  bus.request('notification:add', {
    type: 'api_degrade',
    title: 'LLM 通道降级',
    message: `${from.name} 不可用（${reason}），本次请求已回退到 ${to.name}`
  })
}
