import axios from 'axios'

const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')

async function main() {
  const startTime = Date.now()
  let ttft = 0
  let first = false
  let content = ''
  let usage: Record<string, number> = {}

  const resp = await axios.post(`${BASE_URL}/v1/chat/completions`, {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'What is 2+2? Reply in one sentence.' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 128
  }, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
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
          if (!first && p.choices?.[0]?.delta?.content) {
            ttft = Date.now() - startTime
            first = true
          }
          if (p.choices?.[0]?.delta?.content) content += p.choices[0].delta.content
          if (p.usage) usage = p.usage
        } catch { /* skip */ }
      }
    })
    resp.data.on('end', resolve)
    resp.data.on('error', reject)
  })

  console.log('TTFT:', ttft, 'ms')
  console.log('Content:', content.slice(0, 200))
  console.log('Usage:', JSON.stringify(usage))
  console.log('Total time:', Date.now() - startTime, 'ms')
}

main().catch(console.error)
