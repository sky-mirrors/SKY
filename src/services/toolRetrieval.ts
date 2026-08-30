import { generateVector as genVec, cosineSimilarity } from './embedder'
import { L2ToolManifest } from '@/models'
import { getFileBoostForItem } from './fileContext'
import { debugLog } from '@/services/debugLog'

const STOP_WORDS_SET = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '或', '帮', '给', '让', '把', '被', '从', '到', '用', '对', '为', '以', '及', '等', '着', '过', '一下', '一下下', '一个', '一些', '请', '要', '会', '能', '可以', '帮我', '帮我看看', '搞', '搞一下', '做', '做一下', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'this', 'that', 'me', 'my', 'your'])

interface ToolIndex {
  fullName: string
  shortName: string
  summary: string
  description: string
  vector: number[]
  mcpId: string
  l2ManifestId?: string
  isL2Macro?: boolean
  contentHash?: string
}

const TOOL_INDEX_KEY = 'holo-tool-index'

const ROUTE_CACHE_MAX = 100
const ROUTE_CACHE_TTL = 30 * 60 * 1000

interface RouteCacheEntry {
  result: UniversalMatchResult
  timestamp: number
  indexHash: string
}

const _routeCache = new Map<string, RouteCacheEntry>()

function computeIndexHash(index: ToolIndex[]): string {
  const ids = index.map(t => t.fullName).sort().join(',')
  return contentHash(ids)
}

export function getRouteCacheStats(): { size: number; hits: number; misses: number } {
  return { size: _routeCache.size, hits: _routeCacheHitCount, misses: _routeCacheMissCount }
}

export function clearRouteCache(): void {
  _routeCache.clear()
  _routeCacheHitCount = 0
  _routeCacheMissCount = 0
}

let _routeCacheHitCount = 0
let _routeCacheMissCount = 0

function lookupRouteCache(query: string, indexHash: string): UniversalMatchResult | null {
  const key = contentHash(query + '|' + indexHash)
  const entry = _routeCache.get(key)
  if (!entry) {
    _routeCacheMissCount++
    return null
  }
  if (Date.now() - entry.timestamp > ROUTE_CACHE_TTL) {
    _routeCache.delete(key)
    _routeCacheMissCount++
    return null
  }
  if (entry.indexHash !== indexHash) {
    _routeCache.delete(key)
    _routeCacheMissCount++
    return null
  }
  _routeCacheHitCount++
  debugLog(`[RouteCache] 命中: "${query.substring(0, 30)}" → ${entry.result.item.name}`)
  return entry.result
}

function storeRouteCache(query: string, indexHash: string, result: UniversalMatchResult): void {
  const key = contentHash(query + '|' + indexHash)
  _routeCache.set(key, { result, timestamp: Date.now(), indexHash })
  if (_routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = Array.from(_routeCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < oldest.length - ROUTE_CACHE_MAX; i++) {
      _routeCache.delete(oldest[i][0])
    }
  }
}

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  if (typeof navigator.onLine === 'undefined') return true
  return navigator.onLine
}

function ruleEngineFallback(
  userInput: string,
  candidates: { item: MatchableItem; score: number; method: string }[]
): MatchableItem | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].item

  const inputSegs = segmentChinese(userInput)
  const inputLower = userInput.toLowerCase()

  let best: MatchableItem | null = null
  let bestHits = -1

  for (const c of candidates.slice(0, 5)) {
    const kwSegs = segmentChinese(c.item.name + ' ' + c.item.description)
    const hits = kwSegs.filter(kw => inputSegs.includes(kw) || inputLower.includes(kw.toLowerCase())).length
    if (hits > bestHits) {
      bestHits = hits
      best = c.item
    }
  }

  debugLog(`[ruleEngineFallback] 离线模式，关键词决胜: ${best?.name || 'null'} (hits=${bestHits})`)
  return bestHits > 0 ? best : candidates[0].item
}

