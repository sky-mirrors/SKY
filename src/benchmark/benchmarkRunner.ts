import { useApiStore } from '@/stores/apiStore'
import { useNodeStore } from '@/stores/nodeStore'
import { tryL0Skill, tryL05QuickMatch, checkL1Capability } from '@/services/l0SkillRouter'
import { computeInputFingerprint, findCachedExecution, getTierConfig, saveExecutionFingerprint } from '@/services/scheduleOptimizer'
import type { BenchmarkStats, BenchmarkReport } from './statsTracker'
import { createStatsTracker } from './statsTracker'
import { getTestCases, type TestCase } from './testCases'

export interface BenchmarkProgress {
  phase: 'idle' | 'baseline' | 'optimized' | 'report' | 'done' | 'error'
  currentCase: number
  totalCases: number
  currentLabel: string
  baselineStats: BenchmarkStats | null
  optimizedStats: BenchmarkStats | null
  report: BenchmarkReport | null
  errorMessage: string
}

export interface BenchmarkRunner {
  progress: BenchmarkProgress
  run: (sleepMs: number) => Promise<void>
  cancel: () => void
  exportReport: () => Promise<string | null>
}

export function createBenchmarkRunner(): BenchmarkRunner {
  const progress: BenchmarkProgress = {
    phase: 'idle',
    currentCase: 0,
    totalCases: 0,
    currentLabel: '',
    baselineStats: null,
    optimizedStats: null,
    report: null,
    errorMessage: ''
  }

  let cancelled = false

  const baselineTracker = createStatsTracker()
  const optimizedTracker = createStatsTracker()

  async function directLlmCall(input: string, tier: string, tracker: ReturnType<typeof createStatsTracker>): Promise<string> {
    const apiStore = useApiStore()
    const tierConfig = getTierConfig(tier)
    const startTime = Date.now()

    try {
      const resp = await apiStore.chatCompletion(
        [{ role: 'user', content: input }],
        true,
        undefined,
        tierConfig.maxTokens
      )
      const inTokens = resp.usage?.promptTokens || 0
      const outTokens = resp.usage?.completionTokens || 0
      const cacheHit = resp.usage?.cacheHitTokens || 0
      const cacheMiss = resp.usage?.cacheMissTokens || (inTokens - cacheHit)
      const latency = Date.now() - startTime
      tracker.recordLlmCall(inTokens, outTokens, cacheHit, cacheMiss, latency)
      return resp.content || ''
    } catch (err) {
      tracker.recordError()
      console.warn(`[Benchmark] LLM call failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  async function routeOptimized(input: string, tracker: ReturnType<typeof createStatsTracker>): Promise<string> {
    const apiStore = useApiStore()
    const nodeStore = useNodeStore()

    const l0Plan = await tryL0Skill(input)
    if (l0Plan) {
      tracker.recordCacheHit('l0')
      console.log(`[Benchmark:Optimized] L0 hit: ${l0Plan.intent}`)
      return `[L0_HIT] ${l0Plan.intent}`
    }

    const allL2 = nodeStore.getAllL2Manifests()
    const l05Result = tryL05QuickMatch(input, allL2)
    if (l05Result && l05Result.confidence >= 0.8) {
      const m = l05Result.manifest
      if (m.execution.mode === 'direct' && m.execution.directCall) {
        const prompt = m.execution.directCall.promptTemplate.replace('{{input}}', input)
        const result = await directLlmCall(prompt, 'nano', tracker)
        tracker.recordCacheHit('l05')
        console.log(`[Benchmark:Optimized] L0.5 hit: ${m.identity.name} (nano tier)`)
        return result
      }
      if (m.execution.dagPlan && m.execution.dagPlan.steps.length === 1) {
        const step = m.execution.dagPlan.steps[0]
        const tier = step.modelTier || 'mini'
        const prompt = String(step.params.prompt || input)
        const result = await directLlmCall(prompt, tier, tracker)
        tracker.recordCacheHit('l05')
        console.log(`[Benchmark:Optimized] L0.5 hit: ${m.identity.name} (${tier} tier)`)
        return result
      }

      if (m.execution.dagPlan) {
        const inputFingerprint = computeInputFingerprint({ inputText: input })
        const cached = findCachedExecution(m.identity.id, inputFingerprint)
        if (cached) {
          tracker.recordCacheHit('fingerprint')
          console.log(`[Benchmark:Optimized] Fingerprint cache hit: ${m.identity.id}`)
          const steps = m.execution.dagPlan.steps
          const lastStep = steps[steps.length - 1]
          return cached.results[lastStep.step] || '[CACHED]'
        }

        console.log(`[Benchmark:Optimized] L0.5 multi-step manifest: ${m.identity.id}, executing...`)
        let lastResult = ''
        for (const step of m.execution.dagPlan.steps) {
          const tier = step.modelTier || 'standard'
          const prompt = String(step.params.prompt || input)
          lastResult = await directLlmCall(prompt, tier, tracker)
        }
        const inputFp = computeInputFingerprint({ inputText: input })
        const stepHashes: Record<number, string> = {}
        const results: Record<number, string> = {}
        for (const step of m.execution.dagPlan.steps) {
          results[step.step] = lastResult
          stepHashes[step.step] = String(Date.now())
        }
        saveExecutionFingerprint(m.identity.id, inputFp, stepHashes, results)
        return lastResult
      }
    }

    const l1Check = checkL1Capability(input)
    if (l1Check.canHandle && l1Check.confidence >= 0.6) {
      tracker.recordCacheHit('l05')
      console.log(`[Benchmark:Optimized] L1 hit: ${l1Check.nodeName}`)
      const result = await directLlmCall(input, 'mini', tracker)
      return result
    }

    console.log(`[Benchmark:Optimized] RaaP path for: ${input.substring(0, 40)}`)
    return directLlmCall(input, 'standard', tracker)
  }

  async function runPhase(forceBaseline: boolean, tracker: ReturnType<typeof createStatsTracker>, sleepMs: number): Promise<void> {
    const cases = getTestCases()
    tracker.reset()

    for (let i = 0; i < cases.length; i++) {
      if (cancelled) break

      const tc = cases[i]
      progress.currentCase = i + 1
      progress.currentLabel = tc.label

      tracker.stats.totalRequests++

      try {
        if (forceBaseline) {
          await directLlmCall(tc.input, 'standard', tracker)
        } else {
          await routeOptimized(tc.input, tracker)
        }
      } catch (err) {
        console.warn(`[Benchmark] Error on ${tc.label}: ${err instanceof Error ? err.message : String(err)}`)
        tracker.recordError()
      }

      if (sleepMs > 0 && i < cases.length - 1) {
        await new Promise(r => setTimeout(r, sleepMs))
      }
    }
  }

  async function run(sleepMs: number = 2000): Promise<void> {
    cancelled = false
    const cases = getTestCases()
    progress.totalCases = cases.length
    progress.errorMessage = ''

    const apiStore = useApiStore()
    if (!apiStore.isReady) {
      progress.phase = 'error'
      progress.errorMessage = 'API未配置或不可用，请先配置DeepSeek模型网关'
      return
    }

    try {
      progress.phase = 'baseline'
      progress.currentCase = 0
      progress.currentLabel = '准备基线测试...'
      console.log('[Benchmark] Starting Baseline run...')

      await runPhase(true, baselineTracker, sleepMs)
      progress.baselineStats = { ...baselineTracker.stats }
      console.log(`[Benchmark] Baseline done: ${baselineTracker.stats.llmCalls} LLM calls, ${baselineTracker.stats.totalInputTokens + baselineTracker.stats.totalOutputTokens} tokens, ¥${baselineTracker.stats.totalCostCNY.toFixed(4)}`)

      if (cancelled) {
        progress.phase = 'error'
        progress.errorMessage = '用户取消'
        return
      }

      progress.phase = 'optimized'
      progress.currentCase = 0
      progress.currentLabel = '准备优化测试...'
      console.log('[Benchmark] Starting Optimized run...')

      await runPhase(false, optimizedTracker, sleepMs)
      progress.optimizedStats = { ...optimizedTracker.stats }
      console.log(`[Benchmark] Optimized done: ${optimizedTracker.stats.llmCalls} LLM calls, ${optimizedTracker.stats.totalInputTokens + optimizedTracker.stats.totalOutputTokens} tokens, ¥${optimizedTracker.stats.totalCostCNY.toFixed(4)}`)

      if (cancelled) {
        progress.phase = 'error'
        progress.errorMessage = '用户取消'
        return
      }

      progress.phase = 'report'
      const model = apiStore.config.activeModel || 'deepseek-v4-flash'
      progress.report = baselineTracker.getReport(
        progress.baselineStats,
        progress.optimizedStats,
        model
      )
      console.log('[Benchmark] Report generated:', JSON.stringify(progress.report.improvement, null, 2))

      progress.phase = 'done'
    } catch (err) {
      progress.phase = 'error'
      progress.errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[Benchmark] Fatal error:', err)
    }
  }

  function cancel(): void {
    cancelled = true
  }

  async function exportReport(): Promise<string | null> {
    if (!progress.report) return null

    const json = JSON.stringify(progress.report, null, 2)
    try {
      const home = await window.electronAPI?.resolvePath('%USERPROFILE%') || 'C:\\Users\\Default'
      const filePath = `${home}\\Desktop\\HoloStarmap\\benchmark-result.json`
      const result = await window.electronAPI?.fileWrite({ filePath, content: json })
      if (result?.success) {
        console.log(`[Benchmark] Report saved to ${filePath}`)
        return filePath
      }
      console.warn(`[Benchmark] fileWrite failed: ${result?.error}`)
    } catch (err) {
      console.warn(`[Benchmark] Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  return { progress, run, cancel, exportReport }
}
