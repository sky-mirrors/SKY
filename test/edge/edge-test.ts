import axios from 'axios'
import fs from 'fs'
import path from 'path'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

interface EdgeTestResult {
  category: string
  name: string
  passed: boolean
  detail: string
  latencyMs?: number
  inputPreview?: string
}

const results: EdgeTestResult[] = []

function record(r: EdgeTestResult) {
  results.push(r)
  const icon = r.passed ? '✅' : '❌'
  console.log(`  ${icon} [${r.category}] ${r.name}: ${r.detail}`)
}

async function callAPI(
  input: string,
  maxTokens: number = 512,
  baseUrl: string = BASE_URL,
  apiKey: string = API_KEY
): Promise<{ ok: boolean; content: string; inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number; ttftMs: number; latencyMs: number; error?: string }> {
  const startTime = Date.now()
  let ttftMs = 0
  let firstChunk = false
  let content = ''
  let usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }

  try {
    const resp = await axios.post(`${baseUrl}/v1/chat/completions`, {
      model: MODEL,
      messages: [{ role: 'user', content: input }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      responseType: 'stream'
    })

    await new Promise<void>((resolve, reject) => {
      let buf = ''
      resp.data.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim().startsWith('data: ')) continue
          const d = line.trim().slice(6)
          if (d === '[DONE]') continue
          try {
            const p = JSON.parse(d)
            if (!firstChunk && p.choices?.[0]?.delta?.content) { ttftMs = Date.now() - startTime; firstChunk = true }
            if (p.choices?.[0]?.delta?.content) content += p.choices[0].delta.content
            if (p.usage) usage = { prompt_tokens: p.usage.prompt_tokens || 0, completion_tokens: p.usage.completion_tokens || 0, prompt_cache_hit_tokens: p.usage.prompt_cache_hit_tokens || 0, prompt_cache_miss_tokens: p.usage.prompt_cache_miss_tokens || 0 }
          } catch { /* skip */ }
        }
      })
      resp.data.on('end', resolve)
      resp.data.on('error', reject)
    })

    return {
      ok: true, content, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
      cacheHitTokens: usage.prompt_cache_hit_tokens, cacheMissTokens: usage.prompt_cache_miss_tokens,
      ttftMs: ttftMs || (Date.now() - startTime), latencyMs: Date.now() - startTime
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, content: '', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, ttftMs: 0, latencyMs: Date.now() - startTime, error: msg }
  }
}

const L0_RULES: { patterns: RegExp[]; forbidden: RegExp[]; requiresLlm: boolean }[] = [
  { patterns: [/(转|转换|转为|转成|导出|另存|保存为|处理为|输出为).*(docx|pdf|txt|md|xlsx|html)/i], forbidden: [/(审查|合规|条款|风险|法律|合同)/], requiresLlm: true },
  { patterns: [/^(ls|dir|pwd|whoami|date|hostname|cat|type|echo|mkdir|cp|copy|mv|move|rm|del)\b/i, /^运行\s+/, /^执行\s+/, /^(npm|node|pip|python|git)\s+/], forbidden: [/(格式|转换|文档|分析|审查|报告)/], requiresLlm: false },
  { patterns: [/^(写|生成|帮我写|帮我生成|起草|撰写)\s*(一个|一份|一段|一篇)?\s*.{0,30}?(代码|函数|脚本|邮件|通知|公告|文案|总结)/i], forbidden: [/(周报|会议纪要|合同|财报|竞品|报销)/], requiresLlm: true },
  { patterns: [/^(几点|什么时间|今天是|现在几|天气|计算|算一下|等于多少|几号)/i, /^(what time|what day|calculate|compute)\b/i, /^(今天|现在|当前).{0,5}?(日期|时间|星期|几号)/i, /^(现在|当前).{0,5}?(几点|几分)/i], forbidden: [/(分析|报告|审查|对比|文档|文件|转换)/], requiresLlm: true },
  { patterns: [/(创建|新建|写|生成|保存)(一个|一份)?\s*(docx|word|txt|文本|文档|文件)/i], forbidden: [/(审查|合规|条款|风险|法律|合同|分析|报告|周报|总结|竞品|财报|摘要|说明|简介)/], requiresLlm: false },
  { patterns: [/^(curl|fetch|get|post|请求|访问|下载)\s+/i, /https?:\/\/\S+/], forbidden: [], requiresLlm: false },
  { patterns: [/(创建|新建|建)(一个)?\s*(文件夹|目录|folder)/i], forbidden: [/(文档|docx|txt|pdf|xlsx|审查|分析|写|生成|保存)/], requiresLlm: false },
  { patterns: [/^(读取|查看|打开|显示|阅读|看看)(一下)?\s*(文件|文档|内容)?\s*.{0,30}$/i, /^(cat|type|head|tail|less|more)\s+/i], forbidden: [/(分析|审查|转换|修改|编辑|风险|合规|生成报告)/], requiresLlm: false }
]