function loadToolIndex(): ToolIndex[] {
  try {
    const raw = localStorage.getItem(TOOL_INDEX_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveToolIndex(index: ToolIndex[]): void {
  try {
    localStorage.setItem(TOOL_INDEX_KEY, JSON.stringify(index))
  } catch {
    console.warn('[RaaP] localStorage写入失败(可能超出配额)，索引仅存于内存')
  }
}

export function contentHash(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function manifestFingerprint(m: L2ToolManifest): string {
  const parts = [
    m.identity.id,
    m.identity.name,
    (m.routing.keywords || []).join(','),
    m.routing.retrievalSummary || '',
    m.routing.userSummary || ''
  ]
  return contentHash(parts.join('|'))
}

let _cachedL2Index: ToolIndex[] | null = null
let _cachedL2Version = ''

export async function buildL2Index(l2Manifests: L2ToolManifest[]): Promise<ToolIndex[]> {
  const version = l2Manifests.map(m => `${m.identity.id}:${manifestFingerprint(m)}`).sort().join(',')
  if (_cachedL2Index && _cachedL2Version === version) {
    return _cachedL2Index
  }
  const existing = loadToolIndex()
  const existingMap = new Map(existing.map(t => [t.fullName, t]))
  const result: ToolIndex[] = []
  let generated = 0
  for (const m of l2Manifests) {
    const key = `l2://${m.identity.id}`
    const fp = manifestFingerprint(m)
    const cached = existingMap.get(key)
    if (cached && cached.contentHash === fp) {
      result.push(cached)
      continue
    }
    debugLog(`[RaaP] 生成L2向量: ${m.identity.name} (${key})`)
    const summary = `${m.identity.name}: ${m.routing.retrievalSummary}`
    const vector = await genVec(`${m.routing.keywords.join(' ')} ${m.routing.retrievalSummary}`)
    const entry: ToolIndex = {
      fullName: key,
      shortName: m.identity.name,
      summary,
      description: m.routing.retrievalSummary,
      vector,
      mcpId: '',
      l2ManifestId: m.identity.id,
      isL2Macro: m.execution.mode === 'macro' || m.execution.mode === 'chain',
      contentHash: fp
    }
    result.push(entry)
    generated++
    if (generated % 3 === 0) {
      await new Promise(r => setTimeout(r, 0))
    }
  }
  const allExisting = existing.filter(t => !t.l2ManifestId)
  const merged = [...allExisting, ...result]
  saveToolIndex(merged)
  _cachedL2Index = result
  _cachedL2Version = version
  return result
}

export async function buildToolIndex(
  tools: { name: string; description: string; mcpId?: string }[],
  l2Manifests?: L2ToolManifest[]
): Promise<ToolIndex[]> {
  const existing = loadToolIndex()
  const existingMap = new Map(existing.map(t => [t.fullName, t]))

  const newIndex: ToolIndex[] = []
  for (const tool of tools) {
    const existingEntry = existingMap.get(tool.name)
    if (existingEntry) {
      newIndex.push(existingEntry)
      continue
    }
    const shortName = tool.name.replace(/.*___/, '')
    const descFirst = tool.description.split(/[.。！!]/)[0] || tool.description
    const summary = `${shortName}: ${descFirst.substring(0, 80)}`
    const vector = await genVec(summary)
    newIndex.push({
      fullName: tool.name,
      shortName,
      summary,
      description: tool.description,
      vector,
      mcpId: tool.mcpId || ''
    })
  }

  if (l2Manifests && l2Manifests.length > 0) {
    const l2Index = await buildL2Index(l2Manifests)
    newIndex.push(...l2Index)
  }

  saveToolIndex(newIndex)
  return newIndex
}

export async function retrieveTopTools(
  userInput: string,
  index: ToolIndex[],
  topK: number = 10
): Promise<ToolIndex[]> {
  if (index.length === 0) return []

  const queryVec = await genVec(userInput)
  const scored = index.map(tool => ({
    tool,
    score: cosineSimilarity(queryVec, tool.vector)
  }))
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topK).map(s => s.tool)
}

export function makeSummaryToolList(tools: ToolIndex[]): string {
  return tools.map(t => `- ${t.summary}`).join('\n')
}

export interface MatchableItem {
  id: string
  name: string
  description: string
  keywords: string[]
  userSummary: string
  source: 'l2' | 'mcp'
  manifest?: L2ToolManifest
  toolIndex?: ToolIndex
}

export interface RaapMatchResult {
  manifest: L2ToolManifest
  confidence: number
  matchMethod: 'vector' | 'keyword' | 'model'
  isAmbiguous: boolean
  candidates?: { manifest: L2ToolManifest; score: number; method: string }[]
  gate: 'green' | 'yellow' | 'red'
}

export interface UniversalMatchResult {
  item: MatchableItem
  confidence: number
  matchMethod: 'vector' | 'keyword' | 'keyword+vector'
  isAmbiguous: boolean
  candidates?: { item: MatchableItem; score: number; method: string }[]
  gate: 'green' | 'yellow' | 'red'
}

const VECTOR_AMBIGUOUS_LOW = 0.55
const GATE_GREEN_THRESHOLD = 0.95

const CJK_SEGMENT_MIN = 2

export function segmentChinese(text: string): string[] {
  const segments: string[] = []
  let buf = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    const isCJK = (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF)
    const isAlnum = /[a-zA-Z0-9]/.test(ch)
    if (isCJK) {
      if (buf && /[a-zA-Z0-9]/.test(buf)) {
        if (buf.length >= CJK_SEGMENT_MIN) segments.push(buf.toLowerCase())
        buf = ''
      }
      buf += ch
    } else if (isAlnum) {
      if (buf && !/[a-zA-Z0-9]/.test(buf)) {
        if (buf.length >= CJK_SEGMENT_MIN) segments.push(buf.toLowerCase())
        buf = ''
      }
      buf += ch
    } else {
      if (buf.length >= CJK_SEGMENT_MIN) segments.push(buf.toLowerCase())
      buf = ''
    }
  }
  if (buf.length >= CJK_SEGMENT_MIN) segments.push(buf.toLowerCase())
  return segments
}

export function generateNGrams(text: string, minLen: number, maxLen: number): string[] {
  const ngrams: string[] = []
  const lower = text.toLowerCase()
  for (let len = minLen; len <= Math.min(maxLen, lower.length); len++) {
    for (let i = 0; i <= lower.length - len; i++) {
      ngrams.push(lower.substring(i, i + len))
    }
  }
  return ngrams
}

function keywordMatchScoreGeneric(userInput: string, keywords: string[], userSummary: string): number {
  const inputLower = userInput.toLowerCase()
  const inputSegs = segmentChinese(userInput)
  const inputNgrams = generateNGrams(userInput, 2, 4)
  let hits = 0

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase()

    if (inputLower.includes(kwLower)) {
      hits++
      continue
    }

    const kwSegs = segmentChinese(kw)
    if (kwSegs.length >= 2) {
      const matched = kwSegs.filter(ks => inputSegs.includes(ks) || inputNgrams.includes(ks))
      if (matched.length >= Math.ceil(kwSegs.length * 0.7)) {
        hits += matched.length === kwSegs.length ? 1 : 0.8
        continue
      }
    }

    const parts = kw.split(/[\s_\-]+/).filter(p => p.length >= 2)
    if (parts.length >= 2) {
      const matched = parts.filter(p => inputLower.includes(p.toLowerCase()))
      if (matched.length === parts.length) {
        hits += 0.8
        continue
      }
    }

    if (kw.length >= 2 && kw.length <= 4) {
      if (inputNgrams.includes(kwLower)) {
        hits += 0.6
        continue
      }
    }

    const kwNgrams = generateNGrams(kw, 2, 4)
    const overlap = kwNgrams.filter(kn => inputNgrams.includes(kn))
    if (kwNgrams.length > 0 && overlap.length >= Math.max(2, Math.ceil(kwNgrams.length * 0.3))) {
      hits += 0.5 * (overlap.length / kwNgrams.length)
      continue
    }
  }

  let score = keywords.length > 0 ? hits / keywords.length : 0
  const createWords = ['创建', '新建', '写', '生成', '保存']
  const docWords = ['文档', '文件', 'docx', 'word', 'txt', 'pdf']
  const hasCreate = createWords.some(w => inputSegs.includes(w) || inputLower.includes(w))
  const hasDoc = docWords.some(w => inputSegs.includes(w) || inputLower.includes(w))
  if (hasCreate && hasDoc && userSummary.includes('创建文件')) {
    score = Math.min(1, score + 0.3)
  }
  return score
}

export function keywordMatchScore(userInput: string, manifest: L2ToolManifest): number {
  return keywordMatchScoreGeneric(userInput, manifest.routing.keywords, manifest.routing.userSummary || '')
}

const NEGATION_WORDS = ['不要', '别', '禁止', '排除', '除了', '不要创建', '不要生成', '不要写', '别创建', '别生成', 'not', "don't", 'no', 'exclude', 'without']

const DIRECTIVE_WORDS = new Set(['帮我', '给我', '请', '创建', '生成', '写一个', '在桌面', '新建', '帮我看看', '搞', '搞一下', '做', '做一下', '一下', '一下下'])

function hasNegation(input: string): boolean {
  const lower = input.toLowerCase()
  return NEGATION_WORDS.some(nw => lower.includes(nw))
}

export function extractCoreKeywords(query: string): string[] {
  const segs = segmentChinese(query)
  const filtered = segs.filter(s => !STOP_WORDS_SET.has(s) && s.length >= 2)
  const cleaned = filtered.filter(s => {
    for (const dw of DIRECTIVE_WORDS) {
      if (s === dw || s.includes(dw)) return false
    }
    return true
  })
  return cleaned.length > 0 ? cleaned : segs.filter(s => s.length >= 2)
}

export function extractKeywordsFromDescription(name: string, description: string): string[] {
  const keywords: string[] = []
  const shortName = name.replace(/.*___/, '')
  const nameParts = shortName.split(/[_\-]+/).filter(p => p.length >= 2)
  keywords.push(...nameParts.map(p => p.toLowerCase()))

  const descSegs = segmentChinese(description)
  keywords.push(...descSegs)

  const descLower = description.toLowerCase()
  const engWords = descLower.match(/[a-z]{3,}/g) || []
  keywords.push(...engWords)

  return [...new Set(keywords)]
}

function computeRRFGeneric(
  vectorScores: { item: MatchableItem; score: number }[],
  kwScores: { item: MatchableItem; score: number }[],
  k: number = 60
): { item: MatchableItem; rrfScore: number; kwRank: number; vecRank: number; method: string }[] {
  const rrfMap = new Map<string, { item: MatchableItem; rrfScore: number; kwRank: number; vecRank: number; method: string }>()

  vectorScores.forEach((v, i) => {
    const id = v.item.id
    const contrib = 1 / (k + i + 1)
    rrfMap.set(id, { item: v.item, rrfScore: contrib, kwRank: 999, vecRank: i + 1, method: 'vector' })
  })

  kwScores.forEach((kw, i) => {
    const id = kw.item.id
    const contrib = 1 / (k + i + 1)
    const existing = rrfMap.get(id)
    if (existing) {
      existing.rrfScore += contrib
      existing.kwRank = i + 1
      existing.method = existing.vecRank <= kwScores.length ? 'keyword+vector' : 'keyword'
    } else {
      rrfMap.set(id, { item: kw.item, rrfScore: contrib, kwRank: i + 1, vecRank: 999, method: 'keyword' })
    }
  })

  return Array.from(rrfMap.values()).sort((a, b) => b.rrfScore - a.rrfScore)
}

function buildCandidatesFromRRFGeneric(
  rrfResults: { item: MatchableItem; rrfScore: number; method: string }[],
  vectorScores: { item: MatchableItem; score: number }[],
  kwScores: { item: MatchableItem; score: number }[]
): { item: MatchableItem; score: number; method: string }[] {
  const vecMap = new Map(vectorScores.map(v => [v.item.id, v.score]))
  const kwMap = new Map(kwScores.map(k => [k.item.id, k.score]))

  return rrfResults.slice(0, 5).map(r => {
    const vecS = vecMap.get(r.item.id) || 0
    const kwS = kwMap.get(r.item.id) || 0
    const bestRaw = Math.max(vecS, kwS)
    return { item: r.item, score: bestRaw > 0 ? bestRaw : r.rrfScore, method: r.method }
  })
}

interface ScoreRecord {
  score: number
  timestamp: number
  type: 'keyword' | 'vector'
}

const _kwScoreHistory: ScoreRecord[] = []
const _vecScoreHistory: ScoreRecord[] = []
const SCORE_HISTORY_MAX = 200

function recordScore(score: number, type: 'keyword' | 'vector'): void {
  const pool = type === 'keyword' ? _kwScoreHistory : _vecScoreHistory
  pool.push({ score, timestamp: Date.now(), type })
  if (pool.length > SCORE_HISTORY_MAX) pool.shift()
}

function computeDynamicThreshold(baseThreshold: number, fallback: number, type: 'keyword' | 'vector'): number {
  const pool = type === 'keyword' ? _kwScoreHistory : _vecScoreHistory
  if (pool.length < 10) return fallback
  const scores = pool.map(s => s.score).sort((a, b) => a - b)
  const p95 = scores[Math.floor(scores.length * 0.95)]
  const p50 = scores[Math.floor(scores.length * 0.50)]
  const p5 = scores[Math.floor(scores.length * 0.05)]
  if (p95 - p5 < 0.1) return fallback
  const dynamic = p50 + (p95 - p50) * (baseThreshold - 0.5) * 2

  const prior = type === 'keyword' ? 0.6 : 0.85
  const shrinkage = Math.min(1, pool.length / 100)
  const smoothed = prior * (1 - shrinkage) + dynamic * shrinkage

  return Math.max(0.3, Math.min(0.98, smoothed))
}

const MARGIN_THRESHOLD = 0.10

function manifestToItem(m: L2ToolManifest): MatchableItem {
  return {
    id: `l2://${m.identity.id}`,
    name: m.identity.name,
    description: m.routing.retrievalSummary || '',
    keywords: m.routing.keywords,
    userSummary: m.routing.userSummary || '',
    source: 'l2',
    manifest: m
  }
}

function toolIndexToItem(t: ToolIndex): MatchableItem {
  return {
    id: t.fullName,
    name: t.shortName,
    description: t.description,
    keywords: extractKeywordsFromDescription(t.shortName, t.description),
    userSummary: t.description,
    source: 'mcp',
    toolIndex: t
  }
}

export async function universalMatch(
  userInput: string,
  toolIndex: ToolIndex[],
  filterOptions?: { visibleL2Ids?: string[]; selectedRole?: string }
): Promise<UniversalMatchResult | null> {
  if (toolIndex.length === 0) return null

  const idxHash = computeIndexHash(toolIndex)
  const cached = lookupRouteCache(userInput, idxHash)
  if (cached) return cached

  const isNegated = hasNegation(userInput)
  let filteredIndex = toolIndex
  if (filterOptions?.visibleL2Ids && filterOptions.visibleL2Ids.length > 0) {
    filteredIndex = toolIndex.filter(t => !t.l2ManifestId || filterOptions.visibleL2Ids!.includes(t.l2ManifestId))
  }
  const items: MatchableItem[] = filteredIndex.map(t =>
    t.l2ManifestId
      ? manifestToItem({ identity: { id: t.l2ManifestId, name: t.shortName, version: '', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' }, visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' }, routing: { keywords: extractKeywordsFromDescription(t.shortName, t.description), targetRoles: [], requiredL1: [], inputType: 'text', retrievalSummary: t.description, userSummary: t.description, confidenceThreshold: 0.5 }, execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [] } }, cacheMeta: { cacheKeyTemplate: '', cacheTTL: 0, estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false } } as L2ToolManifest)
      : toolIndexToItem(t)
  )
  const l2ManifestMap = new Map<string, Partial<L2ToolManifest>>()

  for (const t of toolIndex) {
    if (t.l2ManifestId) {
      l2ManifestMap.set(t.fullName, {})
    }
  }

  let vectorScores: { item: MatchableItem; score: number }[] = []
  if (filteredIndex.length > 0) {
    const queryVec = await genVec(userInput)
    vectorScores = filteredIndex.map((entry, i) => {
      const rawScore = cosineSimilarity(queryVec, entry.vector)
      return { item: items[i], score: rawScore }
    })
    vectorScores.sort((a, b) => b.score - a.score)
  }

  const kwScores = items.map(item => ({
    item,
    score: isNegated
      ? keywordMatchScoreGeneric(userInput, item.keywords, item.userSummary) * 0.3
      : keywordMatchScoreGeneric(userInput, item.keywords, item.userSummary)
  }))
  kwScores.sort((a, b) => b.score - a.score)

  debugLog(`[Universal] 输入: "${userInput.substring(0, 60)}"`)
  debugLog(`[Universal] 向量Top3:`, vectorScores.slice(0, 3).map(v => `${v.item.name}=${v.score.toFixed(4)}`))
  debugLog(`[Universal] 关键词Top3:`, kwScores.slice(0, 3).map(k => `${k.item.name}=${k.score.toFixed(4)}`))
  if (isNegated) debugLog(`[Universal] 检测到否定词，关键词分数降权至0.3x`)

  try {
    const { useFeedbackStore } = await import('@/stores/feedbackStore')
    const feedbackStore = useFeedbackStore()
    for (const s of kwScores) {
      const mod = feedbackStore.getWeightModifier(s.item.id)
      if (mod !== 0) s.score = Math.max(0, Math.min(1, s.score + mod * 0.5))
    }
    for (const s of vectorScores) {
      const mod = feedbackStore.getWeightModifier(s.item.id)
      if (mod !== 0) s.score = Math.max(0, Math.min(1, s.score + mod * 0.5))
    }
    kwScores.sort((a, b) => b.score - a.score)
    vectorScores.sort((a, b) => b.score - a.score)
  } catch (e) {
    console.warn('[Universal] feedbackStore加载失败，使用原始分数:', e instanceof Error ? e.message : String(e))
  }

  for (const s of kwScores) {
    const fileBoost = getFileBoostForItem(s.item.keywords, s.item.description)
    if (fileBoost > 0) s.score = Math.min(1, s.score + fileBoost)
  }
  for (const s of vectorScores) {
    const fileBoost = getFileBoostForItem(s.item.keywords, s.item.description)
    if (fileBoost > 0) s.score = Math.min(1, s.score + fileBoost)
  }
  kwScores.sort((a, b) => b.score - a.score)
  vectorScores.sort((a, b) => b.score - a.score)

  if (filterOptions?.selectedRole) {
    const { useNodeStore } = await import('@/stores/nodeStore')
    try {
      const ns = useNodeStore()
      for (const s of kwScores) {
        const manifest = ns.getL2Manifest(s.item.id)
        if (manifest?.routing.targetRoles?.includes(filterOptions.selectedRole!)) {
          s.score = Math.min(1, s.score * 1.3)
        }
      }
      for (const s of vectorScores) {
        const manifest = ns.getL2Manifest(s.item.id)
        if (manifest?.routing.targetRoles?.includes(filterOptions.selectedRole!)) {
          s.score = Math.min(1, s.score * 1.3)
        }
      }
      kwScores.sort((a, b) => b.score - a.score)
      vectorScores.sort((a, b) => b.score - a.score)
    } catch { /* non-critical */ }
  }

  const rrfResults = computeRRFGeneric(vectorScores, kwScores)
  const candidates = buildCandidatesFromRRFGeneric(rrfResults, vectorScores, kwScores)

  if (rrfResults.length === 0) {
    debugLog(`[Universal] 无匹配`)
    return null
  }

  const top1 = rrfResults[0]
  const top2 = rrfResults.length > 1 ? rrfResults[1] : null
  const margin = top2 ? top1.rrfScore - top2.rrfScore : 1.0

  const top1VecScore = vectorScores.find(v => v.item.id === top1.item.id)?.score || 0
  const top1KwScore = kwScores.find(k => k.item.id === top1.item.id)?.score || 0

  const dynKwHigh = computeDynamicThreshold(0.6, 0.6, 'keyword')
  const dynVecHigh = computeDynamicThreshold(0.85, 0.90, 'vector')
  const dynGreenGate = computeDynamicThreshold(GATE_GREEN_THRESHOLD, GATE_GREEN_THRESHOLD, 'keyword')

  const hasStrongSignal = top1KwScore >= dynKwHigh || top1VecScore >= dynVecHigh
  const hasModerateSignal = top1KwScore >= 0.3 || top1VecScore >= VECTOR_AMBIGUOUS_LOW

  if (hasStrongSignal && margin >= MARGIN_THRESHOLD) {
    recordScore(top1KwScore, 'keyword')
    recordScore(top1VecScore, 'vector')
    const gate = (top1KwScore >= dynGreenGate || top1VecScore >= dynGreenGate) ? 'green' : 'yellow'
    const isAmbiguous = gate === 'yellow'
    debugLog(`[Universal] RRF融合命中: ${top1.item.name} (rrf=${top1.rrfScore.toFixed(4)}, kw=${top1KwScore.toFixed(4)}, vec=${top1VecScore.toFixed(4)}, margin=${margin.toFixed(4)}, gate=${gate})`)
    const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous, candidates, gate }
    storeRouteCache(userInput, idxHash, result)
    return result
  }

  if (hasStrongSignal && margin < MARGIN_THRESHOLD) {
    recordScore(top1KwScore, 'keyword')
    recordScore(top1VecScore, 'vector')
    debugLog(`[Universal] RRF高置信但margin小(margin=${margin.toFixed(4)})，判定模糊: ${top1.item.name}`)
    const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous: true, candidates, gate: 'yellow' }
    storeRouteCache(userInput, idxHash, result)
    return result
  }

  if (hasModerateSignal) {
    recordScore(top1KwScore, 'keyword')
    recordScore(top1VecScore, 'vector')
    if (margin >= MARGIN_THRESHOLD) {
      debugLog(`[Universal] RRF中等置信唯一(margin=${margin.toFixed(4)}): ${top1.item.name}`)
      const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous: true, candidates, gate: 'yellow' }
      storeRouteCache(userInput, idxHash, result)
      return result
    }
    debugLog(`[Universal] RRF中等置信且margin小，拒绝强行指派: ${top1.item.name}`)
    return null
  }

  debugLog(`[Universal] 无匹配`)
  return null
}

