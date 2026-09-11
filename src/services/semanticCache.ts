import { ModelTier } from '@/models'
import { generateVector, cosineSimilarity, needsReembedding } from '@/services/embedder'
import { calculateCost } from '@/services/tokenPricing'
import { debugLog } from '@/services/debugLog'
import { vault } from '@/vault'

export interface SemanticCacheEntry {
  id: string
  queryHash: string
  queryEmbedding: number[]
  queryText: string
  responseText: string
  tier: ModelTier
  tokenUsage: { promptTokens: number; completionTokens: number }
  savedAt: number
  lastAccessedAt: number
  hitCount: number
  domain: string
  constraintIds: string[]
  ttl: number
}

export interface SemanticCacheConfig {
  similarityThreshold: number
  maxEntries: number
  defaultTTL: number
  enabled: boolean
}

export interface SemanticCacheHit {
  hit: boolean
  entry: SemanticCacheEntry | null
  similarity: number
  savedTokens: number
  savedCost: number
}

export interface CacheSavings {
  semanticCacheHits: number
  semanticCacheSavedTokens: number
  semanticCacheSavedCost: number
  semanticCacheMisses: number
  totalLookups: number
  hitRate: number
}

const DEFAULT_CONFIG: SemanticCacheConfig = {
  similarityThreshold: 0.92,
  maxEntries: 500,
  defaultTTL: 24 * 60 * 60 * 1000,
  enabled: true
}

interface AdaptiveThresholdState {
  current: number
  min: number
  max: number
  targetHitRate: number
  windowSize: number
  recentResults: boolean[]
  lookupsSinceAdjust: number
  adjustInterval: number
}

const DEFAULT_ADAPTIVE: AdaptiveThresholdState = {
  current: 0.92,
  min: 0.80,
  max: 0.95,
  targetHitRate: 0.3,
  windowSize: 50,
  recentResults: [],
  lookupsSinceAdjust: 0,
  adjustInterval: 20
}

let config: SemanticCacheConfig = { ...DEFAULT_CONFIG }
let adaptive: AdaptiveThresholdState = { ...DEFAULT_ADAPTIVE }
let exactMap: Map<string, SemanticCacheEntry> = new Map()
let semanticArray: SemanticCacheEntry[] = []
let totalHits = 0
let totalMisses = 0
let totalSavedTokens = 0
let totalSavedCost = 0

interface LRUNode {
  key: string
  entry: SemanticCacheEntry
  prev: LRUNode | null
  next: LRUNode | null
}

let lruHead: LRUNode | null = null
let lruTail: LRUNode | null = null
let lruMap: Map<string, LRUNode> = new Map()

function lruTouch(node: LRUNode): void {
  if (node === lruHead) return
  if (node.prev) node.prev.next = node.next
  if (node.next) node.next.prev = node.prev
  if (node === lruTail && node.prev) lruTail = node.prev
  node.prev = null
  node.next = lruHead
  if (lruHead) lruHead.prev = node
  lruHead = node
  if (!lruTail) lruTail = node
}

function lruAdd(entry: SemanticCacheEntry): void {
  const node: LRUNode = { key: entry.id, entry, prev: null, next: lruHead }
  if (lruHead) lruHead.prev = node
  lruHead = node
  if (!lruTail) lruTail = node
  lruMap.set(entry.id, node)
}

function lruRemove(node: LRUNode): void {
  if (node.prev) node.prev.next = node.next
  if (node.next) node.next.prev = node.prev
  if (node === lruHead) lruHead = node.next
  if (node === lruTail) lruTail = node.prev
  lruMap.delete(node.key)
}

function lruEvictOne(): SemanticCacheEntry | null {
  if (!lruTail) return null
  const entry = lruTail.entry
  lruRemove(lruTail)
  return entry
}

function textHash(text: string): string {
  const normalized = text.trim().toLowerCase()
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 16), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 16), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function isExpired(entry: SemanticCacheEntry): boolean {
  return Date.now() - entry.savedAt > entry.ttl
}

function domainMatch(entry: SemanticCacheEntry, domain?: string): boolean {
  if (!domain) return true
  if (!entry.domain) return true
  return entry.domain === domain
}

