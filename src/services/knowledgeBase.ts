import { KnowledgeEntry, SearchResult, KnowledgeAdapter } from '@/models'
import { saveChunksToFile, loadChunksFromFile, migrateFromLocalStorage, listVectorEntries, deleteChunksFile } from './vectorStore'
import { getEmbedder, generatePseudoVector as _pseudoVector, generateVector, generateVectorWithMeta, cosineSimilarity, isEmbedderReady as _isEmbReady, needsReembedding, VECTOR_DIM } from './embedder'
import { debugLog } from '@/services/debugLog'
import { estimateTokens } from '@/services/tokenEstimate'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'
import { parseJsonSafe } from './jsonSafe'

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

type EntriesRead = { ok: true; entries: KnowledgeEntry[] } | { ok: false }

// K-3：读索引必须区分「真的空」与「解析失败」。原实现是裸 JSON.parse + 空 catch，
// 把损坏静默降级成 []，随后任意一次摄取都会用 [新条目] 覆盖全库索引——单点解析故障
// 被放大为永久数据丢失（与 2026-09-23 api-config BOM 事故同型）。改走 parseJsonSafe
// （剥 BOM + 失败可见告警），并把「能否安全写回」的判断暴露给写入路径。
function readEntriesStrict(): EntriesRead {
  const raw = vault.readCache('knowledge', STORAGE_KEY)
  if (raw == null) return { ok: true, entries: [] }
  const parsed = parseJsonSafe<KnowledgeEntry[]>(raw, 'vault:holo-knowledge-entries')
  if (parsed == null || !Array.isArray(parsed)) return { ok: false }
  return { ok: true, entries: parsed }
}

export function getKnowledgeEntries(): KnowledgeEntry[] {
  const r = readEntriesStrict()
  return r.ok ? r.entries : []
}

function saveEntries(entries: KnowledgeEntry[]) {
  vault.writeThrough('knowledge', STORAGE_KEY, JSON.stringify(entries))
}

/**
 * K-3：持锁追加条目；索引损坏时抛错而非覆盖（fail-closed）。
 * 错误由 withEntriesLock 原样上抛给调用方/用户，不再静默吞掉。
 */
function appendEntryLocked(entry: KnowledgeEntry): void {
  const r = readEntriesStrict()
  if (!r.ok) {
    throw new Error('知识库索引已损坏（holo-knowledge-entries 无法解析），已拒绝写入以免覆盖全库；请从备份恢复或清空索引后重试')
  }
  r.entries.push(entry)
  saveEntries(r.entries)
}

// C-15：条目索引读-改-写互斥锁（promise 链实现）——摄取窗口秒级，
// 并发导入文件时后写者会用自己的旧快照覆盖前写者，先完成的条目从索引消失
let entriesWriteLock: Promise<unknown> = Promise.resolve()
function withEntriesLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = entriesWriteLock.then(fn, fn)
  entriesWriteLock = run.then(() => undefined, () => undefined)
  return run
}

interface ChunkRecord {
  text: string
  entryId: string
  chunkIndex: number
  vector: number[]
  /** P1-12：vector 为伪向量时标记，needsReembedding 据此识别待重嵌入（旧记录缺失=保守视为伪） */
  vectorIsPseudo?: boolean
  tokens: number
}

function getChunkStore(entryId: string): ChunkRecord[] {
  return getChunkStoreSync(entryId)
}

function getChunkStoreSync(entryId: string): ChunkRecord[] {
  try {
    const raw = vault.readCache('knowledge', `holo-kb-chunks-${entryId}`)
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
    vault.writeThrough('knowledge', `holo-kb-chunks-${entryId}`, JSON.stringify(chunks))
  } catch { /* vault write may fail */ }
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
  partition?: { kind: 'kernel' | 'pack' | 'user'; id?: string }
}

