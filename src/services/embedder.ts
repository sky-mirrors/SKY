import { debugLog } from '@/services/debugLog'

export const VECTOR_DIM = 384

type Embedder = { embed: (text: string) => Promise<number[]> }

let embedder: Embedder | null = null
let embedderPromise: Promise<Embedder | null> | null = null
let embedderReady = false

/**
 * 模型加载上限——transformers.js 首载需从网络拉模型且无内置超时，网络阻塞时该 promise
 * 永不 settle；它被缓存（embedderPromise）后，所有走嵌入的 RAG 路由会永久挂起、isProcessing
 * 卡 true（验收考试 Q1/Q2 卡死、普通对话发 Q14 亦卡死的同型根因）。超时即降级伪向量，绝不阻塞路由。
 *
 * 2026-10-01：**15s 太短，实测必然误杀**。本机实测拉 `model_quantized.onnx`（21.9MB）耗时
 * **26.5s** ⇒ 15s 时首次加载必然超时 → 进 5 分钟冷却 → 期间 `generateVector` 全程降级**伪向量**
 * ⇒ L2 的向量通路失效、只剩字面关键词通路，自然语言输入（哪怕拿 manifest 的 retrievalSummary
 * 原文）都匹配不上，L2 长期不命中、落 L4 探索模式。放宽到 90s：覆盖首次下载（26.5s）且留足波动余量，
 * 同时仍是**有界**超时，不破坏「网络阻塞时不永久挂起」这条原始不变量。
 */
const LOAD_TIMEOUT_MS = 90000
/** 加载失败/超时后的冷却窗——避免每次路由都重试一次多秒级挂起 */
const LOAD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
let loadCooldownUntil = 0

/** 给 promise 加超时；到点 reject（不取消底层加载，仅让等待有界） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`embedder load timeout after ${ms}ms`)), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}

export async function getEmbedder(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<Embedder | null> {
  if (embedder) return embedder
  // 冷却窗内直接降级，不重试——防重复挂起
  if (Date.now() < loadCooldownUntil) return null
  if (embedderPromise) return embedderPromise
  embedderPromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers')
      // 2026-10-01：**必须关掉本地模型探测**。transformers.js 默认 `allowLocalModels=true`，
      // 会先按 `env.localModelPath`（默认 '/models/'）取模型；而本项目 renderer 下该路径**没有模型**：
      //   - dev（vite dev server）：未命中路径走 SPA fallback → 返回 index.html（`text/html`）
      //   - 生产（file://）：被 CSP `connect-src` 拒
      // 两种情况下 transformers 都拿到非 JSON，`JSON.parse` 抛
      //   `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
      // → 整个 embedder 加载失败（实测 39ms 立即失败，非超时）→ 进 5 分钟冷却 → 之后
      // `generateVectorWithMeta` 全程降级**伪向量** → L2 的向量通路形同失效、只剩字面关键词通路，
      // 自然语言输入（哪怕拿 manifest 的 retrievalSummary 原文）都匹配不上 ⇒ L2 长期不命中、落 L4。
      // 关掉本地探测后直接走远程（实测 huggingface.co 可达、返回真 JSON）。
      env.allowLocalModels = false
      const extractor = await withTimeout(
        pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' } as Record<string, unknown>),
        timeoutMs
      )
      embedder = {
        async embed(text: string): Promise<number[]> {
          const output = await extractor(text, { pooling: 'mean', normalize: true })
          return Array.from(output.data) as number[]
        }
      }
      embedderReady = true
      return embedder
    } catch (err) {
      // 2026-10-01：**不只用 debugLog**。debugLog 受 `import.meta.env.DEV` 门控，
      // 生产构建下完全静默；而这条错误正是「L2 长期不命中」的总根因线索，
      // 静默过一次就查了整整几轮。嵌入降级是可观测性事件，用 console.error 无条件暴露。
      console.error('[Embedder] transformers.js 加载失败/超时，本次起降级伪向量（语义检索质量下降，待重嵌入）:', err)
      debugLog('[Embedder] transformers.js load failed/timeout:', err)
      embedderPromise = null
      loadCooldownUntil = Date.now() + LOAD_FAILURE_COOLDOWN_MS
      return null
    }
  })()
  return embedderPromise
}

export function isEmbedderReady(): boolean {
  return embedderReady
}

/**
 * 2026-10-01（用户反馈「小模型应该随应用启动提前冷启动」）：
 * 后台预热——启动时调一次，把「下载模型 + 初始化 onnx」从**首次提问**挪到**应用启动**。
 *
 * 动机：此前只在首次走 RAG 路由时才加载，而首次要下 21.9MB（本机实测 26.5s）。
 * 冷启动把这段等待藏进用户还没提问的时间窗里，首次对话不再承担它。
 * 有意不 await、不抛（启动钩子按既有惯例 `.catch` 吞掉），绝不影响启动。
 */
export function prewarmEmbedder(): void {
  void getEmbedder().catch(() => { /* 预热失败不影响启动；失败原因由 getEmbedder 内部报出 */ })
}

function simpleHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  }
  return hash
}

function simpleTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
}

export function generatePseudoVector(text: string, dim: number = VECTOR_DIM): number[] {
  const meaningfulSlots = Math.min(dim, 64)
  const tokens = simpleTokenize(text)
  const vec = new Float64Array(dim)
  for (let i = 0; i < tokens.length; i++) {
    const hash = simpleHash(tokens[i])
    for (let j = 0; j < meaningfulSlots; j++) {
      vec[j] += Math.sin(hash * (j + 1) * 0.01) * (1.0 / (i + 1))
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return Array.from(vec).map(v => v / norm)
}

export interface VectorWithMeta {
  vector: number[]
  /** true = embedder 不可用时的伪向量（哈希散射），语义检索质量降级，待重嵌入 */
  isPseudo: boolean
}

export async function generateVectorWithMeta(text: string): Promise<VectorWithMeta> {
  const emb = await getEmbedder()
  if (emb) {
    try {
      return { vector: await emb.embed(text), isPseudo: false }
    } catch { /* fallback */ }
  }
  return { vector: generatePseudoVector(text), isPseudo: true }
}

export async function generateVector(text: string): Promise<number[]> {
  const meta = await generateVectorWithMeta(text)
  return meta.vector
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// P1-12 修复：伪向量恰为 384 维，原仅查维度恒为 false → reembedAll 与知识库
// 迁移循环永久 no-op，伪向量被当作真实语义嵌入永久使用。
// 新语义：维度不符 → 需重嵌入；isPseudo=true → 需重嵌入；
// isPseudo 缺失（旧持久化记录）→ 保守视为需重嵌入（一次性迁移代价）。
export function needsReembedding(vector: number[], isPseudo?: boolean): boolean {
  if (vector.length !== VECTOR_DIM) return true
  return isPseudo !== false
}
