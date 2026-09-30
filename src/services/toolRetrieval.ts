import { generateVector as genVec, cosineSimilarity } from './embedder'
import { L2ToolManifest } from '@/models'
import { getFileBoostForItem } from './fileContext'
import { debugLog } from '@/services/debugLog'
import { contentHash } from './hash'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'
import { classifyTemplateInput, detectInputForm, extractInstructionSegment, type InputFormInfo } from './inputForm'

const STOP_WORDS_SET = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '或', '帮', '给', '让', '把', '被', '从', '到', '用', '对', '为', '以', '及', '等', '着', '过', '一下', '一下下', '一个', '一些', '请', '要', '会', '能', '可以', '帮我', '帮我看看', '搞', '搞一下', '做', '做一下', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'this', 'that', 'me', 'my', 'your'])




export interface ToolIndex {
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

// 路由缓存查找（内存）
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

// 路由缓存写入（内存）
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

  const scopedInput = extractInstructionSegment(userInput)
  const inputSegs = segmentChinese(scopedInput)
  const inputLower = scopedInput.toLowerCase()

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
    const raw = vault.readCache('tool', TOOL_INDEX_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveToolIndex(index: ToolIndex[]): void {
  try {
    vault.writeThrough('tool', TOOL_INDEX_KEY, JSON.stringify(index))
  } catch {
    debugLog('[RaaP] vault写入失败，索引仅存于内存')
  }
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
  // B：关键词只匹配指令段，附着材料（长文档/邮件正文）里的通用词不得淹没指令
  const scopedInput = extractInstructionSegment(userInput)
  const inputLower = scopedInput.toLowerCase()
  const inputSegs = segmentChinese(scopedInput)
  const inputNgrams = generateNGrams(scopedInput, 2, 4)
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

  // 2026-09-30：分母由「表长」改为 min(表长, 3) —— 与 L1 的 conf 公式同款修法（同一系统性缺陷的第 3 处）。
  // 原式让**表越长越难命中**：6 词表命中 1 个 = 0.1667、11 词表 = 0.0909，**全部低于门控的
  // 「中信号」线 0.3**（见下方 hasModerateSignal），于是关键词侧**完全不产生信号**、L2 实际只靠向量。
  // 实测日志（2026-09-30）：`[Universal] 关键词Top3: 文档转 PDF=0.1667 合同风险审查=0.1667`，
  // 而正确答案的向量分高达 0.58 仍被 `中等置信且margin小` 拒绝指派。
  // 以 3 词为满分基准后：单命中 0.333（过中信号）、双命中 0.667（过强信号 0.6）；
  // 3 词及以下的表行为完全不变（分母仍是自身）。上界 clamp 到 1（原式天然 ≤1，改后需显式约束）。
  const denom = Math.min(keywords.length, 3)
  let score = keywords.length > 0 ? Math.min(hits / denom, 1) : 0
  const createWords = ['创建', '新建', '写', '生成', '保存']
  const docWords = ['文档', '文件', 'docx', 'word', 'txt', 'pdf']
  const hasCreate = createWords.some(w => inputSegs.includes(w) || inputLower.includes(w))
  const hasDoc = docWords.some(w => inputSegs.includes(w) || inputLower.includes(w))
  if (hasCreate && hasDoc && userSummary.includes('创建文件')) {
    score = Math.min(1, score + 0.3)
  }
  return score
}

/** P1-D5：L2 清单禁词门——指令段命中任一 forbiddenKeywords → 该清单不得路由（B：只看指令段） */
export function manifestForbidsInput(userInput: string, manifest: L2ToolManifest): boolean {
  const forbidden = manifest.routing.forbiddenKeywords
  if (!forbidden || forbidden.length === 0) return false
  const inputLower = extractInstructionSegment(userInput).toLowerCase()
  return forbidden.some(kw => inputLower.includes(kw.toLowerCase()))
}

export function keywordMatchScore(userInput: string, manifest: L2ToolManifest): number {
  // P1-D5：禁词否决——输入含清单禁词（列查/转换类）则不得路由到该清单
  if (manifestForbidsInput(userInput, manifest)) return 0
  return keywordMatchScoreGeneric(userInput, manifest.routing.keywords, manifest.routing.userSummary || '')
}

/**
 * Q14 修复：L2 清单关键词打分须经过禁词门——此前 universalMatch / getTop3CandidatesUniversal
 * 直接调 keywordMatchScoreGeneric，绕过 manifest.routing.forbiddenKeywords，导致「帮我列出 .docx 清单」
 * 这类输入仍被当作候选交给 LLM 仲裁、选中「文件创建器」并创建垃圾文件（假完成）。
 * MCP 工具无 manifest，走通用打分不变。
 */
function scoreItemKeywords(userInput: string, item: MatchableItem): number {
  if (item.source === 'l2' && item.manifest) return keywordMatchScore(userInput, item.manifest)
  return keywordMatchScoreGeneric(userInput, item.keywords, item.userSummary)
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
const SCORE_HISTORY_KEY = 'raap-score-history'
let _scoreWriteTick = 0

// 2026-09-30：分数池持久化（原为纯内存 ⇒ 每次重启清零、pool.length<10 一律回落 fallback
// 阈值，动态阈值在冷启动期从不生效；与 G-13「指纹缓存重启即失忆」同型）。
// 只存分数数值，恢复时补上 timestamp/type——ScoreRecord 的时间戳不参与阈值计算。
function loadScoreHistory(): void {
  try {
    const raw = vault.readCache('tool', SCORE_HISTORY_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { keyword?: unknown; vector?: unknown }
    const take = (v: unknown): number[] =>
      Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-SCORE_HISTORY_MAX) : []
    const now = Date.now()
    for (const s of take(parsed?.keyword)) _kwScoreHistory.push({ score: s, timestamp: now, type: 'keyword' })
    for (const s of take(parsed?.vector)) _vecScoreHistory.push({ score: s, timestamp: now, type: 'vector' })
  } catch {
    // 坏数据/无权限一律不阻塞启动——退化为"无历史"，即旧行为
  }
}

function saveScoreHistory(): void {
  try {
    vault.writeThrough('tool', SCORE_HISTORY_KEY, JSON.stringify({
      keyword: _kwScoreHistory.map(r => r.score),
      vector: _vecScoreHistory.map(r => r.score)
    }))
  } catch {
    debugLog('[RaaP] 分数池持久化失败，仅存于内存')
  }
}

function recordScoreImpl(score: number, type: 'keyword' | 'vector'): void {
  const pool = type === 'keyword' ? _kwScoreHistory : _vecScoreHistory
  pool.push({ score, timestamp: Date.now(), type })
  if (pool.length > SCORE_HISTORY_MAX) pool.shift()
  // 节流：每 10 次记录落一次盘（每次匹配都写会过于频繁）
  if (++_scoreWriteTick >= 10) {
    _scoreWriteTick = 0
    saveScoreHistory()
  }
}

// 启动时恢复（模块加载即执行；失败退化为无历史）
loadScoreHistory()

// 2026-09-30：导出以便单测（池是模块级状态，无法从外部观察）。
// 测试用重置函数参照 writeGate.resetWriteGrantCache 的先例；**只清内存**，不动持久化。
export const recordScore = recordScoreImpl
export function __resetScoreHistoryForTest(): void {
  _kwScoreHistory.length = 0
  _vecScoreHistory.length = 0
  _scoreWriteTick = 0
}

export function computeDynamicThreshold(baseThreshold: number, fallback: number, type: 'keyword' | 'vector'): number {
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

// P1-16：L2 索引条目 → manifest。优先按 id 经总线回查 nodeStore 真实清单，
// 保证确认链路（计划展示/槽位填充）与执行链路消费同一份 dagPlan/paramMapping；
// 回查失败（handler 未注册/清单已删除）才退回最小桩（仅够相似度排序用）。
function buildStubL2Manifest(l2ManifestId: string, shortName: string, description: string): L2ToolManifest {
  return { identity: { id: l2ManifestId, name: shortName, version: '', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' }, visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' }, routing: { keywords: extractKeywordsFromDescription(shortName, description), targetRoles: [], requiredL1: [], inputType: 'text', retrievalSummary: description, userSummary: description, confidenceThreshold: 0.5 }, execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 2 } }, cacheMeta: { cacheKeyTemplate: '', cacheTTL: 0, estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false } } as L2ToolManifest
}

function resolveL2Manifest(entry: ToolIndex): L2ToolManifest {
  if (!entry.l2ManifestId) return buildStubL2Manifest(entry.shortName, entry.shortName, entry.description)
  try {
    const real = globalBus.request<L2ToolManifest | null>('node:get-l2-manifest', { id: entry.l2ManifestId })
    if (real && real.execution?.dagPlan) return real
  } catch { /* handler 未注册（如单测环境）或清单缺失，退回桩 */ }
  return buildStubL2Manifest(entry.l2ManifestId, entry.shortName, entry.description)
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
      ? manifestToItem(resolveL2Manifest(t))
      : toolIndexToItem(t)
  )

  let vectorScores: { item: MatchableItem; score: number }[] = []
  if (filteredIndex.length > 0) {
    const queryVec = await genVec(userInput)
    vectorScores = filteredIndex.map((entry, i) => {
      const rawScore = cosineSimilarity(queryVec, entry.vector)
      return { item: items[i], score: rawScore }
    })
    vectorScores.sort((a, b) => b.score - a.score)
  }

  const kwScores = items.map(item => {
    const raw = scoreItemKeywords(userInput, item)
    return { item, score: isNegated ? raw * 0.3 : raw }
  })
  kwScores.sort((a, b) => b.score - a.score)

  debugLog(`[Universal] 输入: "${userInput.substring(0, 60)}"`)
  debugLog(`[Universal] 向量Top3:`, vectorScores.slice(0, 3).map(v => `${v.item.name}=${v.score.toFixed(4)}`))
  debugLog(`[Universal] 关键词Top3:`, kwScores.slice(0, 3).map(k => `${k.item.name}=${k.score.toFixed(4)}`))
  if (isNegated) debugLog(`[Universal] 检测到否定词，关键词分数降权至0.3x`)

  try {
    for (const s of kwScores) {
      const mod = globalBus.request<number>('feedback:get-weight', { id: s.item.id })
      if (mod !== 0) s.score = Math.max(0, Math.min(1, s.score + mod * 0.5))
    }
    for (const s of vectorScores) {
      const mod = globalBus.request<number>('feedback:get-weight', { id: s.item.id })
      if (mod !== 0) s.score = Math.max(0, Math.min(1, s.score + mod * 0.5))
    }
    kwScores.sort((a, b) => b.score - a.score)
    vectorScores.sort((a, b) => b.score - a.score)
  } catch (e) {
    debugLog('[Universal] feedback加载失败，使用原始分数:', e instanceof Error ? e.message : String(e))
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
    try {
      for (const s of kwScores) {
        const roles = globalBus.request<string[]>('node:get-roles', { id: s.item.id })
        if (roles?.includes(filterOptions.selectedRole!)) {
          s.score = Math.min(1, s.score * 1.3)
        }
      }
      for (const s of vectorScores) {
        const roles = globalBus.request<string[]>('node:get-roles', { id: s.item.id })
        if (roles?.includes(filterOptions.selectedRole!)) {
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

  // 2026-09-30：分数池的采样点从「命中分支」提前到「决策之前」。
  // 原实现只在 hit 分支 recordScore —— 池里只进"通过的"高分（**幸存者偏差**），
  // computeDynamicThreshold 的 p50/p95 因此偏高，动态阈值**越用越严**（正反馈）。
  // 改在决策前统一记录 top1 的两个分数，池才代表真实分布。
  // （另注：该池是模块级内存数组、无持久化 ⇒ 每次重启回落到 fallback 阈值，
  //   与 G-13「指纹缓存重启即失忆」同型；本轮不改，记在案。）
  recordScore(top1KwScore, 'keyword')
  recordScore(top1VecScore, 'vector')

  if (hasStrongSignal && margin >= MARGIN_THRESHOLD) {
    const gate: 'green' | 'yellow' = (top1KwScore >= dynGreenGate || top1VecScore >= dynGreenGate) ? 'green' : 'yellow'
    const isAmbiguous = gate === 'yellow'
    debugLog(`[Universal] RRF融合命中: ${top1.item.name} (rrf=${top1.rrfScore.toFixed(4)}, kw=${top1KwScore.toFixed(4)}, vec=${top1VecScore.toFixed(4)}, margin=${margin.toFixed(4)}, gate=${gate})`)
    const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous, candidates, gate }
    storeRouteCache(userInput, idxHash, result)
    return result
  }

  if (hasStrongSignal && margin < MARGIN_THRESHOLD) {
    debugLog(`[Universal] RRF高置信但margin小(margin=${margin.toFixed(4)})，判定模糊: ${top1.item.name}`)
    const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous: true, candidates, gate: 'yellow' as const }
    storeRouteCache(userInput, idxHash, result)
    return result
  }

  if (hasModerateSignal) {
    if (margin >= MARGIN_THRESHOLD) {
      debugLog(`[Universal] RRF中等置信唯一(margin=${margin.toFixed(4)}): ${top1.item.name}`)
      const result = { item: top1.item, confidence: Math.max(top1KwScore, top1VecScore), matchMethod: top1.method as 'vector' | 'keyword' | 'keyword+vector', isAmbiguous: true, candidates, gate: 'yellow' as const }
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

/** P0-A：输入形态的 LLM 披露文案 */
function describeInputForm(info: InputFormInfo): string {
  const parts: string[] = []
  parts.push(`文件路径: ${info.hasFilePath ? '有' : '无'}`)
  parts.push(`附件内容: ${info.hasAttachment ? '有' : '无'}`)
  parts.push(`内联材料: ${info.hasInlineMaterial ? `有（约${info.inlineMaterial.length}字）` : '无'}`)
  return parts.join('，')
}

function describeCandidateInputType(item: MatchableItem): string {
  const t = item.manifest?.routing.inputType
  if (t === 'file') return '需要文件输入'
  if (t === 'file_or_text') return '文件或文本输入'
  if (t === 'text') return '文本输入'
  return '输入形态未知'
}

export async function llmFallback(
  userInput: string,
  candidates: { item: MatchableItem; score: number; method: string }[],
  chatCompletionFn: (messages: { role: string; content: string }[]) => Promise<{ content: string }>
): Promise<MatchableItem | null> {
  if (candidates.length === 0) return null

  // P0-A：调用前确定性过滤——file 模板且输入无文件形态的候选直接剔除（省 LLM 调用）
  const formInfo = detectInputForm(userInput)
  const filtered = candidates.filter(c => {
    if (c.item.source !== 'l2' || !c.item.manifest) return true
    // P0-A：file 模板且输入无文件形态 → 剔除
    if (classifyTemplateInput(c.item.manifest, formInfo) === 'reject') return false
    // Q14：清单自身禁词命中（如「列清单」对创建器）→ 剔除，不交给 LLM 仲裁
    if (manifestForbidsInput(userInput, c.item.manifest)) return false
    return true
  })
  if (filtered.length === 0) {
    debugLog('[llmFallback] 输入门控过滤后无候选，跳过LLM仲裁')
    return null
  }
  if (filtered.length === 1) return filtered[0].item

  candidates = filtered

  if (!isOnline()) {
    debugLog('[llmFallback] 离线模式，走规则引擎降级')
    return ruleEngineFallback(userInput, candidates)
  }

  const candidateLines = candidates.slice(0, 5).map((c, i) =>
    `${i + 1}. ${c.item.name}（${describeCandidateInputType(c.item)}；${c.item.description.substring(0, 80)}）`
  ).join('\n')

  const prompt = `用户输入: "${userInput}"

用户输入形态：${describeInputForm(formInfo)}

候选工具:
${candidateLines}

若所有候选工具与用户输入形态都不匹配（例如工具需要文件但用户没有提供任何文件），返回 0 表示无匹配。
请只返回最匹配的那个工具的编号（0-${Math.min(candidates.length, 5)}），不要返回其他内容。`

  try {
    const resp = await chatCompletionFn([
      { role: 'system', content: '你是一个工具选择助手，根据用户输入和输入形态从候选工具中选出最匹配的一个。只返回编号，无匹配返回 0。' },
      { role: 'user', content: prompt }
    ])
    const text = resp.content.trim()
    const numMatch = text.match(/(\d+)/)
    if (numMatch) {
      const num = parseInt(numMatch[1])
      if (num === 0) {
        debugLog('[llmFallback] LLM判定无匹配')
        return null
      }
      const idx = num - 1
      if (idx >= 0 && idx < Math.min(candidates.length, 5)) {
        debugLog(`[llmFallback] LLM选择: #${idx + 1} ${candidates[idx].item.name}`)
        return candidates[idx].item
      }
    }
    debugLog(`[llmFallback] LLM返回无法解析: "${text}"`)
    return null
  } catch (e) {
    debugLog('[llmFallback] LLM调用失败:', e instanceof Error ? e.message : String(e))
    return null
  }
}

export function getTop3CandidatesUniversal(
  userInput: string,
  toolIndex: ToolIndex[]
): { item: MatchableItem; score: number; method: string }[] {
  const isNegated = hasNegation(userInput)
  const items = toolIndex.map(t =>
    t.l2ManifestId ? manifestToItem(resolveL2Manifest(t)) : toolIndexToItem(t)
  )
  const kwScores = items.map(item => {
    const raw = scoreItemKeywords(userInput, item)
    return { item, score: isNegated ? raw * 0.3 : raw }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score)

  const rrfResults = computeRRFGeneric([], kwScores)
  return rrfResults.slice(0, 3).map(r => ({ item: r.item, score: r.rrfScore, method: r.method }))
}