export async function ingestFile(file: File, target: IngestTarget = { type: 'global' }): Promise<KnowledgeEntry> {
  const text = await extractText(file)
  const fingerprint = computeFingerprint(text)

  const existing = getKnowledgeEntries().find(e => e.fingerprint === fingerprint)
  if (existing) return existing

  const chunks = chunkBySemantic(text, 512)
  const chunkRecords: ChunkRecord[] = []
  // C-25：毫秒时间戳 ID 并发摄取同毫秒可碰撞互相覆盖，追加随机段保证唯一
  const entryId = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkText = chunks[idx]
    // P1-12：记录伪向量标记，供检索期迁移循环识别
    const { vector, isPseudo } = await generateVectorWithMeta(chunkText)
    chunkRecords.push({
      text: chunkText,
      entryId,
      chunkIndex: idx,
      vector,
      vectorIsPseudo: isPseudo,
      tokens: estimateTokens(chunkText)
    })
  }

  const entry: KnowledgeEntry = {
    id: entryId,
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

  // C-15：追加必须持锁读-改-写，防并发覆盖
  await withEntriesLock(async () => {
    appendEntryLocked(entry) // K-3：索引损坏时抛错，绝不用单条覆盖全库
  })

  return entry
}

export async function ingestText(text: string, target: IngestTarget = { type: 'global' }, label?: string): Promise<KnowledgeEntry> {
  return ingestTextCore(text, target, label, undefined)
}

/**
 * 规格 M11/8.4：pack 知识层摄取——条目打上 partition='pack' / partitionId=packId 标签，
 * 无 partition scope 的检索对其完全不可见（零污染）。
 */
export async function ingestPackText(text: string, packId: string, label?: string): Promise<KnowledgeEntry> {
  return ingestTextCore(text, { type: 'global' }, label, { kind: 'pack', id: packId })
}

async function ingestTextCore(
  text: string,
  target: IngestTarget,
  label: string | undefined,
  partition: { kind: 'kernel' | 'pack' | 'user'; id?: string } | undefined
): Promise<KnowledgeEntry> {
  const chunks = chunkBySemantic(text, 512)
  const chunkRecords: ChunkRecord[] = []
  // C-25：毫秒时间戳 ID 并发摄取同毫秒可碰撞互相覆盖，追加随机段保证唯一
  const entryId = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunkText = chunks[idx]
    const { vector, isPseudo } = await generateVectorWithMeta(chunkText)
    chunkRecords.push({
      text: chunkText,
      entryId,
      chunkIndex: idx,
      vector,
      vectorIsPseudo: isPseudo,
      tokens: estimateTokens(chunkText)
    })
  }

  const entry: KnowledgeEntry = {
    id: entryId,
    filename: label || `text-${Date.now()}`,
    fileType: 'text/plain',
    chunks: chunks.length,
    fingerprint: computeFingerprint(text),
    createdAt: Date.now(),
    ownerType: target.type,
    ownerId: target.ownerId,
    partition: partition?.kind,
    partitionId: partition?.id
  }

  for (const cr of chunkRecords) {
    cr.entryId = entry.id
  }

  await saveChunkStore(entry.id, chunkRecords)

  // C-15：追加必须持锁读-改-写，防并发覆盖
  await withEntriesLock(async () => {
    appendEntryLocked(entry) // K-3：索引损坏时抛错，绝不用单条覆盖全库
  })

  return entry
}

export async function searchKnowledge(query: string, topK: number = 5, scope?: SearchScope): Promise<string[]> {
  const results = await hybridSearch(query, topK, scope)
  return results.map(r => r.text)
}

