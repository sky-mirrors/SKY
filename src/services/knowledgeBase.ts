import { KnowledgeEntry, SearchResult, KnowledgeAdapter } from '@/models'
import { saveChunksToFile, loadChunksFromFile, migrateFromLocalStorage, listVectorEntries } from './vectorStore'
import { getEmbedder, generatePseudoVector as _pseudoVector, generateVector, cosineSimilarity, isEmbedderReady as _isEmbReady, needsReembedding, VECTOR_DIM } from './embedder'
import { debugLog } from '@/services/debugLog'

const STORAGE_KEY = 'holo-knowledge-entries'
const VECTOR_KEY = 'holo-kb-vectors'

let embedderReady = false

export async function initEmbedder(): Promise<boolean> {
  const emb = await getEmbedder()
  embedderReady = emb !== null
  if (embedderReady) {
    migrateFromLocalStorage().then(count => {
      if (count > 0) debugLog(`[KB] 迁移 ${count} 个向量存储到文件系统`)
    }).catch(() => {})
  }
  return embedderReady
}

export function isEmbedderReady(): boolean {
  return embedderReady || _isEmbReady()
}

export function getKnowledgeEntries(): KnowledgeEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveEntries(entries: KnowledgeEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

interface ChunkRecord {
  text: string
  entryId: string
  chunkIndex: number
  vector: number[]
  tokens: number
}

function getChunkStore(entryId: string): ChunkRecord[] {
  return getChunkStoreSync(entryId)
}

function getChunkStoreSync(entryId: string): ChunkRecord[] {
  try {
    const raw = localStorage.getItem(`holo-kb-chunks-${entryId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function getChunkStoreAsync(entryId: string): Promise<ChunkRecord[]> {
  try {
    const fileChunks = await loadChunksFromFile(entryId)
    if (fileChunks && fileChunks.length > 0) return fileChunks
  } catch { /* fallback */ }
  return getChunkStoreSync(entryId)
}

async function saveChunkStore(entryId: string, chunks: ChunkRecord[]) {
  try {
    localStorage.setItem(`holo-kb-chunks-${entryId}`, JSON.stringify(chunks))
  } catch { /* localStorage may be full */ }
  await saveChunkStoreToFile(entryId, chunks)
}

async function saveChunkStoreToFile(entryId: string, chunks: ChunkRecord[]) {
  try {
    await saveChunksToFile(entryId, chunks)
  } catch { /* non-critical */ }
}

function computeFingerprint(text: string): string {
  const size = text.length
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  }
  return `${hash.toString(16)}-${size}`
}

function simpleTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
}

function chunkBySemantic(text: string, maxTokens: number = 512): string[] {
  const paragraphs = text.split(/\n{2,}|\r\n\r\n/)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para)
    const currentTokens = estimateTokens(current)

    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      chunks.push(current.trim())
      current = para
    } else {
      current += (current ? '\n\n' : '') + para
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(c => c.length > 0)
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.5 + other * 0.25)
}

function bm25Score(query: string, doc: string, avgDl: number, df: Record<string, number>, totalDocs: number): number {
  const k1 = 1.5
  const b = 0.75
  const queryTerms = simpleTokenize(query)
  const docTerms = simpleTokenize(doc)
  const docLen = docTerms.length
  const tf: Record<string, number> = {}
  for (const t of docTerms) {
    tf[t] = (tf[t] || 0) + 1
  }

  let score = 0
  for (const term of queryTerms) {
    const termTf = tf[term] || 0
    const termDf = df[term] || 0
    const idf = Math.log((totalDocs - termDf + 0.5) / (termDf + 0.5) + 1)
    const tfNorm = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * docLen / avgDl))
    score += idf * tfNorm
  }
  return score
}

function rrfMerge(rankings: SearchResult[][], k: number = 60): SearchResult[] {
  const scoreMap: Record<string, number> = {}
  const textMap: Record<string, SearchResult> = {}

  for (const ranking of rankings) {
    for (let i = 0; i < ranking.length; i++) {
      const key = `${ranking[i].entryId}-${ranking[i].text.slice(0, 50)}`
      if (!scoreMap[key]) scoreMap[key] = 0
      scoreMap[key] += 1 / (k + i + 1)
      textMap[key] = ranking[i]
    }
  }

  const merged = Object.entries(scoreMap)
    .map(([key, score]) => ({ ...textMap[key], score, source: 'hybrid' as const }))
    .sort((a, b) => b.score - a.score)

  const maxScore = merged.length > 0 ? merged[0].score : 1
  if (maxScore > 0) {
    for (const item of merged) {
      item.score = item.score / maxScore
    }
  }

  return merged
}

async function extractText(file: File): Promise<string> {
  if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
    return file.text()
  }
  if (file.type === 'application/json' || file.name.endsWith('.json')) {
    return file.text()
  }
  if (file.name.endsWith('.csv')) {
    return file.text()
  }
  if (file.name.endsWith('.pdf')) {
    return `[PDF文件: ${file.name}, 大小: ${file.size}字节] - PDF解析需要pdf.js支持，当前提取元数据`
  }
  if (file.name.match(/\.(docx?|xlsx?|pptx?)$/)) {
    return `[Office文件: ${file.name}, 大小: ${file.size}字节] - Office解析需要后端支持`
  }
  return `[文件: ${file.name}, 类型: ${file.type}, 大小: ${file.size}字节]`
}

export interface IngestTarget {
  type: 'global' | 'session' | 'pipeline' | 'group' | 'conversation'
  ownerId?: string
}

export interface SearchScope {
  ownerType?: 'global' | 'session' | 'pipeline' | 'group' | 'conversation'
  ownerId?: string
  groupIds?: string[]
}

export async function ingestFile(file: File, target: IngestTarget = { type: 'global' }): Promise<KnowledgeEntry> {
  const text = await extractText(file)
  const fingerprint = computeFingerprint(text)

  const existing = getKnowledgeEntries().find(e => e.fingerprint === fingerprint)
  if (existing) return existing

  const chunks = chunkBySemantic(text, 512)
  const chunkRecords: ChunkRecord[] = []
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkText = chunks[idx]
    const vector = await generateVector(chunkText)
    chunkRecords.push({
      text: chunkText,
      entryId: `kb-${Date.now()}`,
      chunkIndex: idx,
      vector,
      tokens: estimateTokens(chunkText)
    })
  }

  const entry: KnowledgeEntry = {
    id: chunkRecords.length > 0 ? chunkRecords[0].entryId : `kb-${Date.now()}`,
    filename: file.name,
    fileType: file.type || file.name.split('.').pop() || 'unknown',
    chunks: chunks.length,
    fingerprint,
    createdAt: Date.now(),
    ownerType: target.type,
    ownerId: target.ownerId
  }

  for (const cr of chunkRecords) {
    cr.entryId = entry.id
  }

  await saveChunkStore(entry.id, chunkRecords)

  const entries = getKnowledgeEntries()
  entries.push(entry)
  saveEntries(entries)

  return entry
}

export async function ingestText(text: string, target: IngestTarget = { type: 'global' }, label?: string): Promise<KnowledgeEntry> {
  const chunks = chunkBySemantic(text, 512)
  const chunkRecords: ChunkRecord[] = []
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkText = chunks[idx]
    const vector = await generateVector(chunkText)
    chunkRecords.push({
      text: chunkText,
      entryId: `kb-${Date.now()}`,
      chunkIndex: idx,
      vector,
      tokens: estimateTokens(chunkText)
    })
  }

  const entry: KnowledgeEntry = {
    id: chunkRecords.length > 0 ? chunkRecords[0].entryId : `kb-${Date.now()}`,
    filename: label || `text-${Date.now()}`,
    fileType: 'text/plain',
    chunks: chunks.length,
    fingerprint: computeFingerprint(text),
    createdAt: Date.now(),
    ownerType: target.type,
    ownerId: target.ownerId
  }

  for (const cr of chunkRecords) {
    cr.entryId = entry.id
  }

  await saveChunkStore(entry.id, chunkRecords)

  const entries = getKnowledgeEntries()
  entries.push(entry)
  saveEntries(entries)

  return entry
}

export async function searchKnowledge(query: string, topK: number = 5, scope?: SearchScope): Promise<string[]> {
  const results = await hybridSearch(query, topK, scope)
  return results.map(r => r.text)
}

export async function hybridSearch(query: string, topK: number = 5, scope?: SearchScope): Promise<SearchResult[]> {
  let entries = getKnowledgeEntries()

  if (scope) {
    const allowedIds = new Set<string>()
    if (scope.ownerType) {
      if (scope.ownerId) {
        entries.filter(e => e.ownerType === scope.ownerType && e.ownerId === scope.ownerId).forEach(e => allowedIds.add(e.id))
      } else {
        entries.filter(e => e.ownerType === scope.ownerType).forEach(e => allowedIds.add(e.id))
      }
    }
    if (scope.groupIds && scope.groupIds.length > 0) {
      const knowledgeStore = await import('@/stores/knowledgeStore')
      const store = knowledgeStore.useKnowledgeStore()
      for (const gid of scope.groupIds) {
        const group = store.knowledgeGroups.find(g => g.id === gid)
        if (group) {
          group.sharedEntryIds.forEach(eid => allowedIds.add(eid))
        }
      }
    }
    if (allowedIds.size > 0) {
      const globalIds = new Set(entries.filter(e => !e.ownerType || e.ownerType === 'global').map(e => e.id))
      globalIds.forEach(id => allowedIds.add(id))
      entries = entries.filter(e => allowedIds.has(e.id))
    }
  }

  const allChunks: ChunkRecord[] = []
  for (const entry of entries) {
    const chunks = await getChunkStoreAsync(entry.id)
    allChunks.push(...chunks)
  }

  if (allChunks.length === 0) return []

  const vectorResults = await vectorSearch(query, allChunks, 20)
  const bm25Results = bm25Search(query, allChunks, 20)

  const merged = rrfMerge([vectorResults, bm25Results])
  return merged.slice(0, topK)
}

async function vectorSearch(query: string, chunks: ChunkRecord[], topK: number): Promise<SearchResult[]> {
  let migrated = false
  for (const chunk of chunks) {
    if (needsReembedding(chunk.vector)) {
      chunk.vector = await generateVector(chunk.text)
      migrated = true
    }
  }

  const queryVec = await generateVector(query)
  const scored = chunks.map(chunk => ({
    text: chunk.text,
    entryId: chunk.entryId,
    score: cosineSimilarity(queryVec, chunk.vector),
    source: isEmbedderReady() ? 'vector' as const : 'pseudo-vector' as const
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

function bm25Search(query: string, chunks: ChunkRecord[], topK: number): SearchResult[] {
  const totalDocs = chunks.length
  const allTerms = chunks.flatMap(c => simpleTokenize(c.text))
  const df: Record<string, number> = {}
  for (const term of allTerms) {
    df[term] = (df[term] || 0) + 1
  }
  const avgDl = allTerms.length / totalDocs

  const scored = chunks.map(chunk => ({
    text: chunk.text,
    entryId: chunk.entryId,
    score: bm25Score(query, chunk.text, avgDl, df, totalDocs),
    source: 'keyword' as const
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

export function getEntry(id: string): KnowledgeEntry | null {
  return getKnowledgeEntries().find(e => e.id === id) ?? null
}

export async function deleteKnowledgeEntry(entryId: string): Promise<boolean> {
  const entries = getKnowledgeEntries()
  const idx = entries.findIndex(e => e.id === entryId)
  if (idx < 0) return false

  entries.splice(idx, 1)
  saveEntries(entries)

  localStorage.removeItem(`holo-kb-chunks-${entryId}`)

  try {
    if (window.electronAPI?.storeRead) {
      await window.electronAPI.storeRead(`chunks-meta-${entryId}`)
      if (window.electronAPI?.storeWrite) {
        await window.electronAPI.storeWrite(`chunks-meta-${entryId}`, '')
      }
    }
  } catch { /* non-critical */ }

  return true
}

export function getEntriesByOwner(ownerType: string, ownerId: string): KnowledgeEntry[] {
  return getKnowledgeEntries().filter(e => e.ownerType === ownerType && e.ownerId === ownerId)
}

export async function searchKnowledgeInGroup(groupId: string, query: string, topK: number = 5): Promise<SearchResult[]> {
  return hybridSearch(query, topK, { groupIds: [groupId] })
}

export const knowledgeAdapter: KnowledgeAdapter = {
  async ingestFile(file) { return ingestFile(file) },
  async search(query, topK) { return hybridSearch(query, topK || 5) },
  getEntry(id) { return getEntry(id) }
}
