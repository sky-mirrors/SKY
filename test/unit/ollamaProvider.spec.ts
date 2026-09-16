import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  OLLAMA_DEFAULT_BASE,
  isOllamaFormat,
  probeOllama,
  ollamaChat,
  ollamaChatStream,
  OllamaProbeResult
} from '@/services/ollamaProvider'
import { extractOllamaDelta, readNDJSONStream } from '@/services/sseParser'

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    }
  })
}

describe('M17 extractOllamaDelta', () => {
  it('解析内容行', () => {
    const d = extractOllamaDelta('{"model":"llama3.2","message":{"role":"assistant","content":"你好"},"done":false}')
    expect(d).toEqual({ content: '你好', done: false })
  })

  it('解析 done 行并映射 usage 计数', () => {
    const d = extractOllamaDelta('{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":26,"eval_count":283}')
    expect(d?.done).toBe(true)
    expect(d?.usage?.promptTokens).toBe(26)
    expect(d?.usage?.completionTokens).toBe(283)
  })

  it('done 行缺计数字段回退 0', () => {
    const d = extractOllamaDelta('{"message":{"content":""},"done":true}')
    expect(d?.usage?.promptTokens).toBe(0)
    expect(d?.usage?.completionTokens).toBe(0)
  })

  it('空行 / 非法 JSON / 空内容行返回 null', () => {
    expect(extractOllamaDelta('')).toBeNull()
    expect(extractOllamaDelta('   ')).toBeNull()
    expect(extractOllamaDelta('not json')).toBeNull()
    expect(extractOllamaDelta('{"message":{"content":""},"done":false}')).toBeNull()
  })
})

describe('M17 readNDJSONStream', () => {
  it('多 chunk 分帧解析且 done 行收尾', async () => {
    const deltas: string[] = []
    let sawDone = false
    await readNDJSONStream(streamFromChunks([
      '{"message":{"content":"Hel"},"done":false}\n{"mess',
      'age":{"content":"lo 世界"},"done":false}\r\n{"message":{"content":""},"done":true,"prompt_eval_count":5,"eval_count":7}\n'
    ]), (d) => {
      if (d.content) deltas.push(d.content)
      if (d.done) sawDone = true
    })
    expect(deltas).toEqual(['Hel', 'lo 世界'])
    expect(sawDone).toBe(true)
  })

  it('流自然结束无 done 行时补发 done', async () => {
    const deltas: unknown[] = []
    await readNDJSONStream(streamFromChunks(['{"message":{"content":"x"},"done":false}\n']), (d) => deltas.push(d))
    expect(deltas.length).toBe(2)
    expect((deltas[1] as { done: boolean }).done).toBe(true)
  })

  it('abort 信号中断且不再发射', async () => {
    const controller = new AbortController()
    controller.abort()
    const deltas: unknown[] = []
    await readNDJSONStream(streamFromChunks(['{"message":{"content":"x"},"done":false}\n']), (d) => deltas.push(d), controller.signal)
    expect(deltas).toHaveLength(0)
  })
})

describe('M17 ollamaProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('isOllamaFormat / 默认端点', () => {
    expect(isOllamaFormat('ollama')).toBe(true)
    expect(isOllamaFormat('openai')).toBe(false)
    expect(isOllamaFormat(undefined)).toBe(false)
    expect(OLLAMA_DEFAULT_BASE).toBe('http://127.0.0.1:11434')
  })

  it('probeOllama: /api/tags 200 → ok + 模型清单', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { model: 'qwen2.5:7b' }] }), { status: 200 })
    )
    const r: OllamaProbeResult = await probeOllama(OLLAMA_DEFAULT_BASE)
    expect(r.ok).toBe(true)
    expect(r.models.map(m => m.id)).toEqual(['llama3.2:latest', 'qwen2.5:7b'])
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('probeOllama: 非 200 / 网络失败 → {ok:false} 不抛', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('err', { status: 500 }))
    const r1 = await probeOllama(OLLAMA_DEFAULT_BASE)
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('500')

    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError('fetch failed'))
    const r2 = await probeOllama(OLLAMA_DEFAULT_BASE)
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('fetch failed')
  })

  it('ollamaChat: stream:false 单 JSON 响应解析 + 请求体形态', async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(
      JSON.stringify({ message: { role: 'assistant', content: '本地回答' }, prompt_eval_count: 11, eval_count: 22, done: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ))
    const r = await ollamaChat(OLLAMA_DEFAULT_BASE, 'llama3.2', [{ role: 'user', content: 'hi' }], 512)
    expect(r.content).toBe('本地回答')
    expect(r.usage.totalTokens).toBe(33)
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/chat')
    const body = JSON.parse(String(init.body))
    expect(body.stream).toBe(false)
    expect(body.model).toBe('llama3.2')
    expect(body.options.num_predict).toBe(512)
  })

  it('ollamaChat: 5xx 抛错含状态码', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('boom', { status: 503 }))
    await expect(ollamaChat(OLLAMA_DEFAULT_BASE, 'llama3.2', [{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Ollama API error 503')
  })

  it('ollamaChatStream: NDJSON 流逐行发射 + 末行 usage', async () => {
    const ndjson = [
      '{"message":{"content":"a"},"done":false}',
      '{"message":{"content":"b"},"done":false}',
      '{"message":{"content":""},"done":true,"prompt_eval_count":3,"eval_count":9}'
    ].join('\n') + '\n'
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(streamFromChunks([ndjson]), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
    )
    const contents: string[] = []
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    let done = false
    await ollamaChatStream(OLLAMA_DEFAULT_BASE, 'llama3.2', [{ role: 'user', content: 'hi' }], (d) => {
      if (d.content) contents.push(d.content)
      if (d.usage) usage = d.usage
      if (d.done) done = true
    })
    expect(contents).toEqual(['a', 'b'])
    expect(done).toBe(true)
    expect(usage?.promptTokens).toBe(3)
    expect(usage?.completionTokens).toBe(9)
  })

  it('ollamaChatStream: 5xx 抛错', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(ollamaChatStream(OLLAMA_DEFAULT_BASE, 'llama3.2', [{ role: 'user', content: 'hi' }], () => {}))
      .rejects.toThrow('Ollama API error 500')
  })
})