export async function raapMatch(
  userInput: string,
  manifests: L2ToolManifest[],
  toolIndex?: ToolIndex[]
): Promise<RaapMatchResult | null> {
  if (manifests.length === 0 && (!toolIndex || toolIndex.length === 0)) return null

  const index = toolIndex || []
  if (index.length === 0 && manifests.length > 0) {
    debugLog(`[RaaP] 无toolIndex，仅L2清单，走旧逻辑`)
    const isNegated = hasNegation(userInput)
    const kwScores = manifests.map(m => ({
      manifest: m,
      score: isNegated ? keywordMatchScore(userInput, m) * 0.3 : keywordMatchScore(userInput, m)
    })).sort((a, b) => b.score - a.score)
    if (kwScores.length === 0 || kwScores[0].score < 0.1) return null
    const top = kwScores[0]
    const gate = top.score >= 0.6 ? 'green' : 'yellow'
    return {
      manifest: top.manifest,
      confidence: top.score,
      matchMethod: 'keyword',
      isAmbiguous: gate === 'yellow',
      candidates: kwScores.slice(0, 5).map(s => ({ manifest: s.manifest, score: s.score, method: 'keyword' })),
      gate
    }
  }

  const result = await universalMatch(userInput, index)
  if (!result) return null

  if (result.item.source === 'l2' && result.item.manifest) {
    return {
      manifest: result.item.manifest,
      confidence: result.confidence,
      matchMethod: result.matchMethod === 'keyword+vector' ? 'model' : result.matchMethod,
      isAmbiguous: result.isAmbiguous,
      candidates: result.candidates?.filter(c => c.item.source === 'l2' && c.item.manifest).map(c => ({
        manifest: c.item.manifest!,
        score: c.score,
        method: c.method
      })),
      gate: result.gate
    }
  }

  debugLog(`[RaaP] universalMatch命中MCP工具: ${result.item.name}，raapMatch返回null（非L2）`)
  return null
}

