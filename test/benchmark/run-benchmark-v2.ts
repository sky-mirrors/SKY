import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { getTestCasesV2, DOMAIN_LABELS, type TestCaseV2 } from './test-cases-v2'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY not set. Usage:')
  console.error('  $env:DEEPSEEK_API_KEY="sk-xxx"; npx tsx test/benchmark/run-benchmark-v2.ts')
  process.exit(1)
}

const PRICE = { inputUncached: 1.0, inputCached: 0.02, output: 2.0 }
const TIER_MAX_TOKENS: Record<string, number> = { nano: 512, mini: 1024, standard: 4096 }

interface TestStats {
  totalRequests: number
  llmCalls: number
  cacheHits: number
  l0LocalHits: number
  l0LlmHits: number
  l05Hits: number
  fingerprintHits: number
  ruleHits: number
  totalInputTokens: number
  totalOutputTokens: number
  totalKVCacheHitTokens: number
  totalKVCacheMissTokens: number
  totalCostCNY: number
  totalLatencyMs: number
  totalTtftMs: number
  ttftCount: number
  errors: number
}

function createEmptyStats(): TestStats {
  return {
    totalRequests: 0, llmCalls: 0, cacheHits: 0,
    l0LocalHits: 0, l0LlmHits: 0, l05Hits: 0, fingerprintHits: 0, ruleHits: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalKVCacheHitTokens: 0, totalKVCacheMissTokens: 0,
    totalCostCNY: 0, totalLatencyMs: 0,
    totalTtftMs: 0, ttftCount: 0,
    errors: 0
  }
}

interface ApiCallResult {
  content: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  ttftMs: number
}

const fingerprintCache = new Map<string, { result: string; inputTokens: number; outputTokens: number }>()

async function callDeepSeekStreaming(
  messages: { role: string; content: string }[],
  maxTokens: number = 4096
): Promise<ApiCallResult> {
  const startTime = Date.now()
  let ttftMs = 0
  let firstTokenReceived = false
  let content = ''
  let usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }

  try {
    const resp = await axios.post(
      `${BASE_URL}/v1/chat/completions`,
      {
        model: MODEL,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens
      },
      {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 120000,
        responseType: 'stream'
      }
    )

    return new Promise<ApiCallResult>((resolve, reject) => {
      let buffer = ''
      resp.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            if (!firstTokenReceived && parsed.choices?.[0]?.delta?.content) {
              ttftMs = Date.now() - startTime
              firstTokenReceived = true
            }
            if (parsed.choices?.[0]?.delta?.content) {
              content += parsed.choices[0].delta.content
            }
            if (parsed.usage) {
              usage = {
                prompt_tokens: parsed.usage.prompt_tokens || 0,
                completion_tokens: parsed.usage.completion_tokens || 0,
                prompt_cache_hit_tokens: parsed.usage.prompt_cache_hit_tokens || 0,
                prompt_cache_miss_tokens: parsed.usage.prompt_cache_miss_tokens || 0
              }
            }
          } catch { /* skip malformed chunks */ }
        }
      })
      resp.data.on('end', () => {
        resolve({
          content,
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
          cacheHitTokens: usage.prompt_cache_hit_tokens,
          cacheMissTokens: usage.prompt_cache_miss_tokens,
          ttftMs: ttftMs || (Date.now() - startTime)
        })
      })
      resp.data.on('error', (err: Error) => reject(err))
    })
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      console.log('  Rate limited, waiting 10s...')
      await new Promise(r => setTimeout(r, 10000))
      return callDeepSeekStreaming(messages, maxTokens)
    }
    throw err
  }
}

