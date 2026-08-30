export interface BenchmarkStats {
  totalRequests: number
  llmCalls: number
  cacheHits: number
  l0Hits: number
  l05Hits: number
  fingerprintHits: number
  ruleHits: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheHitInputTokens: number
  totalCacheMissInputTokens: number
  totalCostCNY: number
  totalLatencyMs: number
  errors: number
}

export interface BenchmarkReport {
  timestamp: string
  model: string
  baseline: BenchmarkStats
  optimized: BenchmarkStats
  improvement: {
    tokenSavedPercent: string
    costSavedPercent: string
    latencySavedPercent: string
    cacheHitRate: string
    l0HitRate: string
    l05HitRate: string
    fingerprintHitRate: string
  }
  raw: {
    tokenSaved: number
    costSaved: number
    latencySaved: number
  }
}

const PRICE = {
  inputUncached: 1.0,
  inputCached: 0.02,
  output: 2.0
} as const

function createEmptyStats(): BenchmarkStats {
  return {
    totalRequests: 0,
    llmCalls: 0,
    cacheHits: 0,
    l0Hits: 0,
    l05Hits: 0,
    fingerprintHits: 0,
    ruleHits: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheHitInputTokens: 0,
    totalCacheMissInputTokens: 0,
    totalCostCNY: 0,
    totalLatencyMs: 0,
    errors: 0
  }
}

export interface StatsTracker {
  stats: BenchmarkStats
  recordLlmCall: (inputTokens: number, outputTokens: number, cacheHitTokens: number, cacheMissTokens: number, latencyMs: number) => void
  recordCacheHit: (source: 'l0' | 'l05' | 'fingerprint' | 'rule', latencyMs?: number) => void
  recordError: () => void
  reset: () => void
  getReport: (baseline: BenchmarkStats, optimized: BenchmarkStats, model: string) => BenchmarkReport
}

export function createStatsTracker(): StatsTracker {
  const stats: BenchmarkStats = createEmptyStats()

  function recordLlmCall(inputTokens: number, outputTokens: number, cacheHitTokens: number, cacheMissTokens: number, latencyMs: number): void {
    stats.llmCalls++
    stats.totalInputTokens += inputTokens
    stats.totalOutputTokens += outputTokens
    stats.totalCacheHitInputTokens += cacheHitTokens
    stats.totalCacheMissInputTokens += cacheMissTokens
    const cost = (cacheMissTokens * PRICE.inputUncached + cacheHitTokens * PRICE.inputCached + outputTokens * PRICE.output) / 1_000_000
    stats.totalCostCNY += cost
    stats.totalLatencyMs += latencyMs
  }

  function recordCacheHit(source: 'l0' | 'l05' | 'fingerprint' | 'rule', latencyMs: number = 5): void {
    stats.cacheHits++
    if (source === 'l0') stats.l0Hits++
    else if (source === 'l05') stats.l05Hits++
    else if (source === 'fingerprint') stats.fingerprintHits++
    else if (source === 'rule') stats.ruleHits++
    stats.totalLatencyMs += latencyMs
    stats.totalCostCNY += 0.0001
  }

  function recordError(): void {
    stats.errors++
  }

  function reset(): void {
    const empty = createEmptyStats()
    for (const key of Object.keys(empty) as Array<keyof BenchmarkStats>) {
      stats[key] = empty[key]
    }
  }

  function getReport(baseline: BenchmarkStats, optimized: BenchmarkStats, model: string): BenchmarkReport {
    const baselineTotal = baseline.totalInputTokens + baseline.totalOutputTokens
    const optimizedTotal = optimized.totalInputTokens + optimized.totalOutputTokens
    const tokenSaved = baselineTotal - optimizedTotal
    const tokenSavedPercent = baselineTotal > 0 ? (tokenSaved / baselineTotal) * 100 : 0

    const costSaved = baseline.totalCostCNY - optimized.totalCostCNY
    const costSavedPercent = baseline.totalCostCNY > 0 ? (costSaved / baseline.totalCostCNY) * 100 : 0

    const latencySaved = baseline.totalLatencyMs - optimized.totalLatencyMs
    const latencySavedPercent = baseline.totalLatencyMs > 0 ? (latencySaved / baseline.totalLatencyMs) * 100 : 0

    const cacheHitRate = optimized.totalRequests > 0 ? (optimized.cacheHits / optimized.totalRequests) * 100 : 0
    const l0HitRate = optimized.totalRequests > 0 ? (optimized.l0Hits / optimized.totalRequests) * 100 : 0
    const l05HitRate = optimized.totalRequests > 0 ? (optimized.l05Hits / optimized.totalRequests) * 100 : 0
    const fingerprintHitRate = optimized.totalRequests > 0 ? (optimized.fingerprintHits / optimized.totalRequests) * 100 : 0

    return {
      timestamp: new Date().toISOString(),
      model,
      baseline: { ...baseline },
      optimized: { ...optimized },
      improvement: {
        tokenSavedPercent: tokenSavedPercent.toFixed(2) + '%',
        costSavedPercent: costSavedPercent.toFixed(2) + '%',
        latencySavedPercent: latencySavedPercent.toFixed(2) + '%',
        cacheHitRate: cacheHitRate.toFixed(2) + '%',
        l0HitRate: l0HitRate.toFixed(2) + '%',
        l05HitRate: l05HitRate.toFixed(2) + '%',
        fingerprintHitRate: fingerprintHitRate.toFixed(2) + '%'
      },
      raw: {
        tokenSaved,
        costSaved,
        latencySaved
      }
    }
  }

  return { stats, recordLlmCall, recordCacheHit, recordError, reset, getReport }
}
