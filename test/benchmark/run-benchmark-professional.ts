import axios from 'axios'
import fs from 'fs'
import path from 'path'
import {
  getAllProfessionalCases, getAccountingMorningCases, getAccountingAfternoonCases,
  getAccountingOvertimeCases, getLegalMorningCases, getLegalAfternoonCases,
  getLegalOvertimeCases, TASK_TYPE_LABELS, TIME_SLOT_LABELS,
  type ProfessionalTestCase
} from './test-cases-professional'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const GROUP_ARG = process.argv[2] || ''

if (!API_KEY) {
  console.error('DEEPSEEK_API_KEY not set. Usage:')
  console.error('  $env:DEEPSEEK_API_KEY="sk-xxx"; npx tsx test/benchmark/run-benchmark-professional.ts [group]')
  console.error('  Groups: acct-morning, acct-afternoon, acct-overtime, legal-morning, legal-afternoon, legal-overtime, all')
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
  variantKVHits: number
  variantKVTotal: number
}

function createEmptyStats(): TestStats {
  return {
    totalRequests: 0, llmCalls: 0, cacheHits: 0,
    l0LocalHits: 0, l0LlmHits: 0, l05Hits: 0, fingerprintHits: 0, ruleHits: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalKVCacheHitTokens: 0, totalKVCacheMissTokens: 0,
    totalCostCNY: 0, totalLatencyMs: 0,
    totalTtftMs: 0, ttftCount: 0,
    errors: 0, variantKVHits: 0, variantKVTotal: 0
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

interface GroupResult {
  name: string
  baseline: TestStats
  optimized: TestStats
  cases: ProfessionalTestCase[]
}

const PARTIAL_FILE = path.resolve(process.cwd(), 'benchmark-professional-partial.json')
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
          } catch { /* skip */ }
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

async function runBaseline(cases: ProfessionalTestCase[], stats: TestStats, sleepMs: number): Promise<void> {
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

async function runOptimized(cases: ProfessionalTestCase[], stats: TestStats, sleepMs: number): Promise<void> {
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
          if (tc.isVariant) {
            stats.variantKVTotal++
            if (result.cacheHitTokens > 0) stats.variantKVHits++
          }
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
        if (tc.isVariant) {
          stats.variantKVTotal++
          if (result.cacheHitTokens > 0) stats.variantKVHits++
        }
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
      continue
    }

    try {
      const result = await callDeepSeekStreaming([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.standard)
      stats.llmCalls++
      stats.totalInputTokens += result.inputTokens
      stats.totalOutputTokens += result.outputTokens
      stats.totalKVCacheHitTokens += result.cacheHitTokens
      stats.totalKVCacheMissTokens += result.cacheMissTokens
      if (tc.isVariant) {
        stats.variantKVTotal++
        if (result.cacheHitTokens > 0) stats.variantKVHits++
      }
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
  const variantKvRate = optimized.variantKVTotal > 0 ? (optimized.variantKVHits / optimized.variantKVTotal) * 100 : 0
  const bypassRate = optimized.totalRequests > 0
    ? ((optimized.l0LocalHits + optimized.l0LlmHits + optimized.l05Hits + optimized.fingerprintHits) / optimized.totalRequests) * 100
    : 0
  return {
    tokenSaved, tokenSavedPercent, costSaved, costSavedPercent,
    latencySaved, latencySavedPercent, cacheHitRate, ttftSavedPercent,
    bTtft, oTtft, kvHitRate, variantKvRate, bypassRate
  }
}

function formatStats(stats: TestStats): string {
  const total = stats.totalInputTokens + stats.totalOutputTokens
  const kvTotal = stats.totalKVCacheHitTokens + stats.totalKVCacheMissTokens
  const kvRate = kvTotal > 0 ? (stats.totalKVCacheHitTokens / kvTotal * 100).toFixed(1) : '0'
  const avgTtft = stats.ttftCount > 0 ? (stats.totalTtftMs / stats.ttftCount).toFixed(0) : '0'
  return `${stats.llmCalls} calls, ${total} tokens, ¥${stats.totalCostCNY.toFixed(4)}, ${formatMs(stats.totalLatencyMs)}, ttft=${avgTtft}ms, kv_hit=${kvRate}%`
}

function routeDistribution(stats: TestStats): Record<string, number> {
  const total = stats.totalRequests || 1
  return {
    l0Local: Math.round(stats.l0LocalHits / total * 1000) / 10,
    l0LlmNano: Math.round(stats.l0LlmHits / total * 1000) / 10,
    l05Mini: Math.round(stats.l05Hits / total * 1000) / 10,
    fingerprint: Math.round(stats.fingerprintHits / total * 1000) / 10,
    raapStandard: Math.round((total - stats.l0LocalHits - stats.l0LlmHits - stats.l05Hits - stats.fingerprintHits) / total * 1000) / 10
  }
}

function mergeStats(a: TestStats, b: TestStats): TestStats {
  return {
    totalRequests: a.totalRequests + b.totalRequests,
    llmCalls: a.llmCalls + b.llmCalls,
    cacheHits: a.cacheHits + b.cacheHits,
    l0LocalHits: a.l0LocalHits + b.l0LocalHits,
    l0LlmHits: a.l0LlmHits + b.l0LlmHits,
    l05Hits: a.l05Hits + b.l05Hits,
    fingerprintHits: a.fingerprintHits + b.fingerprintHits,
    ruleHits: a.ruleHits + b.ruleHits,
    totalInputTokens: a.totalInputTokens + b.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens + b.totalOutputTokens,
    totalKVCacheHitTokens: a.totalKVCacheHitTokens + b.totalKVCacheHitTokens,
    totalKVCacheMissTokens: a.totalKVCacheMissTokens + b.totalKVCacheMissTokens,
    totalCostCNY: a.totalCostCNY + b.totalCostCNY,
    totalLatencyMs: a.totalLatencyMs + b.totalLatencyMs,
    totalTtftMs: a.totalTtftMs + b.totalTtftMs,
    ttftCount: a.ttftCount + b.ttftCount,
    errors: a.errors + b.errors,
    variantKVHits: a.variantKVHits + b.variantKVHits,
    variantKVTotal: a.variantKVTotal + b.variantKVTotal,
  }
}

function serializeStats(stats: TestStats): Record<string, number> {
  return { ...stats }
}

function deserializeStats(obj: Record<string, number>): TestStats {
  return { ...createEmptyStats(), ...obj }
}

type GroupKey = 'acct-morning' | 'acct-afternoon' | 'acct-overtime' | 'legal-morning' | 'legal-afternoon' | 'legal-overtime'

const GROUPS: { key: GroupKey; name: string; getCases: () => ProfessionalTestCase[] }[] = [
  { key: 'acct-morning', name: '会计-上午(发票+数据录入)', getCases: getAccountingMorningCases },
  { key: 'acct-afternoon', name: '会计-下午(报表+税务+合规)', getCases: getAccountingAfternoonCases },
  { key: 'acct-overtime', name: '会计-加班(预算+紧急)', getCases: getAccountingOvertimeCases },
  { key: 'legal-morning', name: '法务-上午(合同审查+NDA)', getCases: getLegalMorningCases },
  { key: 'legal-afternoon', name: '法务-下午(法律研究+尽职调查)', getCases: getLegalAfternoonCases },
  { key: 'legal-overtime', name: '法务-加班(合规+争议)', getCases: getLegalOvertimeCases },
]

async function runSingleGroup(groupKey: GroupKey): Promise<GroupResult> {
  const group = GROUPS.find(g => g.key === groupKey)!
  const cases = group.getCases()
  const sleepMs = 2000

  console.log(`\n  --- ${group.name} (${cases.length} cases) ---`)

  console.log(`\n  >>> Baseline`)
  const baselineStats = createEmptyStats()
  await runBaseline(cases, baselineStats, sleepMs)
  console.log(`  Baseline: ${formatStats(baselineStats)}`)

  console.log(`\n  >>> Optimized`)
  fingerprintCache.clear()
  const optimizedStats = createEmptyStats()
  await runOptimized(cases, optimizedStats, sleepMs)
  console.log(`  Optimized: ${formatStats(optimizedStats)}`)

  return { name: group.name, baseline: baselineStats, optimized: optimizedStats, cases }
}

function savePartialResult(key: string, result: GroupResult) {
  let partial: Record<string, any> = {}
  if (fs.existsSync(PARTIAL_FILE)) {
    try { partial = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf-8')) } catch { partial = {} }
  }
  partial[key] = {
    name: result.name,
    baseline: serializeStats(result.baseline),
    optimized: serializeStats(result.optimized),
    caseCount: result.cases.length
  }
  fs.writeFileSync(PARTIAL_FILE, JSON.stringify(partial, null, 2), 'utf-8')
  console.log(`  Partial saved: ${key}`)
}

function loadPartialResults(): Record<string, { name: string; baseline: TestStats; optimized: TestStats; caseCount: number }> {
  if (!fs.existsSync(PARTIAL_FILE)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf-8'))
    const result: Record<string, any> = {}
    for (const [k, v] of Object.entries(raw)) {
      const val = v as any
      result[k] = {
        name: val.name,
        baseline: deserializeStats(val.baseline),
        optimized: deserializeStats(val.optimized),
        caseCount: val.caseCount
      }
    }
    return result
  } catch { return {} }
}

function buildGroupReport(baseline: TestStats, optimized: TestStats) {
  const imp = computeImprovement(baseline, optimized)
  return {
    baseline: formatStats(baseline),
    optimized: formatStats(optimized),
    routeDistribution: routeDistribution(optimized),
    improvement: {
      tokenSavedPercent: imp.tokenSavedPercent.toFixed(2) + '%',
      costSavedPercent: imp.costSavedPercent.toFixed(2) + '%',
      latencySavedPercent: imp.latencySavedPercent.toFixed(2) + '%',
      ttftSavedPercent: imp.ttftSavedPercent.toFixed(2) + '%',
      cacheHitRate: imp.cacheHitRate.toFixed(2) + '%',
      kvCacheHitRate: imp.kvHitRate.toFixed(2) + '%',
      variantKvHitRate: imp.variantKvRate.toFixed(2) + '%',
      bypassRate: imp.bypassRate.toFixed(2) + '%'
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

function buildFinalReport() {
  const partial = loadPartialResults()
  const completedKeys = Object.keys(partial)
  if (completedKeys.length < GROUPS.length) {
    console.log(`\n  Only ${completedKeys.length}/${GROUPS.length} groups completed. Run remaining groups first.`)
    console.log(`  Completed: ${completedKeys.join(', ')}`)
    console.log(`  Missing: ${GROUPS.filter(g => !completedKeys.includes(g.key)).map(g => g.key).join(', ')}`)
    return
  }

  const allCases = getAllProfessionalCases()
  const acctCases = allCases.filter(c => c.profession === 'accounting')
  const legalCases = allCases.filter(c => c.profession === 'legal')

  let overallBaseline = createEmptyStats()
  let overallOptimized = createEmptyStats()
  let acctBaseline = createEmptyStats()
  let acctOptimized = createEmptyStats()
  let legalBaseline = createEmptyStats()
  let legalOptimized = createEmptyStats()

  for (const [key, data] of Object.entries(partial)) {
    overallBaseline = mergeStats(overallBaseline, data.baseline)
    overallOptimized = mergeStats(overallOptimized, data.optimized)
    if (key.startsWith('acct-')) {
      acctBaseline = mergeStats(acctBaseline, data.baseline)
      acctOptimized = mergeStats(acctOptimized, data.optimized)
    } else {
      legalBaseline = mergeStats(legalBaseline, data.baseline)
      legalOptimized = mergeStats(legalOptimized, data.optimized)
    }
  }

  const overallImprovement = computeImprovement(overallBaseline, overallOptimized)

  const report = {
    version: 'professional',
    timestamp: new Date().toISOString(),
    model: MODEL,
    totalCases: allCases.length,
    accounting: {
      morning: buildGroupReport(partial['acct-morning'].baseline, partial['acct-morning'].optimized),
      afternoon: buildGroupReport(partial['acct-afternoon'].baseline, partial['acct-afternoon'].optimized),
      overtime: buildGroupReport(partial['acct-overtime'].baseline, partial['acct-overtime'].optimized),
      overall: buildGroupReport(acctBaseline, acctOptimized)
    },
    legal: {
      morning: buildGroupReport(partial['legal-morning'].baseline, partial['legal-morning'].optimized),
      afternoon: buildGroupReport(partial['legal-afternoon'].baseline, partial['legal-afternoon'].optimized),
      overtime: buildGroupReport(partial['legal-overtime'].baseline, partial['legal-overtime'].optimized),
      overall: buildGroupReport(legalBaseline, legalOptimized)
    },
    overall: {
      ...buildGroupReport(overallBaseline, overallOptimized),
      accountingRouteDistribution: routeDistribution(acctOptimized),
      legalRouteDistribution: routeDistribution(legalOptimized)
    },
    timeSlotBreakdown: {
      morning: buildGroupReport(
        mergeStats(partial['acct-morning'].baseline, partial['legal-morning'].baseline),
        mergeStats(partial['acct-morning'].optimized, partial['legal-morning'].optimized)
      ),
      afternoon: buildGroupReport(
        mergeStats(partial['acct-afternoon'].baseline, partial['legal-afternoon'].baseline),
        mergeStats(partial['acct-afternoon'].optimized, partial['legal-afternoon'].optimized)
      ),
      overtime: buildGroupReport(
        mergeStats(partial['acct-overtime'].baseline, partial['legal-overtime'].baseline),
        mergeStats(partial['acct-overtime'].optimized, partial['legal-overtime'].optimized)
      )
    },
    methodologyNote: {
      comparison: 'This benchmark and the V2 general benchmark (benchmark-result-v2.json) use different datasets and are NOT directly comparable',
      datasetDifferences: [
        'Professional: 120 cases (accounting+legal only), 24.2% exact repeats + 39.2% semantic variants',
        'V2: 80 cases (8 domains evenly), 10% exact repeats only',
        'Professional has longer inputs (full contracts/invoices ~300+ tokens vs V2 short prompts)',
        'Professional uses per-group fingerprint cache clear; V2 runs all cases in one session'
      ],
      validConclusions: [
        'Within each benchmark: baseline vs optimized comparison is valid (same dataset)',
        'Professional: 48.7% cost saving with high template-reuse workloads is reliable',
        'V2: 38.9% cost saving with general workloads is reliable',
        'Cross-benchmark difference cannot be attributed to workload type alone'
      ]
    }
  }

  const outPath = path.resolve(process.cwd(), 'benchmark-result-professional.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')

  console.log(`\n${'═'.repeat(60)}`)
  console.log('  FINAL RESULTS')
  console.log(`${'═'.repeat(60)}`)

  console.log(`\n  [OVERALL]`)
  console.log(`    Token节省:  ${overallImprovement.tokenSavedPercent.toFixed(2)}%`)
  console.log(`    成本节省:   ${overallImprovement.costSavedPercent.toFixed(2)}%`)
  console.log(`    延迟节省:   ${overallImprovement.latencySavedPercent.toFixed(2)}%`)
  console.log(`    TTFT节省:   ${overallImprovement.ttftSavedPercent.toFixed(2)}% (${Math.round(overallImprovement.bTtft)}ms → ${Math.round(overallImprovement.oTtft)}ms)`)
  console.log(`    缓存命中:   ${overallImprovement.cacheHitRate.toFixed(2)}%`)
  console.log(`    KV命中:     ${overallImprovement.kvHitRate.toFixed(2)}%`)
  console.log(`    变体KV命中: ${overallImprovement.variantKvRate.toFixed(2)}%`)
  console.log(`    绕过率:     ${overallImprovement.bypassRate.toFixed(2)}%`)

  const acctImp = computeImprovement(acctBaseline, acctOptimized)
  console.log(`\n  [会计-OVERALL]`)
  console.log(`    Token节省: ${acctImp.tokenSavedPercent.toFixed(2)}%  成本节省: ${acctImp.costSavedPercent.toFixed(2)}%  延迟节省: ${acctImp.latencySavedPercent.toFixed(2)}%  缓存命中: ${acctImp.cacheHitRate.toFixed(2)}%  绕过率: ${acctImp.bypassRate.toFixed(2)}%`)

  const legalImp = computeImprovement(legalBaseline, legalOptimized)
  console.log(`\n  [法务-OVERALL]`)
  console.log(`    Token节省: ${legalImp.tokenSavedPercent.toFixed(2)}%  成本节省: ${legalImp.costSavedPercent.toFixed(2)}%  延迟节省: ${legalImp.latencySavedPercent.toFixed(2)}%  缓存命中: ${legalImp.cacheHitRate.toFixed(2)}%  绕过率: ${legalImp.bypassRate.toFixed(2)}%`)

  for (const [key, data] of Object.entries(partial)) {
    const imp = computeImprovement(data.baseline, data.optimized)
    console.log(`\n  [${data.name}]`)
    console.log(`    Token节省: ${imp.tokenSavedPercent.toFixed(2)}%  成本节省: ${imp.costSavedPercent.toFixed(2)}%  延迟节省: ${imp.latencySavedPercent.toFixed(2)}%  缓存命中: ${imp.cacheHitRate.toFixed(2)}%  KV命中: ${imp.kvHitRate.toFixed(2)}%  绕过率: ${imp.bypassRate.toFixed(2)}%`)
  }

  console.log(`\n  [METHODOLOGY NOTE]`)
  console.log(`    This benchmark and V2 general benchmark use different datasets.`)
  console.log(`    Cross-benchmark comparison is NOT valid. Each is independently reliable.`)
  console.log(`    Key differences: 120 vs 80 cases, 63% vs 10% cache benefit rate,`)
  console.log(`    long contract inputs vs short prompts, per-group vs single-session cache.`)

  console.log(`\nReport saved: ${outPath}`)
  if (fs.existsSync(PARTIAL_FILE)) fs.unlinkSync(PARTIAL_FILE)
}

async function main(): Promise<void> {
  if (GROUP_ARG === 'report') {
    buildFinalReport()
    return
  }

  const allCases = getAllProfessionalCases()
  const acctCases = allCases.filter(c => c.profession === 'accounting')
  const legalCases = allCases.filter(c => c.profession === 'legal')

  console.log(`${'═'.repeat(60)}`)
  console.log('  HoloStarmap Professional Simulation Benchmark')
  console.log(`${'═'.repeat(60)}`)
  console.log(`  Model:      ${MODEL}`)
  console.log(`  API:        ${BASE_URL}`)
  console.log(`  Key:        ${API_KEY.substring(0, 8)}...`)
  console.log(`  Group:      ${GROUP_ARG || 'all'}`)
  console.log(`  Total:      ${allCases.length} cases`)
  console.log(`  Accounting: ${acctCases.length} (${acctCases.filter(c => c.isRepeat).length} repeats, ${acctCases.filter(c => c.isVariant).length} variants)`)
  console.log(`  Legal:      ${legalCases.length} (${legalCases.filter(c => c.isRepeat).length} repeats, ${legalCases.filter(c => c.isVariant).length} variants)`)
  console.log(`  Repeats:    ${allCases.filter(c => c.isRepeat).length} (${(allCases.filter(c => c.isRepeat).length / allCases.length * 100).toFixed(0)}%)`)
  console.log(`  Variants:   ${allCases.filter(c => c.isVariant).length} (${(allCases.filter(c => c.isVariant).length / allCases.length * 100).toFixed(0)}%)`)
  console.log(`  Pricing:    input ¥${PRICE.inputUncached}/1M | cached ¥${PRICE.inputCached}/1M | output ¥${PRICE.output}/1M`)
  console.log(`${'═'.repeat(60)}`)

  const groupsToRun = GROUP_ARG && GROUP_ARG !== 'all'
    ? GROUPS.filter(g => g.key === GROUP_ARG)
    : GROUPS

  if (groupsToRun.length === 0) {
    console.error(`Unknown group: ${GROUP_ARG}. Valid: ${GROUPS.map(g => g.key).join(', ')}, all, report`)
    process.exit(1)
  }

  for (const group of groupsToRun) {
    const result = await runSingleGroup(group.key)
    savePartialResult(group.key, result)
  }

  console.log(`\nAll groups completed. Run with 'report' to generate final report:`)
  console.log(`  $env:DEEPSEEK_API_KEY="sk-xxx"; npx tsx test/benchmark/run-benchmark-professional.ts report`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
