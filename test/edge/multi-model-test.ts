import axios from 'axios'
import fs from 'fs'
import path from 'path'

interface ProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  chatFormat: 'openai' | 'anthropic'
  headerKey: string
}

const providers: ProviderConfig[] = []

if (process.env.DEEPSEEK_API_KEY) {
  providers.push({
    name: 'DeepSeek V4 Flash',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    chatFormat: 'openai',
    headerKey: 'Authorization'
  })
}

if (process.env.OPENAI_API_KEY) {
  providers.push({
    name: 'GPT-4.1 Mini',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, ''),
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    chatFormat: 'openai',
    headerKey: 'Authorization'
  })
}

if (process.env.ANTHROPIC_API_KEY) {
  providers.push({
    name: 'Claude 3.5 Haiku',
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022',
    chatFormat: 'anthropic',
    headerKey: 'x-api-key'
  })
}

interface ModelTestResult {
  provider: string
  testCase: string
  passed: boolean
  detail: string
  inputTokens: number
  outputTokens: number
  ttftMs: number
  latencyMs: number
  hasUsage: boolean
  hasCacheInfo: boolean
  contentLength: number
}

const results: ModelTestResult[] = []

const TEST_CASES = [
  { label: '简单问答', input: '什么是人工智能？用一句话回答' },
  { label: '翻译', input: '翻译这句英文：Hello World' },
  { label: '代码生成', input: '写一个JavaScript防抖函数' },
  { label: 'Shell命令', input: 'ls -la' },
  { label: '格式转换', input: '将md转换为docx' },
  { label: '合同审查', input: '审查这份合同的条款风险' },
  { label: '长文本', input: '详细解释Transformer架构的注意力机制原理' },
  { label: '中文理解', input: '解释"一石二鸟"这个成语的含义和用法' },
  { label: '数学计算', input: '计算 1234 × 5678' },
  { label: '日期查询', input: '今天几号？' },
  { label: 'emoji输入', input: '🔥🚀 解释这些表情' },
  { label: '混合语言', input: 'Translate to 中文: Machine learning is transforming every industry.' }
]

