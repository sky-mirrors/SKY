import { describe, it, expect } from 'vitest'
import {
  extractOpenAIDelta,
  extractAnthropicDelta,
  readSSEStream,
  readNDJSONStream,
  type StreamDelta,
} from '@/services/sseParser'

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

describe('S-4: 流异常不得被当成成功完成', () => {
  describe('服务端 error 事件', () => {
    it('OpenAI 兼容 error 对象 → 产出 error 字段', () => {
      const d = extractOpenAIDelta({ data: '{"error":{"message":"boom","type":"server_error"}}' })
      expect(d.error).toContain('boom')
    })

    it('Anthropic type=error → 产出 error 字段', () => {
      const d = extractAnthropicDelta({ data: '{"type":"error","error":{"type":"overloaded_error","message":"boom"}}' })
      expect(d.error).toContain('boom')
    })
  })

  describe('EOF 无终止标记 → truncated', () => {
    it('SSE 流无 [DONE] 结尾 → 最后一个 delta 带 truncated', async () => {
      const deltas: StreamDelta[] = []
      await readSSEStream(
        sseBody(['data: {"choices":[{"delta":{"content":"半句"}}]}\n\n']),
        'openai',
        (d) => deltas.push(d)
      )
      const last = deltas[deltas.length - 1]
      expect(last.done).toBe(true)
      expect(last.truncated).toBe(true)
    })

    it('SSE 流有 [DONE] 结尾 → 不带 truncated', async () => {
      const deltas: StreamDelta[] = []
      await readSSEStream(
        sseBody(['data: {"choices":[{"delta":{"content":"完整"}}]}\n\n', 'data: [DONE]\n\n']),
        'openai',
        (d) => deltas.push(d)
      )
      const last = deltas[deltas.length - 1]
      expect(last.done).toBe(true)
      expect(last.truncated).toBeUndefined()
    })

    it('NDJSON 流无 done 行结尾 → truncated', async () => {
      const deltas: StreamDelta[] = []
      await readNDJSONStream(sseBody(['{"message":{"content":"半句"},"done":false}\n']), (d) => deltas.push(d))
      const last = deltas[deltas.length - 1]
      expect(last.done).toBe(true)
      expect(last.truncated).toBe(true)
    })

    it('NDJSON 流有 done 行结尾 → 不带 truncated', async () => {
      const deltas: StreamDelta[] = []
      await readNDJSONStream(
        sseBody(['{"message":{"content":"完整"},"done":false}\n', '{"done":true,"eval_count":3}\n']),
        (d) => deltas.push(d)
      )
      const last = deltas[deltas.length - 1]
      expect(last.done).toBe(true)
      expect(last.truncated).toBeUndefined()
    })
  })
})
