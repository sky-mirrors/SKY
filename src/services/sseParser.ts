export interface SSEEvent {
  event?: string
  data: string
}

export interface StreamDelta {
  content?: string
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[]
  usage?: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
  done: boolean
}

export function parseSSELines(chunk: string, buffer: string): { events: SSEEvent[]; remainingBuffer: string } {
  const combined = buffer + chunk
  // B-11：仅按 '\n\n' 分割导致 CRLF（\r\n\r\n）服务器整条流切不出事件——兼容两种行尾
  const parts = combined.split(/\r?\n\r?\n/)
  const remainingBuffer = parts.pop() || ''
  const events: SSEEvent[] = []
  for (const part of parts) {
    const lines = part.split(/\r?\n/)
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of lines) {
      // B-11：按 SSE 规范冒号后至多剥离一个空格——data:xxx（无空格）此前被整行丢弃
      if (line.startsWith('data:')) {
        const value = line.slice(5)
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
      } else if (line.startsWith('event:')) {
        const value = line.slice(6)
        event = value.startsWith(' ') ? value.slice(1) : value
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') })
    }
  }
  return { events, remainingBuffer }
}

export function extractOpenAIDelta(event: SSEEvent): StreamDelta {
  if (event.data.trim() === '[DONE]') {
    return { done: true }
  }
  try {
    const p = JSON.parse(event.data)
    const delta: StreamDelta = { done: false }
    if (p.choices?.[0]?.delta?.content) {
      delta.content = p.choices[0].delta.content
    }
    if (p.choices?.[0]?.delta?.tool_calls) {
      delta.toolCalls = p.choices[0].delta.tool_calls.map(
        (tc: { index?: number; id?: string; function?: { name?: string; arguments?: string } }) => ({
          index: tc.index ?? 0,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        })
      )
    }
    if (p.usage) {
      delta.usage = {
        promptTokens: p.usage.prompt_tokens,
        completionTokens: p.usage.completion_tokens,
        cacheHitTokens: p.usage.prompt_cache_hit_tokens ?? p.usage.prompt_tokens_details?.cached_tokens,
        cacheMissTokens: p.usage.prompt_cache_miss_tokens ?? p.usage.prompt_tokens_details?.uncached_tokens,
      }
    }
    return delta
  } catch {
    return { done: false }
  }
}

export function extractAnthropicDelta(event: SSEEvent): StreamDelta {
  try {
    const p = JSON.parse(event.data)
    const type = p.type

    if (type === 'message_stop') {
      return { done: true }
    }

    if (type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta?.text) {
      return { content: p.delta.text, done: false }
    }

    if (type === 'content_block_start' && p.content_block?.type === 'tool_use') {
      return {
        toolCalls: [{
          index: p.content_block.index ?? 0,
          id: p.content_block.id,
          name: p.content_block.name,
          arguments: '',
        }],
        done: false,
      }
    }

    if (type === 'content_block_delta' && p.delta?.type === 'input_json_delta' && p.delta?.partial_json) {
      return {
        toolCalls: [{
          index: p.index ?? 0,
          arguments: p.delta.partial_json,
        }],
        done: false,
      }
    }

    if (type === 'message_start' && p.message?.usage) {
      return {
        usage: { promptTokens: p.message.usage.input_tokens },
        done: false,
      }
    }

    if (type === 'message_delta' && p.usage) {
      return {
        usage: { completionTokens: p.usage.output_tokens },
        done: false,
      }
    }

    return { done: false }
  } catch {
    return { done: false }
  }
}

export async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  chatFormat: 'openai' | 'anthropic',
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  const extractFn = chatFormat === 'anthropic' ? extractAnthropicDelta : extractOpenAIDelta

  try {
    while (true) {
      if (signal?.aborted) {
        // B-16：cancel 是异步的必须 await，否则 finally 的 releaseLock 在 cancel 未完成时执行，
        // 底层连接可能不被真正释放；流已 errored 时 cancel 会 reject，挂 catch 保持 abort 语义
        await reader.cancel().catch(() => { /* 流已关闭或出错时忽略 */ })
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const { events, remainingBuffer } = parseSSELines(chunk, buffer)
      buffer = remainingBuffer
      for (const event of events) {
        const delta = extractFn(event)
        if (delta.done || delta.content !== undefined || delta.toolCalls !== undefined || delta.usage !== undefined) {
          onDelta(delta)
        }
        if (delta.done) {
          await reader.cancel().catch(() => { /* 流已关闭或出错时忽略 */ })
          return
        }
      }
    }
    // B-16：流结束时 flush TextDecoder 持有的多字节字符尾字节，否则最后的中文/emoji 会被丢弃
    buffer += decoder.decode()
    if (buffer.trim()) {
      const remaining = buffer.trim()
      // B-11：与 parseSSELines 一致——冒号后至多一个空格，data:xxx 也接受
      if (remaining.startsWith('data:')) {
        let data = remaining.slice(5)
        if (data.startsWith(' ')) data = data.slice(1)
        if (chatFormat === 'openai' && data.trim() === '[DONE]') {
          onDelta({ done: true })
          return
        }
        const delta = extractFn({ data })
        if (delta.done || delta.content !== undefined || delta.toolCalls !== undefined || delta.usage !== undefined) {
          onDelta(delta)
        }
      }
    }
    onDelta({ done: true })
  } finally {
    reader.releaseLock()
  }
}
