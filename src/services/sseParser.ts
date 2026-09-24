export interface SSEEvent {
  event?: string
  data: string
}

export interface StreamDelta {
  content?: string
  toolCalls?: { index: number; id?: string; name?: string; arguments?: string }[]
  usage?: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
  done: boolean
  /** S-4：服务端在流内报错（OpenAI error 对象 / Anthropic type=error）——必须判失败 */
  error?: string
  /** S-4：流在未见终止标记的情况下结束（EOF）——内容不完整，不得当成功、不得入缓存 */
  truncated?: boolean
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
    // S-4：服务端在流内报错必须判失败，不得静默丢弃后当成功收尾（截断内容会入缓存与账本）
    if (p.error) {
      return { done: false, error: typeof p.error === 'string' ? p.error : (p.error.message || JSON.stringify(p.error)) }
    }
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

    // S-4：Anthropic 流内错误事件（overloaded_error 等）必须判失败，原实现无此分支
    if (type === 'error') {
      return { done: false, error: p.error?.message || p.error?.type || 'anthropic stream error' }
    }

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
    // S-4：走到这里说明整个流都没见到终止标记（[DONE]/message_stop 都会在上方 return）——
    // 这是被截断的流，不能当成功完成（原实现合成 done:true，导致截断内容入缓存/账本）
    onDelta({ done: true, truncated: true })
  } finally {
    reader.releaseLock()
  }
}

// M17：Ollama /api/chat NDJSON 解析——每行一个 JSON 对象（非 SSE data: 前缀），
// 复用 StreamDelta 适配层；末行 done:true 携带 prompt_eval_count/eval_count 计数
// （旧版 Ollama 字段可能缺失，一律回退 0）
export function extractOllamaDelta(line: string): StreamDelta | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let p: {
    message?: { content?: string }
    done?: boolean
    prompt_eval_count?: number
    eval_count?: number
  }
  try {
    p = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (p.done) {
    const content = p.message?.content || ''
    return {
      ...(content ? { content } : {}),
      usage: {
        promptTokens: p.prompt_eval_count ?? 0,
        completionTokens: p.eval_count ?? 0,
      },
      done: true
    }
  }
  if (p.message?.content) {
    return { content: p.message.content, done: false }
  }
  return null
}

// M17：NDJSON 流读取——按 \n（兼容 \r\n）分帧逐行解析；done 行后主动 cancel 底层流
export async function readNDJSONStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: StreamDelta) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let doneEmitted = false
  const emitLine = (line: string): void => {
    if (doneEmitted) return
    const delta = extractOllamaDelta(line)
    if (delta) {
      onDelta(delta)
      if (delta.done) doneEmitted = true
    }
  }
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => { /* 流已关闭或出错时忽略 */ })
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) emitLine(line)
      if (doneEmitted) {
        await reader.cancel().catch(() => { /* 流已关闭或出错时忽略 */ })
        return
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) emitLine(buffer)
    // S-4：无 done 行即被截断，不得当成功完成
    if (!doneEmitted) onDelta({ done: true, truncated: true })
  } finally {
    reader.releaseLock()
  }
}