function adjustThreshold(): void {
  adaptive.lookupsSinceAdjust++
  if (adaptive.lookupsSinceAdjust < adaptive.adjustInterval) return
  adaptive.lookupsSinceAdjust = 0

  if (adaptive.recentResults.length < 5) return
  const hitRate = adaptive.recentResults.filter(r => r).length / adaptive.recentResults.length

  if (hitRate < adaptive.targetHitRate - 0.1) {
    adaptive.current = Math.max(adaptive.min, adaptive.current - 0.01)
  } else if (hitRate > adaptive.targetHitRate + 0.2) {
    adaptive.current = Math.min(adaptive.max, adaptive.current + 0.005)
  }
}

function recordLookupResult(isHit: boolean): void {
  adaptive.recentResults.push(isHit)
  if (adaptive.recentResults.length > adaptive.windowSize) {
    adaptive.recentResults.shift()
  }
  adjustThreshold()
}

export async function lookup(
  queryText: string,
  domain?: string
): Promise<SemanticCacheHit> {
  if (!config.enabled) {
    recordLookupResult(false)
    return { hit: false, entry: null, similarity: 0, savedTokens: 0, savedCost: 0 }
  }

  const hash = textHash(queryText)

  const exact = exactMap.get(hash)
  if (exact && !isExpired(exact) && domainMatch(exact, domain)) {
    totalHits++
    exact.hitCount++
    exact.lastAccessedAt = Date.now()
    const lruNode = lruMap.get(exact.id)
    if (lruNode) lruTouch(lruNode)
    const costResult = calculateCost(exact.tokenUsage.promptTokens, exact.tokenUsage.completionTokens, exact.tokenUsage.completionTokens)
    totalSavedTokens += exact.tokenUsage.completionTokens
    totalSavedCost += costResult.totalCost
    debugLog(`[SemanticCache] HIT (exact): similarity=1.0000, savedTokens=${exact.tokenUsage.completionTokens}`)
    recordLookupResult(true)
    return {
      hit: true,
      entry: exact,
      similarity: 1.0,
      savedTokens: exact.tokenUsage.completionTokens,
      savedCost: costResult.totalCost
    }
  }

  const embedding = await generateVector(queryText)
  let bestEntry: SemanticCacheEntry | null = null
  let bestSimilarity = 0

  for (const entry of semanticArray) {
    if (isExpired(entry)) continue
    if (!domainMatch(entry, domain)) continue
    const sim = cosineSimilarity(embedding, entry.queryEmbedding)
    if (sim > bestSimilarity && sim >= adaptive.current) {
      bestSimilarity = sim
      bestEntry = entry
    }
  }

  if (bestEntry) {
    totalHits++
    bestEntry.hitCount++
    bestEntry.lastAccessedAt = Date.now()
    const lruNode = lruMap.get(bestEntry.id)
    if (lruNode) lruTouch(lruNode)
    const costResult = calculateCost(bestEntry.tokenUsage.promptTokens, bestEntry.tokenUsage.completionTokens, bestEntry.tokenUsage.completionTokens)
    totalSavedTokens += bestEntry.tokenUsage.completionTokens
    totalSavedCost += costResult.totalCost
    debugLog(`[SemanticCache] HIT: similarity=${bestSimilarity.toFixed(4)}, savedTokens=${bestEntry.tokenUsage.completionTokens}`)
    recordLookupResult(true)
    return {
      hit: true,
      entry: bestEntry,
      similarity: bestSimilarity,
      savedTokens: bestEntry.tokenUsage.completionTokens,
      savedCost: costResult.totalCost
    }
  }

  totalMisses++
  recordLookupResult(false)
  return { hit: false, entry: null, similarity: bestSimilarity, savedTokens: 0, savedCost: 0 }
}

