// M20：provider 降级链（规格 10.2 / M20）——远程 API 请求失败时按序回退：
// active provider → 其余 ollama 格式 providers → 隐式 Ollama 默认端点（按 baseUrl 去重）。
// per-request 透明降级：不改 activeProvider，请求结束后配置原样。
// 探测结果 TTL 缓存为模块级基础设施状态（失败 60s / 成功 300s），
// 非 #2 所指"请求态放模块全局"——请求态一律走函数参数传递。
import { ModelInfo, ProviderConfig } from '@/models'
import { probeOllama, OllamaProbeResult, OLLAMA_DEFAULT_BASE } from './ollamaProvider'

export const IMPLICIT_OLLAMA_PROVIDER_ID = 'implicit-ollama'

export const PROBE_TTL_FAIL_MS = 60_000
export const PROBE_TTL_OK_MS = 300_000

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

function cacheEntry(result: OllamaProbeResult, now: number): ProbeCacheEntry {
  const ttl = result.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS
  return { ok: result.ok, models: result.models, error: result.error, expiresAt: now + ttl }
}

/** 探测降级目标可达性（带 TTL 缓存）——ollamaProvider.probeOllama 自身不抛 */
export async function probeChainTarget(target: DegradeTarget, now: number = Date.now()): Promise<OllamaProbeResult> {
  const key = normalizeBase(target.baseUrl)
  const cached = probeCache.get(key)
  if (cached && cached.expiresAt > now) {
    return { ok: cached.ok, models: cached.models, error: cached.error }
  }
  const result = await probeOllama(target.baseUrl)
  probeCache.set(key, cacheEntry(result, now))
  return result
}

/** 实际调用结果回写缓存（成功延寿 300s / 失败短路 60s），供后续请求复用 */
export function markChainResult(target: DegradeTarget, ok: boolean, now: number = Date.now()): void {
  const key = normalizeBase(target.baseUrl)
  const prev = probeCache.get(key)
  probeCache.set(key, {
    ok,
    models: ok ? (prev?.models || []) : [],
    error: ok ? undefined : (prev?.error || 'request failed'),
    expiresAt: now + (ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS)
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