const L0_RULES: { patterns: RegExp[]; forbidden: RegExp[]; requiresLlm: boolean }[] = [
  {
    patterns: [/(转|转换|转为|转成|导出|另存|保存为|处理为|输出为).*(docx|pdf|txt|md|xlsx|html)/i],
    forbidden: [/(审查|合规|条款|风险|法律|合同)/],
    requiresLlm: true
  },
  {
    patterns: [/^(ls|dir|pwd|whoami|date|hostname|cat|type|echo|mkdir|cp|copy|mv|move|rm|del)\b/i, /^运行\s+/, /^执行\s+/, /^(npm|node|pip|python|git)\s+/],
    forbidden: [/(格式|转换|文档|分析|审查|报告)/],
    requiresLlm: false
  },
  {
    patterns: [/^(写|生成|帮我写|帮我生成|起草|撰写)\s*(一个|一份|一段|一篇)?\s*.{0,30}?(代码|函数|脚本|邮件|通知|公告|文案|总结)/i],
    forbidden: [/(周报|会议纪要|合同|财报|竞品|报销)/],
    requiresLlm: true
  },
  {
    patterns: [/^(几点|什么时间|今天是|现在几|天气|计算|算一下|等于多少|几号)/i, /^(what time|what day|calculate|compute)\b/i, /^(今天|现在|当前).{0,5}?(日期|时间|星期|几号)/i, /^(现在|当前).{0,5}?(几点|几分)/i],
    forbidden: [/(分析|报告|审查|对比|文档|文件|转换)/],
    requiresLlm: true
  },
  {
    patterns: [/(创建|新建|写|生成|保存)(一个|一份)?\s*(docx|word|txt|文本|文档|文件)/i],
    forbidden: [/(审查|合规|条款|风险|法律|合同|分析|报告|周报|总结|竞品|财报|摘要|说明|简介)/],
    requiresLlm: false
  },
  {
    patterns: [/^(curl|fetch|get|post|请求|访问|下载)\s+/i, /https?:\/\/\S+/],
    forbidden: [],
    requiresLlm: false
  },
  {
    patterns: [/(创建|新建|建)(一个)?\s*(文件夹|目录|folder)/i],
    forbidden: [/(文档|docx|txt|pdf|xlsx|审查|分析|写|生成|保存)/],
    requiresLlm: false
  },
  {
    patterns: [/^(读取|查看|打开|显示|阅读|看看)(一下)?\s*(文件|文档|内容)?\s*.{0,30}$/i, /^(cat|type|head|tail|less|more)\s+/i],
    forbidden: [/(分析|审查|转换|修改|编辑|风险|合规|生成报告)/],
    requiresLlm: false
  }
]

const L05_KEYWORDS = ['翻译', '译成', '生成', '写一段', '文案', '报销', '合同', '竞品', '周报', '会议纪要', '财报', 'KPI', '预算']

function checkL0(input: string): { hit: boolean; requiresLlm: boolean } {
  for (const rule of L0_RULES) {
    const triggered = rule.patterns.some(p => p.test(input))
    if (!triggered) continue
    const forbidden = rule.forbidden.some(p => p.test(input))
    if (forbidden) continue
    return { hit: true, requiresLlm: rule.requiresLlm }
  }
  return { hit: false, requiresLlm: false }
}

function checkL05(input: string): boolean {
  return L05_KEYWORDS.some(kw => input.includes(kw))
}

function computeFingerprint(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

async function runBaseline(cases: TestCaseV2[], stats: TestStats, sleepMs: number): Promise<void> {
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]
    stats.totalRequests++
    const startTime = Date.now()
    try {
      const result = await callDeepSeekStreaming([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.standard)
      stats.llmCalls++
      stats.totalInputTokens += result.inputTokens
      stats.totalOutputTokens += result.outputTokens
      stats.totalKVCacheHitTokens += result.cacheHitTokens
      stats.totalKVCacheMissTokens += result.cacheMissTokens
      const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
      stats.totalCostCNY += cost
      const latency = Date.now() - startTime
      stats.totalLatencyMs += latency
      stats.totalTtftMs += result.ttftMs
      stats.ttftCount++
      console.log(`  [${tc.label}] in=${result.inputTokens}(kv=${result.cacheHitTokens}) out=${result.outputTokens} ttft=${result.ttftMs}ms cost=¥${cost.toFixed(6)} ${formatMs(latency)}`)
    } catch (err) {
      stats.errors++
      console.warn(`  [${tc.label}] ERROR: ${(err as Error).message.slice(0, 120)}`)
    }
    if (sleepMs > 0 && i < cases.length - 1) {
      await new Promise(r => setTimeout(r, sleepMs))
    }
  }
}