export function getTop3Candidates(
  userInput: string,
  manifests: L2ToolManifest[],
  toolIndex?: ToolIndex[]
): { manifest: L2ToolManifest; score: number; method: string }[] {
  const isNegated = hasNegation(userInput)
  const kwScores = manifests.map(m => ({
    manifest: m,
    score: isNegated ? keywordMatchScore(userInput, m) * 0.3 : keywordMatchScore(userInput, m)
  })).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  let vectorScores: { manifest: L2ToolManifest; score: number }[] = []
  if (toolIndex && toolIndex.length > 0) {
    const l2Entries = toolIndex.filter(t => t.l2ManifestId)
    for (const entry of l2Entries) {
      const m = manifests.find(mf => mf.identity.id === entry.l2ManifestId)
      if (m) vectorScores.push({ manifest: m, score: 0.5 })
    }
  }

  const rrfResults = computeRRFGeneric(
    vectorScores.map(v => ({ item: manifestToItem(v.manifest), score: v.score })),
    kwScores.map(k => ({ item: manifestToItem(k.manifest), score: k.score }))
  )
  return rrfResults.slice(0, 3).map(r => {
    const m = r.item.manifest
    if (!m) return null
    const vecS = vectorScores.find(v => v.manifest.identity.id === m.identity.id)?.score || 0
    const kwS = kwScores.find(k => k.manifest.identity.id === m.identity.id)?.score || 0
    return { manifest: m, score: Math.max(vecS, kwS) || r.rrfScore, method: r.method }
  }).filter((r): r is { manifest: L2ToolManifest; score: number; method: string } => r !== null)
}

