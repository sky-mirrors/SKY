// M17：Ollama provider（规格书 10.2）——实现与 LLMPort 同构的能力面
// （chat / chatStream / listModels 经 probe），经 apiStore chatFormat==='ollama' 分支接入；
// 不可达时 probeOllama 自报 {ok:false}，不抛入主流程。
// Ollama 常驻 127.0.0.1:11434，主进程 isHostAllowed 拒绝 loopback（SSRF 防护），
// 因此本模块全部走渲染进程直连 fetch，严禁改主进程白名单放行。
import { ModelInfo } from '@/models'
import { readNDJSONStream, StreamDelta } from './sseParser'

export const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434'

export function isOllamaFormat(chatFormat?: string): boolean {
  return chatFormat === 'ollama'
}

export interface OllamaProbeResult {
  ok: boolean
  models: ModelInfo[]
  error?: string
}

export interface OllamaUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/** GET /api/tags——探测可达性 + 模型清单；失败/超时返回 {ok:false}，绝不抛出 */
export async function probeOllama(baseUrl: string, timeoutMs: number = 3000): Promise<OllamaProbeResult> {
  try {
    const resp = await fetch(joinUrl(baseUrl, '/api/tags'), { signal: AbortSignal.timeout(timeoutMs) })
    if (!resp.ok) {
      return { ok: false, models: [], error: `HTTP ${resp.status}` }
    }
    const data = await resp.json() as { models?: Array<{ name?: string; model?: string }> }
    const models: ModelInfo[] = (data.models || [])
      .map(m => ({ id: m.name || m.model || '', name: m.name || m.model || '' }))
      .filter(m => m.id !== '')
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** POST /api/chat（stream:false）——单 JSON 响应；非 2xx 抛错（含状态码供降级分类） */
export async function ollamaChat(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
  signal?: AbortSignal,
  temperature?: number
): Promise<{ content: string; usage: OllamaUsage }> {
  const body: Record<string, unknown> = { model, messages, stream: false }
  // G-2：temperature 可选透传——未传时请求体与现状逐字节等价（冷启动等价现状）
  const options: Record<string, number> = {}
  if (maxTokens) options.num_predict = maxTokens
  if (temperature !== undefined) options.temperature = temperature
  if (Object.keys(options).length > 0) body.options = options
  const resp = await fetch(joinUrl(baseUrl, '/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    throw new Error(`Ollama API error ${resp.status}: ${errBody.slice(0, 200)}`)
  }
  const data = await resp.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number }
  const promptTokens = data.prompt_eval_count ?? 0
  const completionTokens = data.eval_count ?? 0
  return {
    content: data.message?.content || '',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheHitTokens: 0,
      cacheMissTokens: promptTokens
    }
  }
}

/** POST /api/chat（stream:true）——NDJSON 流式，复用 sseParser 适配层逐行解析 */
export async function ollamaChatStream(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onDelta: (delta: StreamDelta) => void,
  maxTokens?: number,
  signal?: AbortSignal,
  temperature?: number
): Promise<void> {
  const body: Record<string, unknown> = { model, messages, stream: true }
  // G-2：同 ollamaChat——temperature 可选透传，未传时请求体与现状等价
  const options: Record<string, number> = {}
  if (maxTokens) options.num_predict = maxTokens
  if (temperature !== undefined) options.temperature = temperature
  if (Object.keys(options).length > 0) body.options = options
  const resp = await fetch(joinUrl(baseUrl, '/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '')
    throw new Error(`Ollama API error ${resp.status}: ${errBody.slice(0, 200)}`)
  }
  if (!resp.body) {
    throw new Error('Ollama stream response body is null — streaming not supported')
  }
  await readNDJSONStream(resp.body, onDelta, signal)
}