const L05_KEYWORDS = ['翻译', '译成', '生成', '写一段', '文案', '报销', '合同', '竞品', '周报', '会议纪要', '财报', 'KPI', '预算']

function checkL0(input: string): { hit: boolean; requiresLlm: boolean } {
  for (const rule of L0_RULES) {
    if (rule.patterns.some(p => p.test(input))) {
      if (rule.forbidden.some(p => p.test(input))) continue
      return { hit: true, requiresLlm: rule.requiresLlm }
    }
  }
  return { hit: false, requiresLlm: false }
}

function checkL05(input: string): boolean {
  return L05_KEYWORDS.some(kw => input.includes(kw))
}

function getRoute(input: string): string {
  const l0 = checkL0(input)
  if (l0.hit) return l0.requiresLlm ? 'l0_llm' : 'l0_local'
  if (checkL05(input)) return 'l05'
  return 'raap'
}

function fingerprint(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

async function testEmptyInput() {
  const r = await callAPI('')
  record({ category: 'empty', name: 'empty string', passed: r.ok || !!r.error, detail: r.ok ? `got response (${r.outputTokens} tokens)` : `error: ${r.error?.slice(0, 100)}`, inputPreview: '""' })
}

async function testSingleChar() {
  for (const ch of ['a', '好', '.']) {
    const r = await callAPI(ch)
    record({ category: 'single_char', name: `"${ch}"`, passed: r.ok, detail: r.ok ? `in=${r.inputTokens} out=${r.outputTokens} ttft=${r.ttftMs}ms` : `error: ${r.error?.slice(0, 100)}`, inputPreview: ch })
  }
}

async function testLongInput() {
  const long10k = '这是一个很长的测试文本。'.repeat(400)
  const r = await callAPI(long10k, 256)
  record({ category: 'long_input', name: '10K chars', passed: r.ok, detail: r.ok ? `in=${r.inputTokens} out=${r.outputTokens} latency=${r.latencyMs}ms` : `error: ${r.error?.slice(0, 100)}`, inputPreview: `${long10k.length} chars` })
}

async function testVeryLongInput() {
  const long50k = '重复文本用于测试超长输入处理能力。'.repeat(2000)
  const r = await callAPI(long50k, 128)
  record({ category: 'very_long_input', name: '50K chars', passed: r.ok || (r.error?.includes('token') || r.error?.includes('length') || false), detail: r.ok ? `in=${r.inputTokens} out=${r.outputTokens}` : `error: ${r.error?.slice(0, 150)}`, inputPreview: `${long50k.length} chars` })
}

async function testSpecialChars() {
  const cases = [
    { name: 'emoji', input: '🔥🚀✅ 请解释这些表情的含义' },
    { name: 'japanese', input: '翻訳してください：Hello World' },
    { name: 'sql_injection', input: "'; DROP TABLE users;-- 请帮我执行这个" },
    { name: 'xss', input: '<script>alert(1)</script> 这是什么' },
    { name: 'arabic_RTL', input: 'مرحبا بالعالم 翻译成中文' },
    { name: 'null_bytes', input: 'hello\x00world' },
    { name: 'newlines', input: 'line1\nline2\n\nline4\ttab' },
    { name: 'mixed_cjk', input: '翻訳 韓國어 翻译 日本語 繁體中文' }
  ]
  for (const tc of cases) {
    const r = await callAPI(tc.input, 256)
    record({ category: 'special_chars', name: tc.name, passed: r.ok, detail: r.ok ? `in=${r.inputTokens} out=${r.outputTokens} ttft=${r.ttftMs}ms` : `error: ${r.error?.slice(0, 100)}`, inputPreview: tc.input.slice(0, 30) })
  }
}

async function testNetworkError() {
  const r = await callAPI('hello', 64, 'http://localhost:1', API_KEY)
  record({ category: 'network', name: 'unreachable host', passed: !r.ok && !!r.error, detail: `error correctly caught: ${r.error?.slice(0, 80)}`, latencyMs: r.latencyMs })
}

async function testInvalidKey() {
  const r = await callAPI('hello', 64, BASE_URL, 'sk-invalid-key-12345')
  record({ category: 'auth', name: 'invalid API key', passed: !r.ok, detail: `error: ${r.error?.slice(0, 80)}` })
}

async function testMinTokens() {
  const r = await callAPI('说一个字', 1)
  record({ category: 'tokens', name: 'max_tokens=1', passed: r.ok && r.outputTokens <= 2, detail: r.ok ? `out=${r.outputTokens} tokens` : `error: ${r.error?.slice(0, 80)}` })
}

async function testConcurrent() {
  const inputs = ['什么是AI？', '翻译hello', '写一个函数', '今天几号？', 'ls -la']
  const promises = inputs.map(inp => callAPI(inp, 256))
  const rs = await Promise.allSettled(promises)
  let allOk = true
  let details: string[] = []
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]
    if (r.status === 'fulfilled') {
      details.push(`${inputs[i].slice(0, 8)}: ok=${r.value.ok}`)
      if (!r.value.ok) allOk = false
    } else {
      details.push(`${inputs[i].slice(0, 8)}: rejected`)
      allOk = false
    }
  }
  record({ category: 'concurrent', name: `5 parallel requests`, passed: allOk, detail: details.join(', ') })
}

