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
  const parts = combined.split('\n\n')
  const remainingBuffer = parts.pop() || ''
  const events: SSEEvent[] = []
  for (const part of parts) {
    const lines = part.split('\n')
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7)
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6))
      } else if (line.startsWith('data:') && line.length === 5) {
        dataLines.push('')
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
        reader.cancel()
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
        if (delta.done) return
      }
    }
    if (buffer.trim()) {
      const remaining = buffer.trim()
      if (remaining.startsWith('data: ')) {
        const data = remaining.slice(6)
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