export async function store(entry: {
  queryText: string
  responseText: string
  tier: ModelTier
  promptTokens: number
  completionTokens: number
  domain?: string
  constraintIds?: string[]
  ttl?: number
}): Promise<SemanticCacheEntry> {
  const hash = textHash(entry.queryText)
  const existing = exactMap.get(hash)
  if (existing && !isExpired(existing)) {
    return existing
  }

  const embedding = await generateVector(entry.queryText)
  const cacheEntry: SemanticCacheEntry = {
    id: `sc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    queryHash: hash,
    queryEmbedding: embedding,
    queryText: entry.queryText,
    responseText: entry.responseText,
    tier: entry.tier,
    tokenUsage: { promptTokens: entry.promptTokens, completionTokens: entry.completionTokens },
    savedAt: Date.now(),
    lastAccessedAt: Date.now(),
    hitCount: 0,
    domain: entry.domain || '',
    constraintIds: entry.constraintIds || [],
    ttl: entry.ttl !== undefined ? entry.ttl : config.defaultTTL
  }

  exactMap.set(hash, cacheEntry)
  semanticArray.push(cacheEntry)
  lruAdd(cacheEntry)

  while (exactMap.size > config.maxEntries) {
    const evicted = lruEvictOne()
    if (!evicted) break
    exactMap.delete(evicted.queryHash)
    semanticArray = semanticArray.filter(e => e.id !== evicted.id)
  }

  debugLog(`[SemanticCache] STORE: domain=${cacheEntry.domain}, tokens=${entry.promptTokens + entry.completionTokens}`)
  scheduleSave()
  return cacheEntry
}

export function invalidateByDomain(domain: string): number {
  const before = semanticArray.length
  const toRemove = semanticArray.filter(e => e.domain === domain)
  for (const entry of toRemove) {
    exactMap.delete(entry.queryHash)
    const lruNode = lruMap.get(entry.id)
    if (lruNode) lruRemove(lruNode)
  }
  semanticArray = semanticArray.filter(e => e.domain !== domain)
  const removed = before - semanticArray.length
  if (removed > 0) {
    debugLog(`[SemanticCache] INVALIDATE domain=${domain}, removed=${removed}`)
    scheduleSave()
  }
  return removed
}

export function invalidateByConstraint(constraintId: string): number {
  const before = semanticArray.length
  const toRemove = semanticArray.filter(e => e.constraintIds.includes(constraintId))
  for (const entry of toRemove) {
    exactMap.delete(entry.queryHash)
    const lruNode = lruMap.get(entry.id)
    if (lruNode) lruRemove(lruNode)
  }
  semanticArray = semanticArray.filter(e => !e.constraintIds.includes(constraintId))
  const removed = before - semanticArray.length
  if (removed > 0) {
    debugLog(`[SemanticCache] INVALIDATE constraint=${constraintId}, removed=${removed}`)
    scheduleSave()
  }
  return removed
}

export function invalidateExpired(): number {
  const before = semanticArray.length
  const toRemove = semanticArray.filter(e => isExpired(e))
  for (const entry of toRemove) {
    exactMap.delete(entry.queryHash)
    const lruNode = lruMap.get(entry.id)
    if (lruNode) lruRemove(lruNode)
  }
  semanticArray = semanticArray.filter(e => !isExpired(e))
  const removed = before - semanticArray.length
  if (removed > 0) scheduleSave()
  return removed
}

export function clearCache(): void {
  exactMap.clear()
  semanticArray = []
  lruHead = null
  lruTail = null
  lruMap.clear()
  totalHits = 0
  totalMisses = 0
  totalSavedTokens = 0
  totalSavedCost = 0
  adaptive = { ...DEFAULT_ADAPTIVE }
  scheduleSave()
}

export function getConfig(): SemanticCacheConfig {
  return { ...config }
}

export function setConfig(partial: Partial<SemanticCacheConfig>): void {
  config = { ...config, ...partial }
}

export function getCacheSize(): number {
  return semanticArray.length
}

export function getCacheEntries(): SemanticCacheEntry[] {
  return [...semanticArray]
}

export function getCacheSavings(): CacheSavings {
  const totalLookups = totalHits + totalMisses
  return {
    semanticCacheHits: totalHits,
    semanticCacheSavedTokens: totalSavedTokens,
    semanticCacheSavedCost: totalSavedCost,
    semanticCacheMisses: totalMisses,
    totalLookups,
    hitRate: totalLookups > 0 ? totalHits / totalLookups : 0
  }
}

export function resetSavingsCounters(): void {
  totalHits = 0
  totalMisses = 0
  totalSavedTokens = 0
  totalSavedCost = 0
}

export function getAdaptiveThreshold(): number {
  return adaptive.current
}

export function resetAdaptiveThreshold(): void {
  adaptive = { ...DEFAULT_ADAPTIVE }
}

const CACHE_STORAGE_KEY = 'holo-semantic-cache'

interface SerializedEntry {
  id: string
  queryHash: string
  queryEmbeddingB64: string
  queryText: string
  responseText: string
  tier: ModelTier
  tokenUsage: { promptTokens: number; completionTokens: number }
  savedAt: number
  lastAccessedAt: number
  hitCount: number
  domain: string
  constraintIds: string[]
  ttl: number
}

function float32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return (typeof btoa !== 'undefined') ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
}

function base64ToFloat32Array(base64: string): Float32Array {
  const binary = (typeof atob !== 'undefined') ? atob(base64) : Buffer.from(base64, 'base64').toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Float32Array(bytes.buffer)
}

function serializeEntry(e: SemanticCacheEntry): SerializedEntry {
  const f32 = new Float32Array(e.queryEmbedding)
  return {
    id: e.id,
    queryHash: e.queryHash,
    queryEmbeddingB64: float32ArrayToBase64(f32),
    queryText: e.queryText,
    responseText: e.responseText,
    tier: e.tier,
    tokenUsage: e.tokenUsage,
    savedAt: e.savedAt,
    lastAccessedAt: e.lastAccessedAt,
    hitCount: e.hitCount,
    domain: e.domain,
    constraintIds: e.constraintIds,
    ttl: e.ttl
  }
}

function deserializeEntry(s: SerializedEntry): SemanticCacheEntry | null {
  try {
    const f32 = base64ToFloat32Array(s.queryEmbeddingB64)
    return {
      id: s.id,
      queryHash: s.queryHash,
      queryEmbedding: Array.from(f32),
      queryText: s.queryText,
      responseText: s.responseText,
      tier: s.tier,
      tokenUsage: s.tokenUsage,
      savedAt: s.savedAt,
      lastAccessedAt: s.lastAccessedAt,
      hitCount: s.hitCount,
      domain: s.domain,
      constraintIds: s.constraintIds,
      ttl: s.ttl
    }
  } catch {
    return null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveToStorage()
    saveTimer = null
  }, 1000)
}

function saveToStorage(): void {
  try {
    const serialized = semanticArray.map(serializeEntry)
    const json = JSON.stringify(serialized)
    vault.writeThrough('cache', CACHE_STORAGE_KEY, json)
  } catch {
    while (semanticArray.length > 10) {
      const evicted = lruEvictOne()
      if (!evicted) break
      exactMap.delete(evicted.queryHash)
      semanticArray = semanticArray.filter(e => e.id !== evicted.id)
    }
    try {
      const serialized = semanticArray.map(serializeEntry)
      vault.writeThrough('cache', CACHE_STORAGE_KEY, JSON.stringify(serialized))
    } catch { /* non-critical */ }
  }
}

export function loadFromStorage(): void {
  try {
    const raw = vault.readCache('cache', CACHE_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as SerializedEntry[]
    if (!Array.isArray(parsed)) return

    clearCache()
    const now = Date.now()
    for (const s of parsed) {
      const entry = deserializeEntry(s)
      if (!entry) continue
      if (now - entry.savedAt > entry.ttl) continue
      exactMap.set(entry.queryHash, entry)
      semanticArray.push(entry)
      lruAdd(entry)
    }
    debugLog(`[SemanticCache] Loaded ${semanticArray.length} entries from storage`)
  } catch { /* non-critical */ }
}

export async function initSemanticCache(): Promise<void> {
  const raw = await vault.read('cache', CACHE_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SerializedEntry[]
      if (Array.isArray(parsed)) {
        clearCache()
        const now = Date.now()
        for (const s of parsed) {
          const entry = deserializeEntry(s)
          if (!entry) continue
          if (now - entry.savedAt > entry.ttl) continue
          exactMap.set(entry.queryHash, entry)
          semanticArray.push(entry)
          lruAdd(entry)
        }
        debugLog(`[SemanticCache] Loaded ${semanticArray.length} entries from vault`)
      }
    } catch { /* non-critical */ }
  }
  reembedAll().catch(() => {})
}
