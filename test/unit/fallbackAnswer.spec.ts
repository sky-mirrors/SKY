import { describe, it, expect } from 'vitest'
import { decideFallback } from '@/services/fallbackAnswer'

/**
 * 考试复跑发现的既存缺陷（Q14「桌面 .docx 清单」两轮稳定空回复）：
 * dialogStore 的 A4 兜底分支自称「用户永远能收到回复」，但模型只回 tool_calls 时
 * content 为空 ⇒ 落到 '(无输出)'、工具调用不执行 ⇒ 用户收到一片空白。
 * 本文件钉住"该决策不得把只有工具调用的回复当成空"。
 */
describe('decideFallback —— 兜底直答不得把"只有工具调用"当成空', () => {
  it('有文本 → 用文本', () => {
    expect(decideFallback({ content: '桌面有 3 个 .docx' })).toEqual({ kind: 'content', text: '桌面有 3 个 .docx' })
    // 半角/全角空白不算文本
    expect(decideFallback({ content: '   ' })).toEqual({ kind: 'empty' })
  })

  it('无文本但有工具调用 → 应执行（而不是当空）', () => {
    const d = decideFallback({ content: '', toolCalls: [{ id: '1', name: 'list_directory', arguments: '{"path":"C:\\\\x"}' }] })
    expect(d.kind).toBe('tools')
    if (d.kind === 'tools') expect(d.toolCalls[0].name).toBe('list_directory')
  })

  it('既无文本也无工具调用 → 才是空', () => {
    expect(decideFallback({})).toEqual({ kind: 'empty' })
    expect(decideFallback({ content: '', toolCalls: [] })).toEqual({ kind: 'empty' })
    expect(decideFallback(null)).toEqual({ kind: 'empty' })
  })
})