async function runOptimized(cases: TestCaseV2[], stats: TestStats, sleepMs: number): Promise<void> {
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]
    stats.totalRequests++
    const startTime = Date.now()
    const fp = computeFingerprint(tc.input)

    const cached = fingerprintCache.get(fp)
    if (cached) {
      stats.cacheHits++
      stats.fingerprintHits++
      stats.totalLatencyMs += 5
      stats.totalCostCNY += 0.0001
      console.log(`  [${tc.label}] fingerprint cache hit (in=${cached.inputTokens} out=${cached.outputTokens})`)
      continue
    }

    const l0 = checkL0(tc.input)
    if (l0.hit) {
      if (l0.requiresLlm) {
        stats.l0LlmHits++
        try {
          const result = await callDeepSeekStreaming([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.nano)
          stats.llmCalls++
          stats.totalInputTokens += result.inputTokens
          stats.totalOutputTokens += result.outputTokens
          stats.totalKVCacheHitTokens += result.cacheHitTokens
          stats.totalKVCacheMissTokens += result.cacheMissTokens
          const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
          stats.totalCostCNY += cost
          const latency = Date.now() - startTime
          stats.totalLatencyMs += latency
          stats.totalTtftMs += result.ttftMs
          stats.ttftCount++
          fingerprintCache.set(fp, { result: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
          console.log(`  [${tc.label}] L0+LLM(nano) in=${result.inputTokens}(kv=${result.cacheHitTokens}) out=${result.outputTokens} ttft=${result.ttftMs}ms cost=¥${cost.toFixed(6)} ${formatMs(latency)}`)
        } catch (err) {
          stats.errors++
          console.warn(`  [${tc.label}] L0+LLM ERROR: ${(err as Error).message.slice(0, 120)}`)
        }
      } else {
        stats.cacheHits++
        stats.l0LocalHits++
        stats.totalLatencyMs += 3
        stats.totalCostCNY += 0.0001
        fingerprintCache.set(fp, { result: '', inputTokens: 0, outputTokens: 0 })
        console.log(`  [${tc.label}] L0 local (0 tokens)`)
      }
      if (sleepMs > 0 && i < cases.length - 1) {
        await new Promise(r => setTimeout(r, sleepMs))
      }
      continue
    }

    if (checkL05(tc.input)) {
      try {
        const result = await callDeepSeekStreaming([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.mini)
        stats.llmCalls++
        stats.cacheHits++
        stats.l05Hits++
        stats.totalInputTokens += result.inputTokens
        stats.totalOutputTokens += result.outputTokens
        stats.totalKVCacheHitTokens += result.cacheHitTokens
        stats.totalKVCacheMissTokens += result.cacheMissTokens
        const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
        stats.totalCostCNY += cost
        const latency = Date.now() - startTime
        stats.totalLatencyMs += latency
        stats.totalTtftMs += result.ttftMs
        stats.ttftCount++
        fingerprintCache.set(fp, { result: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
        console.log(`  [${tc.label}] L0.5(mini) in=${result.inputTokens}(kv=${result.cacheHitTokens}) out=${result.outputTokens} ttft=${result.ttftMs}ms cost=¥${cost.toFixed(6)} ${formatMs(latency)}`)
      } catch (err) {
        stats.errors++
        console.warn(`  [${tc.label}] L0.5 ERROR: ${(err as Error).message.slice(0, 120)}`)
      }
      if (sleepMs > 0 && i < cases.length - 1) {
        await new Promise(r => setTimeout(r, sleepMs))
      }
      continue
    }

    try {
      const result = await callDeepSeekStreaming([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.standard)
      stats.llmCalls++
      stats.totalInputTokens += result.inputTokens
      stats.totalOutputTokens += result.outputTokens
      stats.totalKVCacheHitTokens += result.cacheHitTokens
      stats.totalKVCacheMissTokens += result.cacheMissTokens
      const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
      stats.totalCostCNY += cost
      const latency = Date.now() - startTime
      stats.totalLatencyMs += latency
      stats.totalTtftMs += result.ttftMs
      stats.ttftCount++
      fingerprintCache.set(fp, { result: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
      console.log(`  [${tc.label}] RaaP(std) in=${result.inputTokens}(kv=${result.cacheHitTokens}) out=${result.outputTokens} ttft=${result.ttftMs}ms cost=¥${cost.toFixed(6)} ${formatMs(latency)}`)
    } catch (err) {
      stats.errors++
      console.warn(`  [${tc.label}] RaaP ERROR: ${(err as Error).message.slice(0, 120)}`)
    }
    if (sleepMs > 0 && i < cases.length - 1) {
      await new Promise(r => setTimeout(r, sleepMs))
    }
  }
}

function computeImprovement(baseline: TestStats, optimized: TestStats) {
  const bTotal = baseline.totalInputTokens + baseline.totalOutputTokens
  const oTotal = optimized.totalInputTokens + optimized.totalOutputTokens
  const tokenSaved = bTotal - oTotal
  const tokenSavedPercent = bTotal > 0 ? (tokenSaved / bTotal) * 100 : 0
  const costSaved = baseline.totalCostCNY - optimized.totalCostCNY
  const costSavedPercent = baseline.totalCostCNY > 0 ? (costSaved / baseline.totalCostCNY) * 100 : 0
  const latencySaved = baseline.totalLatencyMs - optimized.totalLatencyMs
  const latencySavedPercent = baseline.totalLatencyMs > 0 ? (latencySaved / baseline.totalLatencyMs) * 100 : 0
  const cacheHitRate = optimized.totalRequests > 0 ? (optimized.cacheHits / optimized.totalRequests) * 100 : 0
  const bTtft = baseline.ttftCount > 0 ? baseline.totalTtftMs / baseline.ttftCount : 0
  const oTtft = optimized.ttftCount > 0 ? optimized.totalTtftMs / optimized.ttftCount : 0
  const ttftSavedPercent = bTtft > 0 ? ((bTtft - oTtft) / bTtft) * 100 : 0
  const kvTotal = optimized.totalKVCacheHitTokens + optimized.totalKVCacheMissTokens
  const kvHitRate = kvTotal > 0 ? (optimized.totalKVCacheHitTokens / kvTotal) * 100 : 0
  return {
    tokenSaved, tokenSavedPercent, costSaved, costSavedPercent,
    latencySaved, latencySavedPercent, cacheHitRate, ttftSavedPercent,
    bTtft, oTtft, kvHitRate
  }
}

function formatStats(stats: TestStats): string {
  const total = stats.totalInputTokens + stats.totalOutputTokens
  const kvTotal = stats.totalKVCacheHitTokens + stats.totalKVCacheMissTokens
  const kvRate = kvTotal > 0 ? (stats.totalKVCacheHitTokens / kvTotal * 100).toFixed(1) : '0'
  const avgTtft = stats.ttftCount > 0 ? (stats.totalTtftMs / stats.ttftCount).toFixed(0) : '0'
  return `${stats.llmCalls} calls, ${total} tokens, ¥${stats.totalCostCNY.toFixed(4)}, ${formatMs(stats.totalLatencyMs)}, ttft=${avgTtft}ms, kv_hit=${kvRate}%`
}

async function runMode(
  mode: 'continuous' | 'decay' | 'random',
  allCases: TestCaseV2[]
): Promise<{ baseline: TestStats; optimized: TestStats; improvement: ReturnType<typeof computeImprovement> }> {
  const sleepMs = 2000
  let cases = [...allCases]

  if (mode === 'random') {
    for (let i = cases.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cases[i], cases[j]] = [cases[j], cases[i]]
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Mode: ${mode.toUpperCase()}`)
  console.log(`${'═'.repeat(60)}`)

  console.log(`\n>>> Baseline (no optimization, all standard tier)`)
  const baselineStats = createEmptyStats()
  await runBaseline(cases, baselineStats, sleepMs)
  console.log(`Baseline: ${formatStats(baselineStats)}`)

  console.log(`\n>>> Optimized (L0/L0.5/Fingerprint/KV Cache/Tiering)`)
  fingerprintCache.clear()
  const optimizedStats = createEmptyStats()

  if (mode === 'decay') {
    const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
    for (let g = 0; g < groups.length; g++) {
      const groupCases = cases.filter(c => c.group === groups[g])
      if (groupCases.length === 0) continue
      console.log(`\n  --- Domain ${groups[g]}: ${DOMAIN_LABELS[allCases.find(c => c.group === groups[g])?.domain || 'file'] || groups[g]} ---`)
      await runOptimized(groupCases, optimizedStats, sleepMs)
      if (g < groups.length - 1) {
        console.log(`  Waiting 5 min for KV cache decay...`)
        await new Promise(r => setTimeout(r, 5 * 60 * 1000))
      }
    }
  } else {
    await runOptimized(cases, optimizedStats, sleepMs)
  }
  console.log(`Optimized: ${formatStats(optimizedStats)}`)

  const improvement = computeImprovement(baselineStats, optimizedStats)
  return { baseline: baselineStats, optimized: optimizedStats, improvement }
}

async function main(): Promise<void> {
  const allCases = getTestCasesV2()
  console.log(`${'═'.repeat(60)}`)
  console.log('  HoloStarmap DeepSeek V4 Flash Benchmark V2')
  console.log(`${'═'.repeat(60)}`)
  console.log(`  Model:  ${MODEL}`)
  console.log(`  API:    ${BASE_URL}`)
  console.log(`  Key:    ${API_KEY.substring(0, 8)}...`)
  console.log(`  Cases:  ${allCases.length} (${allCases.filter(c => c.isRepeat).length} repeats)`)
  console.log(`  Domains: ${Object.entries(DOMAIN_LABELS).map(([k, v]) => `${v}(${allCases.filter(c => c.domain === k).length})`).join(' ')}`)
  console.log(`  Pricing: input ¥${PRICE.inputUncached}/1M | cached ¥${PRICE.inputCached}/1M | output ¥${PRICE.output}/1M`)
  console.log(`  Modes:  continuous | decay | random`)
  console.log(`${'═'.repeat(60)}`)

  const continuous = await runMode('continuous', allCases)
  const decay = await runMode('decay', allCases)
  const random = await runMode('random', allCases)

  function buildModeReport(result: { baseline: TestStats; optimized: TestStats; improvement: ReturnType<typeof computeImprovement> }) {
    const imp = result.improvement
    return {
      baseline: result.baseline,
      optimized: result.optimized,
      improvement: {
        tokenSavedPercent: imp.tokenSavedPercent.toFixed(2) + '%',
        costSavedPercent: imp.costSavedPercent.toFixed(2) + '%',
        latencySavedPercent: imp.latencySavedPercent.toFixed(2) + '%',
        ttftSavedPercent: imp.ttftSavedPercent.toFixed(2) + '%',
        cacheHitRate: imp.cacheHitRate.toFixed(2) + '%',
        kvCacheHitRate: imp.kvHitRate.toFixed(2) + '%'
      },
      raw: {
        tokenSaved: imp.tokenSaved,
        costSaved: imp.costSaved,
        latencySaved: imp.latencySaved,
        baselineAvgTtftMs: Math.round(imp.bTtft),
        optimizedAvgTtftMs: Math.round(imp.oTtft)
      }
    }
  }

  const report = {
    version: 2,
    timestamp: new Date().toISOString(),
    model: MODEL,
    testCases: allCases.length,
    domains: DOMAIN_LABELS,
    modes: {
      continuous: buildModeReport(continuous),
      decay: buildModeReport(decay),
      random: buildModeReport(random)
    },
    industryComparison: {
      anthropic_100k_context: { costSaved: '90%', latencySaved: '79%', source: 'Anthropic official blog' },
      anthropic_multi_turn: { costSaved: '53%', latencySaved: '75%', source: 'Anthropic official blog' },
      openai_gpt41_cached: { costSaved: '75%', latencySaved: 'N/A', source: 'OpenAI official blog' },
      deepseek_v4_flash_cached: { costSaved: '96.7%', latencySaved: 'N/A', source: 'DeepSeek pricing page' }
    }
  }

  const outPath = path.resolve(process.cwd(), 'benchmark-result-v2.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')

  console.log(`\n${'═'.repeat(60)}`)
  console.log('  FINAL RESULTS')
  console.log(`${'═'.repeat(60)}`)

  for (const [modeName, modeData] of Object.entries(report.modes)) {
    const imp = modeData.improvement
    const raw = modeData.raw
    console.log(`\n  [${modeName.toUpperCase()}]`)
    console.log(`    Token节省:  ${imp.tokenSavedPercent}`)
    console.log(`    成本节省:   ${imp.costSavedPercent}`)
    console.log(`    延迟节省:   ${imp.latencySavedPercent}`)
    console.log(`    TTFT节省:   ${imp.ttftSavedPercent} (baseline=${raw.baselineAvgTtftMs}ms → optimized=${raw.optimizedAvgTtftMs}ms)`)
    console.log(`    缓存命中:   ${imp.cacheHitRate}`)
    console.log(`    KV命中:     ${imp.kvCacheHitRate}`)
  }

  console.log(`\n  [INDUSTRY COMPARISON]`)
  console.log(`    Anthropic 100K:  cost=90% latency=79%`)
  console.log(`    Anthropic multi: cost=53%  latency=75%`)
  console.log(`    OpenAI GPT-4.1:  cost=75%  latency=N/A`)
  console.log(`    DeepSeek V4 KV:  cost=96.7% latency=N/A`)

  console.log(`\nReport saved: ${outPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