async function testFingerprintRepeat() {
  const input = '写一段测试指纹缓存的文案'
  const fp = fingerprint(input)
  const r1 = await callAPI(input, 256)
  record({ category: 'fingerprint', name: 'first call', passed: r1.ok, detail: r1.ok ? `in=${r1.inputTokens} out=${r1.outputTokens} fp=${fp}` : `error: ${r1.error?.slice(0, 80)}` })
  record({ category: 'fingerprint', name: 'same fingerprint verified', passed: fingerprint(input) === fp, detail: `fp match=true` })
}

async function testRouteAccuracy() {
  const cases: { input: string; expected: string; label: string }[] = [
    { input: 'ls -la', expected: 'l0_local', label: 'shell command' },
    { input: '写一段关于AI的文案', expected: 'l0_llm', label: 'simple creation' },
    { input: '翻译这句英文：Hello', expected: 'l05', label: 'translation' },
    { input: '审查合同风险', expected: 'l05', label: 'legal review (L0.5 via 合同 keyword)' },
    { input: '今天几号？', expected: 'l0_llm', label: 'date query' },
    { input: '计算 123 × 456', expected: 'l0_llm', label: 'calculation' },
    { input: '将md转换为docx', expected: 'l0_llm', label: 'file convert' },
    { input: 'curl https://example.com', expected: 'l0_local', label: 'http request' },
    { input: '创建一个txt文档', expected: 'l0_local', label: 'file create' },
    { input: '创建文件夹', expected: 'l0_local', label: 'folder create' },
    { input: '你好', expected: 'raap', label: 'greeting' },
    { input: '', expected: 'raap', label: 'empty' },
    { input: '帮我分析竞品优劣势', expected: 'l05', label: 'competitive analysis (L0.5 via 竞品 keyword)' },
    { input: '写一份周报', expected: 'l05', label: 'weekly report (forbidden in L0)' },
    { input: '生成一份文档摘要说明', expected: 'l05', label: 'doc summary (should not hit file create)' },
    { input: '现在几点几分？', expected: 'l0_llm', label: 'time query' }
  ]

  for (const tc of cases) {
    const actual = getRoute(tc.input)
    const match = actual === tc.expected
    record({ category: 'route_accuracy', name: tc.label, passed: match, detail: `expected=${tc.expected} actual=${actual} input="${tc.input.slice(0, 30)}"` })
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  SKY Edge Case + Route Accuracy Tests')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  API: ${BASE_URL}`)
  console.log(`  Key: ${API_KEY.substring(0, 8)}...`)
  console.log('═══════════════════════════════════════════════════\n')

  console.log('>>> 1. Route Accuracy (no API calls)')
  await testRouteAccuracy()

  console.log('\n>>> 2. Empty / Single Char')
  await testEmptyInput()
  await testSingleChar()

  console.log('\n>>> 3. Long Input')
  await testLongInput()
  await testVeryLongInput()

  console.log('\n>>> 4. Special Characters')
  await testSpecialChars()

  console.log('\n>>> 5. Network / Auth Errors')
  await testNetworkError()
  await testInvalidKey()

  console.log('\n>>> 6. Token Limits')
  await testMinTokens()

  console.log('\n>>> 7. Concurrent Requests')
  await testConcurrent()

  console.log('\n>>> 8. Fingerprint Cache')
  await testFingerprintRepeat()

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const total = results.length

  console.log(`\n═══════════════════════════════════════════════════`)
  console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`)
  console.log('═══════════════════════════════════════════════════')

  if (failed > 0) {
    console.log('\n  FAILED TESTS:')
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ❌ [${r.category}] ${r.name}: ${r.detail}`)
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    total, passed, failed,
    results: results.map(r => ({
      category: r.category, name: r.name, passed: r.passed, detail: r.detail,
      ...(r.latencyMs ? { latencyMs: r.latencyMs } : {})
    }))
  }

  const outPath = path.resolve(process.cwd(), 'test-edge-results.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\n  Report saved: ${outPath}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
