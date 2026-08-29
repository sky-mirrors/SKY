export const VECTOR_DIM = 384

type Embedder = { embed: (text: string) => Promise<number[]> }

let embedder: Embedder | null = null
let embedderPromise: Promise<Embedder | null> | null = null
let embedderReady = false

export async function getEmbedder(): Promise<Embedder | null> {
  if (embedder) return embedder
  if (embedderPromise) return embedderPromise
  embedderPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers')
      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' } as Record<string, unknown>)
      embedder = {
        async embed(text: string): Promise<number[]> {
          const output = await extractor(text, { pooling: 'mean', normalize: true })
          return Array.from(output.data) as number[]
        }
      }
      embedderReady = true
      return embedder
    } catch (err) {
      console.warn('[Embedder] transformers.js load failed:', err)
      embedderPromise = null
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

export async function generateVector(text: string): Promise<number[]> {
  const emb = await getEmbedder()
  if (emb) {
    try {
      return await emb.embed(text)
    } catch { /* fallback */ }
  }
  return generatePseudoVector(text)
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

export function needsReembedding(vector: number[]): boolean {
  return vector.length !== VECTOR_DIM
}
