import axios from 'axios'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

if (!API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY 未设置')
  process.exit(1)
}

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  DeepSeek API 单调用验证')
  console.log('═══════════════════════════════════════════')
  console.log(`  Model:   ${MODEL}`)
  console.log(`  BaseURL: ${BASE_URL}`)
  console.log(`  Key:     ${API_KEY.substring(0, 8)}...`)
  console.log()

  const prompt = '请用一句话介绍人工智能。'

  console.log(`>>> 发送请求: "${prompt}"`)
  const startTime = Date.now()

  const resp = await axios.post(
    `${BASE_URL}/v1/chat/completions`,
    {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 200
    },
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  )

  const elapsed = Date.now() - startTime

  console.log(`\n>>> 完整响应体 (status ${resp.status}):\n`)
  console.log(JSON.stringify(resp.data, null, 2))

  console.log('\n═══════════════════════════════════════════')
  console.log('  Usage 分析')
  console.log('═══════════════════════════════════════════')

  const usage = resp.data.usage || {}
  console.log(`  prompt_tokens:            ${usage.prompt_tokens ?? 'N/A'}`)
  console.log(`  completion_tokens:        ${usage.completion_tokens ?? 'N/A'}`)
  console.log(`  total_tokens:             ${usage.total_tokens ?? 'N/A'}`)
  console.log(`  prompt_cache_hit_tokens:  ${usage.prompt_cache_hit_tokens ?? 'N/A'}`)
  console.log(`  prompt_cache_miss_tokens: ${usage.prompt_cache_miss_tokens ?? 'N/A'}`)

  const inTokens = usage.prompt_tokens || 0
  const outTokens = usage.completion_tokens || 0
  const cacheHitTokens = usage.prompt_cache_hit_tokens || 0
  const cacheMissTokens = usage.prompt_cache_miss_tokens || 0

  const costV1 = (inTokens * 1.0 + outTokens * 2.0) / 1_000_000
  const costV2 = (cacheMissTokens * 1.0 + cacheHitTokens * 0.02 + outTokens * 2.0) / 1_000_000

  console.log()
  console.log(`  旧算法(全量input按¥1/1M):  ¥${costV1.toFixed(6)}`)
  console.log(`  新算法(缓存input按¥0.02/1M): ¥${costV2.toFixed(6)}`)
  console.log(`  延迟: ${elapsed}ms`)
  console.log()
  console.log('>>> 请立刻打开 https://platform.deepseek.com/usage 查看本次调用的费用')
  console('>>> 对比上面的计算值，确认真实计费公式')
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