export async function rewriteQuery(
  userInput: string,
  chatCompletionFn: (messages: { role: string; content: string }[]) => Promise<{ content: string }>
): Promise<string> {
  if (userInput.length <= 4) return userInput
  if (/[a-zA-Z_]{3,}/.test(userInput) && userInput.length < 20) return userInput
  if (!isOnline()) {
    debugLog('[rewriteQuery] 离线模式，跳过查询改写')
    return userInput
  }

  const prompt = `将以下用户输入改写为简洁的工具检索查询语句，保留核心意图，去除口语化表达。只输出改写结果，不要解释。

用户输入: "${userInput}"
改写结果:`

  try {
    const resp = await chatCompletionFn([
      { role: 'system', content: '你是一个查询改写助手，将用户口语化输入转化为简洁的检索语句。只输出改写结果。' },
      { role: 'user', content: prompt }
    ])
    const rewritten = resp.content.trim()
    if (rewritten.length >= 2 && rewritten.length <= 100 && !rewritten.includes('\n')) {
      debugLog(`[rewriteQuery] "${userInput}" → "${rewritten}"`)
      return rewritten
    }
    debugLog(`[rewriteQuery] 改写结果无效，使用原始输入: "${rewritten.substring(0, 60)}"`)
    return userInput
  } catch (e) {
    console.warn('[rewriteQuery] LLM调用失败:', e instanceof Error ? e.message : String(e))
    return userInput
  }
}