async function callProvider(provider: ProviderConfig, input: string, maxTokens: number = 512): Promise<ModelTestResult> {
  const startTime = Date.now()
  let ttftMs = 0
  let firstChunk = false
  let content = ''
  let hasUsage = false
  let hasCacheInfo = false
  let inputTokens = 0
  let outputTokens = 0

  try {
    if (provider.chatFormat === 'anthropic') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01'
      }
      const resp = await axios.post(`${provider.baseUrl}/v1/messages`, {
        model: provider.model,
        messages: [{ role: 'user', content: input }],
        max_tokens: maxTokens,
        stream: true
      }, { headers, timeout: 60000, responseType: 'stream' })

      await new Promise<void>((resolve, reject) => {
        let buf = ''
        resp.data.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('event: ') && !line.startsWith('data: ')) continue
            if (line.startsWith('data: ')) {
              const d = line.slice(6)
              try {
                const p = JSON.parse(d)
                if (p.type === 'content_block_delta' && p.delta?.text) {
                  if (!firstChunk) { ttftMs = Date.now() - startTime; firstChunk = true }
                  content += p.delta.text
                }
                if (p.type === 'message_start' && p.message?.usage) {
                  inputTokens = p.message.usage.input_tokens || 0
                  hasUsage = true
                }
                if (p.type === 'message_delta' && p.usage) {
                  outputTokens = p.usage.output_tokens || 0
                }
              } catch { /* skip */ }
            }
          }
        })
        resp.data.on('end', resolve)
        resp.data.on('error', reject)
      })

      hasCacheInfo = false
    } else {
      const resp = await axios.post(`${provider.baseUrl}/v1/chat/completions`, {
        model: provider.model,
        messages: [{ role: 'user', content: input }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens
      }, {
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
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
              if (p.usage) {
                inputTokens = p.usage.prompt_tokens || 0
                outputTokens = p.usage.completion_tokens || 0
                hasUsage = true
                if (p.usage.prompt_cache_hit_tokens !== undefined || p.usage.prompt_tokens_details?.cached_tokens !== undefined) {
                  hasCacheInfo = true
                }
              }
            } catch { /* skip */ }
          }
        })
        resp.data.on('end', resolve)
        resp.data.on('error', reject)
      })
    }

    return {
      provider: provider.name, testCase: '', passed: true,
      detail: 'OK', inputTokens, outputTokens,
      ttftMs: ttftMs || (Date.now() - startTime), latencyMs: Date.now() - startTime,
      hasUsage, hasCacheInfo, contentLength: content.length
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      provider: provider.name, testCase: '', passed: false,
      detail: msg.slice(0, 150), inputTokens: 0, outputTokens: 0,
      ttftMs: 0, latencyMs: Date.now() - startTime,
      hasUsage: false, hasCacheInfo: false, contentLength: 0
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  SKY Multi-Model Compatibility Tests')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  Providers: ${providers.map(p => p.name).join(', ') || 'NONE (set API keys as env vars)'}`)
  console.log(`  Test cases: ${TEST_CASES.length}`)
  console.log('═══════════════════════════════════════════════════\n')

  if (providers.length === 0) {
    console.error('No API keys configured. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.')
    process.exit(1)
  }

  for (const provider of providers) {
    console.log(`\n>>> Testing: ${provider.name} (${provider.model})`)

    for (const tc of TEST_CASES) {
      const r = await callProvider(provider, tc.input)
      r.testCase = tc.label
      results.push(r)
      const icon = r.passed ? '✅' : '❌'
      console.log(`  ${icon} [${tc.label}] in=${r.inputTokens} out=${r.outputTokens} ttft=${r.ttftMs}ms latency=${r.latencyMs}ms usage=${r.hasUsage} cache=${r.hasCacheInfo} content=${r.contentLength}`)

      await new Promise(resolve => setTimeout(resolve, 1500))
    }

    const providerResults = results.filter(r => r.provider === provider.name)
    const passed = providerResults.filter(r => r.passed).length
    const total = providerResults.length
    const avgTtft = providerResults.filter(r => r.passed).reduce((s, r) => s + r.ttftMs, 0) / (passed || 1)
    const usageRate = providerResults.filter(r => r.hasUsage).length / (total || 1)
    const cacheRate = providerResults.filter(r => r.hasCacheInfo).length / (total || 1)

    console.log(`\n  ${provider.name} summary: ${passed}/${total} passed, avg_ttft=${Math.round(avgTtft)}ms, usage_available=${(usageRate * 100).toFixed(0)}%, cache_info=${(cacheRate * 100).toFixed(0)}%`)
  }

  const report = {
    timestamp: new Date().toISOString(),
    providers: providers.map(p => ({ name: p.name, model: p.model, format: p.chatFormat })),
    testCases: TEST_CASES.length,
    results: results,
    summary: providers.map(p => {
      const pr = results.filter(r => r.provider === p.name)
      const passed = pr.filter(r => r.passed).length
      return {
        provider: p.name,
        passRate: `${passed}/${pr.length}`,
        avgTtftMs: Math.round(pr.filter(r => r.passed).reduce((s, r) => s + r.ttftMs, 0) / (passed || 1)),
        usageAvailable: pr.filter(r => r.hasUsage).length === pr.length,
        cacheInfoAvailable: pr.filter(r => r.hasCacheInfo).length
      }
    })
  }

  const outPath = path.resolve(process.cwd(), 'test-multi-model-results.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`\n  Report saved: ${outPath}`)

  const totalPassed = results.filter(r => r.passed).length
  const totalTests = results.length
  process.exit(totalPassed === totalTests ? 0 : 1)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
