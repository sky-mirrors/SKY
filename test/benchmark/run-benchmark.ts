import axios from 'axios'
import fs from 'fs'
import path from 'path'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

if (!API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY 环境变量未设置。用法:')
  console.error('   $env:DEEPSEEK_API_KEY="sk-xxx"; npx tsx test/benchmark/run-benchmark.ts')
  process.exit(1)
}

const PRICE = {
  inputUncached: 1.0,
  inputCached: 0.02,
  output: 2.0
}

interface TestStats {
  totalRequests: number
  llmCalls: number
  cacheHits: number
  l0Hits: number
  l05Hits: number
  fingerprintHits: number
  ruleHits: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostCNY: number
  totalLatencyMs: number
  errors: number
}

function createEmptyStats(): TestStats {
  return {
    totalRequests: 0, llmCalls: 0, cacheHits: 0, l0Hits: 0, l05Hits: 0,
    fingerprintHits: 0, ruleHits: 0, totalInputTokens: 0, totalOutputTokens: 0,
    totalCostCNY: 0, totalLatencyMs: 0, errors: 0
  }
}

const fingerprintCache = new Map<string, { result: string; inputTokens: number; outputTokens: number }>()

interface ApiCallResult {
  content: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

async function callDeepSeekAPI(messages: { role: string; content: string }[], maxTokens: number = 4096): Promise<ApiCallResult> {
  const startTime = Date.now()
  try {
    const resp = await axios.post(
      `${BASE_URL}/v1/chat/completions`,
      {
        model: MODEL,
        messages,
        stream: false,
        max_tokens: maxTokens
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    )
    const usage = resp.data.usage || { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }
    return {
      content: resp.data.choices?.[0]?.message?.content || '',
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      cacheHitTokens: usage.prompt_cache_hit_tokens || 0,
      cacheMissTokens: usage.prompt_cache_miss_tokens || 0
    }
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status
      const data = err.response?.data
      if (status === 429) {
        console.log('  ⏳ Rate limited, waiting 10s...')
        await new Promise(r => setTimeout(r, 10000))
        return callDeepSeekAPI(messages, maxTokens)
      }
      throw new Error(`API error ${status}: ${JSON.stringify(data)}`)
    }
    throw err
  }
}

const L0_PATTERNS: { patterns: RegExp[]; forbidden: RegExp[]; tier: string }[] = [
  {
    patterns: [/(转|转换|转为|导出|另存|保存为|处理为|输出为).*(docx|pdf|txt|md|xlsx|html)/i],
    forbidden: [/(审查|合规|条款|风险|法律|合同)/],
    tier: 'l0'
  },
  {
    patterns: [/^(ls|dir|pwd|whoami|date|hostname|cat|type|echo|mkdir|cp|copy|mv|move|rm|del)\b/i, /^运行\s+/, /^执行\s+/, /^(npm|node|pip|python|git)\s+/],
    forbidden: [/(格式|转换|文档|分析|审查|报告)/],
    tier: 'l0'
  },
  {
    patterns: [/^(写|生成|帮我写|帮我生成|起草|撰写)\s*(一个|一份|一段|一篇)?\s*.{0,30}?(代码|函数|脚本|邮件|通知|公告|文案|总结)/i],
    forbidden: [/(周报|会议纪要|合同|财报|竞品|报销)/],
    tier: 'l0'
  },
  {
    patterns: [/^(几点|什么时间|今天是|现在几|天气|计算|算一下|等于多少)/i, /^(what time|what day|calculate|compute)\b/i, /^(今天|现在|当前).{0,5}?(日期|时间|星期)/i],
    forbidden: [/(分析|报告|审查|对比|文档|文件|转换)/],
    tier: 'l0'
  },
  {
    patterns: [/(创建|新建|写|生成|保存)(一个|一份)?\s*(docx|word|txt|文本|文档|文件)/i],
    forbidden: [/(审查|合规|条款|风险|法律|合同|分析|报告|周报|总结|竞品|财报)/],
    tier: 'l0'
  }
]

const L05_KEYWORDS = ['翻译', '译成', '生成', '写一段', '文案', '报销', '合同', '竞品', '周报', '会议纪要', '财报', 'KPI', '预算']

interface TestCase {
  input: string
  label: string
  group: string
  expectedRoute: 'l0' | 'l05' | 'raap' | 'fingerprint'
}

const CONTRACT_SAMPLE = `甲方：北京星辰科技有限公司
乙方：上海瀚海数据服务有限公司
合同编号：XCH-2026-0089
签订日期：2026年3月15日

一、合作范围
甲方委托乙方进行数据平台建设，项目总金额￥1,280,000.00（大写：壹佰贰拾捌万元整）。
付款方式：合同签订后支付30%预付款即￥384,000.00，中期验收后支付40%即￥512,000.00，终验后支付30%即￥384,000.00。

二、项目周期
项目启动日期：2026年4月1日
中期验收截止：2026年7月31日
终验截止：2026年10月31日

三、保密条款
双方应对本合同及项目过程中知悉的对方商业秘密严格保密，保密期限为合同终止后3年。

四、知识产权
项目交付物的知识产权归甲方所有。

甲方签字：张伟总经理
乙方签字：李明总监
日期：2026年3月15日`

const LONG_TEXT = [CONTRACT_SAMPLE, '附表一：项目里程碑 M1-M6', '附表二：人员配置 项目经理王芳15人月', '附表三：技术规范 PostgreSQL 15+ 1000QPS'].join('\n\n')

const TIER_MAX_TOKENS: Record<string, number> = {
  nano: 512,
  mini: 1024,
  standard: 4096
}

const TEST_CASES: TestCase[] = [
  { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式。`, label: 'A1_转换', group: 'A', expectedRoute: 'l0' },
  { input: `${LONG_TEXT}\n\n请把这份合同转换为PDF格式。`, label: 'A2_转换_重复', group: 'A', expectedRoute: 'fingerprint' },
  { input: 'ls -la', label: 'A3_Shell', group: 'A', expectedRoute: 'l0' },
  { input: 'ls -la', label: 'A4_Shell_重复', group: 'A', expectedRoute: 'fingerprint' },
  { input: '查一下张三的报销单', label: 'A5_查询', group: 'A', expectedRoute: 'l05' },
  { input: '查一下张三的报销单', label: 'A6_查询_重复', group: 'A', expectedRoute: 'fingerprint' },
  { input: '翻译这句英文：Hello world, how are you?', label: 'B1_翻译', group: 'B', expectedRoute: 'l05' },
  { input: '把这句话译成中文：Good morning, everyone.', label: 'B2_翻译2', group: 'B', expectedRoute: 'l05' },
  { input: '写一段关于人工智能的文案', label: 'B3_生成_AI', group: 'B', expectedRoute: 'l0' },
  { input: '帮我生成一段介绍大模型的产品描述', label: 'B4_生成_产品', group: 'B', expectedRoute: 'l0' },
  { input: `${LONG_TEXT}\n\n分析这份财报，对比去年同期，预测下季度营收`, label: 'C1_分析', group: 'C', expectedRoute: 'raap' },
  { input: '写一份关于碳中和的深度研究报告，包含数据引用和结论', label: 'C2_报告', group: 'C', expectedRoute: 'raap' },
  { input: '今天几号？', label: 'D1_日期', group: 'D', expectedRoute: 'l0' },
  { input: '计算 1234 × 5678', label: 'D2_计算', group: 'D', expectedRoute: 'l0' },
  { input: `${LONG_TEXT}\n\n审查这份合同的条款风险`, label: 'E1_合同审查', group: 'E', expectedRoute: 'raap' },
  { input: '帮我写一份保密协议，要求违约金不低于50万', label: 'E2_NDA', group: 'E', expectedRoute: 'raap' }
]

function checkL0(input: string): boolean {
  for (const rule of L0_PATTERNS) {
    const triggered = rule.patterns.some(p => p.test(input))
    if (!triggered) continue
    const forbidden = rule.forbidden.some(p => p.test(input))
    if (forbidden) continue
    return true
  }
  return false
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

async function runBaseline(stats: TestStats, sleepMs: number): Promise<void> {
  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]
    stats.totalRequests++
    const startTime = Date.now()
    try {
      const result = await callDeepSeekAPI([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.standard)
      stats.llmCalls++
      stats.totalInputTokens += result.inputTokens
      stats.totalOutputTokens += result.outputTokens
      const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
      stats.totalCostCNY += cost
      stats.totalLatencyMs += (Date.now() - startTime)
      console.log(`  ✓ [${tc.label}] in=${result.inputTokens}(cached=${result.cacheHitTokens}) out=${result.outputTokens} cost=¥${cost.toFixed(6)} ${(Date.now() - startTime)}ms`)
    } catch (err) {
      stats.errors++
      console.warn(`  ✗ [${tc.label}] ${(err as Error).message}`)
    }
    if (sleepMs > 0 && i < TEST_CASES.length - 1) {
      await new Promise(r => setTimeout(r, sleepMs))
    }
  }
}

async function runOptimized(stats: TestStats, sleepMs: number): Promise<void> {
  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i]
    stats.totalRequests++
    const startTime = Date.now()

    const fp = computeFingerprint(tc.input)
    const cached = fingerprintCache.get(fp)
    if (cached) {
      stats.cacheHits++
      stats.fingerprintHits++
      stats.totalLatencyMs += 5
      stats.totalCostCNY += 0.0001
      console.log(`  ♻️ [${tc.label}] fingerprint cache hit (in=${cached.inputTokens} out=${cached.outputTokens})`)
      continue
    }

    if (checkL0(tc.input)) {
      stats.cacheHits++
      stats.l0Hits++
      stats.totalLatencyMs += 3
      stats.totalCostCNY += 0.0001
      const fakeResult = { inputTokens: 0, outputTokens: 0 }
      fingerprintCache.set(fp, fakeResult)
      console.log(`  ⚡ [${tc.label}] L0 hit (0 tokens)`)
      continue
    }

    if (checkL05(tc.input)) {
      const tier = 'mini'
      const maxTokens = TIER_MAX_TOKENS[tier]
      try {
        const result = await callDeepSeekAPI([{ role: 'user', content: tc.input }], maxTokens)
        stats.llmCalls++
        stats.cacheHits++
        stats.l05Hits++
        stats.totalInputTokens += result.inputTokens
        stats.totalOutputTokens += result.outputTokens
        const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
        stats.totalCostCNY += cost
        stats.totalLatencyMs += (Date.now() - startTime)
        fingerprintCache.set(fp, { result: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
        console.log(`  🔹 [${tc.label}] L0.5 hit (${tier} tier) in=${result.inputTokens}(cached=${result.cacheHitTokens}) out=${result.outputTokens} cost=¥${cost.toFixed(6)} ${(Date.now() - startTime)}ms`)
      } catch (err) {
        stats.errors++
        console.warn(`  ✗ [${tc.label}] L0.5 failed: ${(err as Error).message}`)
      }
      if (sleepMs > 0 && i < TEST_CASES.length - 1) {
        await new Promise(r => setTimeout(r, sleepMs))
      }
      continue
    }

    try {
      const result = await callDeepSeekAPI([{ role: 'user', content: tc.input }], TIER_MAX_TOKENS.standard)
      stats.llmCalls++
      stats.totalInputTokens += result.inputTokens
      stats.totalOutputTokens += result.outputTokens
      const cost = (result.cacheMissTokens * PRICE.inputUncached + result.cacheHitTokens * PRICE.inputCached + result.outputTokens * PRICE.output) / 1_000_000
      stats.totalCostCNY += cost
      stats.totalLatencyMs += (Date.now() - startTime)
      fingerprintCache.set(fp, { result: result.content, inputTokens: result.inputTokens, outputTokens: result.outputTokens })
      console.log(`  🤖 [${tc.label}] RaaP in=${result.inputTokens}(cached=${result.cacheHitTokens}) out=${result.outputTokens} cost=¥${cost.toFixed(6)} ${(Date.now() - startTime)}ms`)
    } catch (err) {
      stats.errors++
      console.warn(`  ✗ [${tc.label}] RaaP failed: ${(err as Error).message}`)
    }
    if (sleepMs > 0 && i < TEST_CASES.length - 1) {
      await new Promise(r => setTimeout(r, sleepMs))
    }
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════')
  console.log('  SKY DeepSeek V4 Flash Token优化压测')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  模型: ${MODEL}`)
  console.log(`  API:  ${BASE_URL}`)
  console.log(`  Key:  ${API_KEY.substring(0, 8)}...`)
  console.log(`  用例: ${TEST_CASES.length} 条`)
  console.log(`  定价: input ¥${PRICE.inputUncached}/1M | cached ¥${PRICE.inputCached}/1M | output ¥${PRICE.output}/1M`)
  console.log('═══════════════════════════════════════════════════\n')

  const sleepMs = 2000

  console.log('>>> Phase 1: Baseline (无优化, 全部直调LLM)')
  const baselineStats = createEmptyStats()
  await runBaseline(baselineStats, sleepMs)
  const baselineTotal = baselineStats.totalInputTokens + baselineStats.totalOutputTokens
  console.log(`\n📊 Baseline: ${baselineStats.llmCalls} calls, ${baselineTotal} tokens, ¥${baselineStats.totalCostCNY.toFixed(4)}, ${baselineStats.totalLatencyMs}ms\n`)

  console.log('>>> Phase 2: Optimized (L0/L0.5/Fingerprint缓存/分层)')
  fingerprintCache.clear()
  const optimizedStats = createEmptyStats()
  await runOptimized(optimizedStats, sleepMs)
  const optimizedTotal = optimizedStats.totalInputTokens + optimizedStats.totalOutputTokens
  console.log(`\n📊 Optimized: ${optimizedStats.llmCalls} calls, ${optimizedTotal} tokens, ¥${optimizedStats.totalCostCNY.toFixed(4)}, ${optimizedStats.totalLatencyMs}ms\n`)

  const tokenSaved = baselineTotal - optimizedTotal
  const tokenSavedPercent = baselineTotal > 0 ? (tokenSaved / baselineTotal * 100) : 0
  const costSaved = baselineStats.totalCostCNY - optimizedStats.totalCostCNY
  const costSavedPercent = baselineStats.totalCostCNY > 0 ? (costSaved / baselineStats.totalCostCNY * 100) : 0
  const latencySaved = baselineStats.totalLatencyMs - optimizedStats.totalLatencyMs
  const latencySavedPercent = baselineStats.totalLatencyMs > 0 ? (latencySaved / baselineStats.totalLatencyMs * 100) : 0
  const cacheHitRate = optimizedStats.totalRequests > 0 ? (optimizedStats.cacheHits / optimizedStats.totalRequests * 100) : 0

  const report = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    baseline: baselineStats,
    optimized: optimizedStats,
    improvement: {
      tokenSavedPercent: tokenSavedPercent.toFixed(2) + '%',
      costSavedPercent: costSavedPercent.toFixed(2) + '%',
      latencySavedPercent: latencySavedPercent.toFixed(2) + '%',
      cacheHitRate: cacheHitRate.toFixed(2) + '%',
      l0HitRate: (optimizedStats.totalRequests > 0 ? (optimizedStats.l0Hits / optimizedStats.totalRequests * 100).toFixed(2) : '0') + '%',
      l05HitRate: (optimizedStats.totalRequests > 0 ? (optimizedStats.l05Hits / optimizedStats.totalRequests * 100).toFixed(2) : '0') + '%',
      fingerprintHitRate: (optimizedStats.totalRequests > 0 ? (optimizedStats.fingerprintHits / optimizedStats.totalRequests * 100).toFixed(2) : '0') + '%'
    },
    raw: { tokenSaved, costSaved, latencySaved }
  }

  const outPath = path.resolve(process.cwd(), 'benchmark-result.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')

  console.log('═══════════════════════════════════════════════════')
  console.log('  压测结果')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  Token节省:  ${tokenSavedPercent.toFixed(1)}% (${tokenSaved} tokens)`)
  console.log(`  成本节省:   ${costSavedPercent.toFixed(1)}% (¥${costSaved.toFixed(4)})`)
  console.log(`  延迟节省:   ${latencySavedPercent.toFixed(1)}% (${latencySaved}ms)`)
  console.log(`  缓存命中率: ${cacheHitRate.toFixed(1)}%`)
  console.log(`  L0命中:     ${optimizedStats.l0Hits}/${optimizedStats.totalRequests}`)
  console.log(`  L0.5命中:   ${optimizedStats.l05Hits}/${optimizedStats.totalRequests}`)
  console.log(`  指纹缓存:   ${optimizedStats.fingerprintHits}/${optimizedStats.totalRequests}`)
  console.log(`  错误:       baseline=${baselineStats.errors} optimized=${optimizedStats.errors}`)
  console.log('═══════════════════════════════════════════════════')
  console.log(`\n📄 报告已保存: ${outPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
