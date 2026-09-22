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
 */
const LOAD_TIMEOUT_MS = 15000
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
      const { pipeline } = await import('@xenova/transformers')
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