export async function llmFallback(
  userInput: string,
  candidates: { item: MatchableItem; score: number; method: string }[],
  chatCompletionFn: (messages: { role: string; content: string }[]) => Promise<{ content: string }>
): Promise<MatchableItem | null> {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0].item

  if (!isOnline()) {
    debugLog('[llmFallback] 离线模式，走规则引擎降级')
    return ruleEngineFallback(userInput, candidates)
  }

  const candidateLines = candidates.slice(0, 5).map((c, i) =>
    `${i + 1}. ${c.item.name}（${c.item.description.substring(0, 80)}）`
  ).join('\n')

  const prompt = `用户输入: "${userInput}"

候选工具:
${candidateLines}

请只返回最匹配的那个工具的编号（1-${Math.min(candidates.length, 5)}），不要返回其他内容。`

  try {
    const resp = await chatCompletionFn([
      { role: 'system', content: '你是一个工具选择助手，根据用户输入从候选工具中选出最匹配的一个。只返回编号。' },
      { role: 'user', content: prompt }
    ])
    const text = resp.content.trim()
    const numMatch = text.match(/(\d+)/)
    if (numMatch) {
      const idx = parseInt(numMatch[1]) - 1
      if (idx >= 0 && idx < Math.min(candidates.length, 5)) {
        debugLog(`[llmFallback] LLM选择: #${idx + 1} ${candidates[idx].item.name}`)
        return candidates[idx].item
      }
    }
    debugLog(`[llmFallback] LLM返回无法解析: "${text}"`)
    return null
  } catch (e) {
    console.warn('[llmFallback] LLM调用失败:', e instanceof Error ? e.message : String(e))
    return null
  }
}