export async function hybridSearch(query: string, topK: number = 5, scope?: SearchScope): Promise<SearchResult[]> {
  let entries = getKnowledgeEntries()

  // 规格 M11：partition 过滤（先于 ownerType/groupIds 过滤执行，二者正交叠加 AND）。
  // - 显式 partition scope → 仅保留归属分区匹配的条目（pack 需 partitionId 精确相等）；
  // - 无 partition scope → 默认可见范围 = user / undefined / kernel，pack 条目完全不可见（零污染兜底）。
  if (scope && scope.partition) {
    if (scope.partition.kind === 'pack') {
      const packId = scope.partition.id || ''
      entries = entries.filter(e => e.partition === 'pack' && (e.partitionId || '') === packId)
    } else {
      entries = entries.filter(e => (e.partition || 'user') === scope.partition!.kind)
    }
  } else {
    entries = entries.filter(e => e.partition === undefined || e.partition === 'user' || e.partition === 'kernel')
  }

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
      for (const gid of scope.groupIds) {
        const group = globalBus.request<{ id: string; sharedEntryIds: string[] } | null>('knowledge:get-group', { groupId: gid })
        if (group) {
          group.sharedEntryIds.forEach(eid => allowedIds.add(eid))
        }
      }
    }
    // C-09：只要 scope 指定了 owner/group 维度就必须过滤——原来的 `allowedIds.size > 0`
    // 条件下，新会话/空分组首次检索会整体跳过过滤，返回所有其他项目的知识条目（跨项目泄漏）
    if (scope.ownerType || (scope.groupIds && scope.groupIds.length > 0)) {
      const globalIds = new Set(entries.filter(e => !e.ownerType || e.ownerType === 'global').map(e => e.id))
      globalIds.forEach(id => allowedIds.add(id))
      entries = entries.filter(e => allowedIds.has(e.id))
    }
  }

  const allChunks: ChunkRecord[] = []
  for (const entry of entries) {
    const chunks = await getChunkStoreAsync(entry.id)
    // C-10：重嵌入迁移移到这里（按 entry 粒度），迁移结果回写持久层
    await reembedChunksIfStale(entry.id, chunks)
    allChunks.push(...chunks)
  }

  if (allChunks.length === 0) return []

  const vectorResults = await vectorSearch(query, allChunks, 20)
  const bm25Results = bm25Search(query, allChunks, 20)

  const merged = rrfMerge([vectorResults, bm25Results])
  return merged.slice(0, topK)
}

// C-10：检索期重嵌入此前只改内存副本、`migrated` 是死变量，永不落盘 →
// 每次搜索重复全量嵌入（transformers.js 推理极耗 CPU），迁移无限循环。
// 改为按 entry 回写 saveChunkStore（含 vault 与文件向量库双持久层）
async function reembedChunksIfStale(entryId: string, chunks: ChunkRecord[]): Promise<void> {
  let migrated = false
  for (const chunk of chunks) {
    if (needsReembedding(chunk.vector, chunk.vectorIsPseudo)) {
      // P1-12：embedder 未就绪时 generateVector 只会再产一个伪向量，
      // 重嵌入无意义；仅维度不符（旧格式）时仍降级迁移。待 embedder 就绪后一次性补齐。
      if (!isEmbedderReady() && chunk.vector.length === VECTOR_DIM) continue
      const { vector, isPseudo } = await generateVectorWithMeta(chunk.text)
      chunk.vector = vector
      chunk.vectorIsPseudo = isPseudo
      migrated = true
    }
  }
  if (migrated) await saveChunkStore(entryId, chunks)
}

async function vectorSearch(query: string, chunks: ChunkRecord[], topK: number): Promise<SearchResult[]> {
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
  // C-15/C-16：删除与并发摄取同样需要持锁，否则旧快照回写可"复活"已删条目
  return withEntriesLock(async () => {
    // K-3：损坏索引上执行删除会回写「删掉一条后的集合」——等同清空，同样 fail-closed
    const read = readEntriesStrict()
    if (!read.ok) {
      throw new Error('知识库索引已损坏（holo-knowledge-entries 无法解析），已拒绝删除操作以免覆盖全库')
    }
    const entries = read.entries
    const idx = entries.findIndex(e => e.id === entryId)
    if (idx < 0) return false

    entries.splice(idx, 1)
    saveEntries(entries)

    await vault.delete('knowledge', `holo-kb-chunks-${entryId}`)

    try {
      if (window.electronAPI?.storeRead) {
        await window.electronAPI.storeRead(`chunks-meta-${entryId}`)
        if (window.electronAPI?.storeWrite) {
          await window.electronAPI.storeWrite(`chunks-meta-${entryId}`, '')
        }
      }
    } catch { /* non-critical */ }

    // C-16：同步删除二进制向量文件——原实现只清 meta，vec-*.bin 磁盘残留（隐私问题）
    await deleteChunksFile(entryId)

    // C-16：广播条目删除，清理 memoryStore/knowledgeStore/pipelineStore 三处悬空引用
    try {
      globalBus.emit('knowledge:entry-deleted', { entryId })
    } catch { /* non-critical */ }

    return true
  })
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
