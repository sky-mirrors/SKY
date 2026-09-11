import { describe, it, expect } from 'vitest'
import { parseSSELines, extractOpenAIDelta, extractAnthropicDelta, type SSEEvent } from '@/services/sseParser'

describe('parseSSELines', () => {
  it('parses single event', () => {
    const { events, remainingBuffer } = parseSSELines('data: {"hello":1}\n\n', '')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"hello":1}')
    expect(remainingBuffer).toBe('')
  })

  it('parses event with event line (Anthropic)', () => {
    const { events } = parseSSELines('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n', '')
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('content_block_delta')
    expect(events[0].data).toBe('{"type":"content_block_delta"}')
  })

  it('parses multiple events in one chunk', () => {
    const chunk = 'data: {"a":1}\n\ndata: {"b":2}\n\n'
    const { events } = parseSSELines(chunk, '')
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"a":1}')
    expect(events[1].data).toBe('{"b":2}')
  })

  it('handles partial event in buffer', () => {
    const { events, remainingBuffer } = parseSSELines('data: {"a":1}\n\ndata: {"b":', '')
    expect(events).toHaveLength(1)
    expect(remainingBuffer).toBe('data: {"b":')
  })

  it('completes partial event from buffer', () => {
    const { events, remainingBuffer } = parseSSELines('2}\n\n', 'data: {"b":')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('{"b":2}')
    expect(remainingBuffer).toBe('')
  })

  it('handles [DONE] marker as regular data', () => {
    const { events } = parseSSELines('data: [DONE]\n\n', '')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('[DONE]')
  })

  it('handles multiline data fields', () => {
    const chunk = 'data: line1\ndata: line2\n\n'
    const { events } = parseSSELines(chunk, '')
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('line1\nline2')
  })
})

describe('extractOpenAIDelta', () => {
  it('extracts content delta', () => {
    const delta = extractOpenAIDelta({ data: '{"choices":[{"delta":{"content":"Hello"}}]}' })
    expect(delta.content).toBe('Hello')
    expect(delta.done).toBe(false)
  })

  it('detects [DONE]', () => {
    const delta = extractOpenAIDelta({ data: '[DONE]' })
    expect(delta.done).toBe(true)
  })

  it('extracts tool_calls delta', () => {
    const delta = extractOpenAIDelta({
      data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"get_weather","arguments":"{\\"loc\\"}"}}]}}]}'
    })
    expect(delta.toolCalls).toBeDefined()
    expect(delta.toolCalls!.length).toBe(1)
    expect(delta.toolCalls![0].name).toBe('get_weather')
    expect(delta.toolCalls![0].arguments).toBe('{"loc"}')
  })

  it('extracts usage', () => {
    const delta = extractOpenAIDelta({
      data: '{"usage":{"prompt_tokens":10,"completion_tokens":5}}'
    })
    expect(delta.usage).toBeDefined()
    expect(delta.usage!.promptTokens).toBe(10)
    expect(delta.usage!.completionTokens).toBe(5)
  })

  it('extracts cache usage', () => {
    const delta = extractOpenAIDelta({
      data: '{"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":8,"prompt_cache_miss_tokens":2}}'
    })
    expect(delta.usage!.cacheHitTokens).toBe(8)
    expect(delta.usage!.cacheMissTokens).toBe(2)
  })

  it('returns empty on unparseable data', () => {
    const delta = extractOpenAIDelta({ data: 'not json' })
    expect(delta.content).toBeUndefined()
    expect(delta.done).toBe(false)
  })
})

describe('extractAnthropicDelta', () => {
  it('extracts text delta from content_block_delta', () => {
    const delta = extractAnthropicDelta({
      event: 'content_block_delta',
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'
    })
    expect(delta.content).toBe('Hello')
    expect(delta.done).toBe(false)
  })

  it('detects message_stop', () => {
    const delta = extractAnthropicDelta({
      event: 'message_stop',
      data: '{"type":"message_stop"}'
    })
    expect(delta.done).toBe(true)
  })

  it('extracts input usage from message_start', () => {
    const delta = extractAnthropicDelta({
      event: 'message_start',
      data: '{"type":"message_start","message":{"usage":{"input_tokens":25}}}'
    })
    expect(delta.usage).toBeDefined()
    expect(delta.usage!.promptTokens).toBe(25)
  })

  it('extracts output usage from message_delta', () => {
    const delta = extractAnthropicDelta({
      event: 'message_delta',
      data: '{"type":"message_delta","usage":{"output_tokens":10}}'
    })
    expect(delta.usage).toBeDefined()
    expect(delta.usage!.completionTokens).toBe(10)
  })

  it('extracts tool_use from content_block_start', () => {
    const delta = extractAnthropicDelta({
      event: 'content_block_start',
      data: '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_123","name":"get_weather"}}'
    })
    expect(delta.toolCalls).toBeDefined()
    expect(delta.toolCalls!.length).toBe(1)
    expect(delta.toolCalls![0].id).toBe('tu_123')
    expect(delta.toolCalls![0].name).toBe('get_weather')
    expect(delta.toolCalls![0].arguments).toBe('')
  })

  it('extracts tool arguments from input_json_delta', () => {
    const delta = extractAnthropicDelta({
      event: 'content_block_delta',
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"loc\\"}"}}'
    })
    expect(delta.toolCalls).toBeDefined()
    expect(delta.toolCalls![0].arguments).toBe('{"loc"}')
  })

  it('ignores ping events', () => {
    const delta = extractAnthropicDelta({
      event: 'ping',
      data: '{"type":"ping"}'
    })
    expect(delta.content).toBeUndefined()
    expect(delta.done).toBe(false)
  })
})

describe('readSSEStream', () => {
  function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]))
          controller.close()
        } else {
          controller.close()
        }
      }
    })
  }

  it('reads OpenAI SSE stream', async () => {
    const deltas: string[] = []
    const stream = createMockStream([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'
    ])
    const { readSSEStream } = await import('@/services/sseParser')
    await readSSEStream(stream, 'openai', (delta) => {
      if (delta.content) deltas.push(delta.content)
      if (delta.done) deltas.push('[DONE]')
    })
    expect(deltas).toEqual(['Hello', ' world', '[DONE]'])
  })

  it('reads Anthropic SSE stream', async () => {
    const deltas: string[] = []
    const stream = createMockStream([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ])
    const { readSSEStream } = await import('@/services/sseParser')
    await readSSEStream(stream, 'anthropic', (delta) => {
      if (delta.content) deltas.push(delta.content)
      if (delta.usage) deltas.push(`usage:pt=${delta.usage.promptTokens},ct=${delta.usage.completionTokens}`)
      if (delta.done) deltas.push('[DONE]')
    })
    expect(deltas).toEqual(['usage:pt=10,ct=undefined', 'Hi', '[DONE]'])
  })

  it('handles abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = createMockStream(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'])
    const { readSSEStream } = await import('@/services/sseParser')
    const deltas: string[] = []
    await readSSEStream(stream, 'openai', (delta) => {
      if (delta.content) deltas.push(delta.content)
    }, controller.signal)
    expect(deltas.length).toBe(0)
  })
})