export function getTop3CandidatesUniversal(
  userInput: string,
  toolIndex: ToolIndex[]
): { item: MatchableItem; score: number; method: string }[] {
  const isNegated = hasNegation(userInput)
  const items = toolIndex.map(t =>
    t.l2ManifestId ? manifestToItem({ identity: { id: t.l2ManifestId, name: t.shortName, version: '', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' }, visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' }, routing: { keywords: extractKeywordsFromDescription(t.shortName, t.description), targetRoles: [], requiredL1: [], inputType: 'text', retrievalSummary: t.description, userSummary: t.description, confidenceThreshold: 0.5 }, execution: { mode: 'macro', paramMapping: { slots: [] }, dagPlan: { steps: [] } }, cacheMeta: { cacheKeyTemplate: '', cacheTTL: 0, estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false } } as L2ToolManifest) : toolIndexToItem(t)
  )
  const kwScores = items.map(item => ({
    item,
    score: isNegated
      ? keywordMatchScoreGeneric(userInput, item.keywords, item.userSummary) * 0.3
      : keywordMatchScoreGeneric(userInput, item.keywords, item.userSummary)
  })).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  const rrfResults = computeRRFGeneric([], kwScores)
  return rrfResults.slice(0, 3).map(r => ({ item: r.item, score: r.rrfScore, method: r.method }))
}
