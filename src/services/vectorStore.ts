interface ChunkMeta {
  entryId: string
  chunkIndex: number
  text: string
  tokens: number
  vectorOffset: number
  vectorDim: number
  // C-11：vectorIsPseudo 必须随 meta 持久化。缺失时 needsReembedding 按保守
  // 语义视为需重嵌入（isPseudo !== false）→ 真实向量每次检索都被重复嵌入、永不收敛
  vectorIsPseudo?: boolean
}

const META_KEY_PREFIX = 'chunks-meta-'

function float32ArrayToBase64(arr: Float32Array): string {
  const buf = new ArrayBuffer(arr.byteLength)
  const view = new Float32Array(buf)
  view.set(arr)
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToFloat32Array(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Float32Array(bytes.buffer)
}

function isFileStoreAvailable(): boolean {
  return !!window.electronAPI?.vectorWriteBin
}

export async function saveChunksToFile(
  entryId: string,
  chunks: { text: string; chunkIndex: number; vector: number[]; tokens: number; vectorIsPseudo?: boolean }[]
): Promise<boolean> {
  if (!isFileStoreAvailable()) return false

  const dim = chunks.length > 0 && chunks[0].vector.length > 0 ? chunks[0].vector.length : 384
  const totalFloats = chunks.length * dim
  const allVectors = new Float32Array(totalFloats)
  const metas: ChunkMeta[] = []

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    const offset = i * dim
    const vec = c.vector.length === dim ? c.vector : new Array(dim).fill(0)
    for (let j = 0; j < dim; j++) {
      allVectors[offset + j] = vec[j]
    }
    metas.push({
      entryId,
      chunkIndex: c.chunkIndex,
      text: c.text,
      tokens: c.tokens,
      vectorOffset: offset,
      vectorDim: dim,
      // C-11：保留伪向量标记
      vectorIsPseudo: c.vectorIsPseudo
    })
  }

  const base64 = float32ArrayToBase64(allVectors)
  const vecOk = await window.electronAPI.vectorWriteBin(`vec-${entryId}`, base64)
  if (!vecOk) return false

  const metaOk = await window.electronAPI.storeWrite(META_KEY_PREFIX + entryId, metas)
  return metaOk
}

export async function loadChunksFromFile(entryId: string): Promise<{
  text: string
  entryId: string
  chunkIndex: number
  vector: number[]
  tokens: number
  vectorIsPseudo?: boolean
}[] | null> {
  if (!isFileStoreAvailable()) return null

  const metas = await window.electronAPI.storeRead(META_KEY_PREFIX + entryId) as ChunkMeta[] | null
  if (!metas || !Array.isArray(metas) || metas.length === 0) return null

  const raw = await window.electronAPI.vectorReadBin(`vec-${entryId}`)
  if (!raw) return null

  const arrayBuffer = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
  const allVectors = new Float32Array(arrayBuffer)

  const results: {
    text: string
    entryId: string
    chunkIndex: number
    vector: number[]
    tokens: number
    vectorIsPseudo?: boolean
  }[] = []

  for (const meta of metas) {
    const vec = new Array(meta.vectorDim)
    for (let j = 0; j < meta.vectorDim; j++) {
      vec[j] = allVectors[meta.vectorOffset + j]
    }
    results.push({
      text: meta.text,
      entryId: meta.entryId,
      chunkIndex: meta.chunkIndex,
      vector: vec,
      tokens: meta.tokens,
      // C-11：读回时还原伪向量标记（旧数据无该字段 → undefined，保守视为需重嵌入）
      vectorIsPseudo: meta.vectorIsPseudo
    })
  }

  return results
}

export async function listVectorEntries(): Promise<string[]> {
  if (!isFileStoreAvailable()) return []
  return window.electronAPI.vectorListKeys()
}

// C-16：删除条目时清理其二进制向量文件，消除磁盘隐私残留
export async function deleteChunksFile(entryId: string): Promise<boolean> {
  if (!isFileStoreAvailable() || !window.electronAPI.vectorDeleteBin) return false
  try {
    return await window.electronAPI.vectorDeleteBin(`vec-${entryId}`)
  } catch {
    return false
  }
}

export async function migrateFromLocalStorage(): Promise<number> {
  if (!isFileStoreAvailable()) return 0

  let migrated = 0
  const prefix = 'holo-kb-chunks-'
  const keysToRemove: string[] = []

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(prefix)) continue

    const entryId = key.replace(prefix, '')
    const metaCheck = await window.electronAPI.storeRead(META_KEY_PREFIX + entryId)
    if (metaCheck !== null) {
      keysToRemove.push(key)
      continue
    }

    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const chunks = JSON.parse(raw) as { text: string; entryId: string; chunkIndex: number; vector: number[]; tokens: number }[]
      if (!Array.isArray(chunks) || chunks.length === 0) continue

      const ok = await saveChunksToFile(entryId, chunks)
      if (ok) {
        migrated++
        keysToRemove.push(key)
      }
    } catch { /* skip */ }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }

  return migrated
}
