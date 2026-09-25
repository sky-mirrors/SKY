/**
 * A4 兜底直答的**决策**（2026-09-25，考试复跑发现的既存缺陷）。
 *
 * dialogStore 原生计划路径的"步骤失败 → 回退直接回答"分支自带不变量：
 *   「用户永远能收到回复」（源码注释 P0-A）。
 * 但实测它不是：兜底那次 `api:chat-completion` **带着 tools** 重问模型，而本地弱模型
 * （qwen2.5:3b）常只回 tool_calls、不回文本 ⇒ `resp.content` 为空 ⇒ 直接落到 `(无输出)`，
 * 工具调用**无人执行**。用户看到的就是一片空白（Q14「桌面 .docx 清单」两轮考试稳定复现，
 * 且已用「回退到改动前代码仍复现」证伪了它与新改动相关）。
 *
 * 本模块把该决策抽成**纯函数**，好把"空回复"这条静默死亡路径钉进回归测试。
 */

export interface FallbackResponse {
  content?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

export type FallbackDecision =
  | { kind: 'content'; text: string }
  | { kind: 'tools'; toolCalls: { id: string; name: string; arguments: string }[] }
  | { kind: 'empty' }

/**
 * 决定兜底直答该怎么收口：有文本用文本；只有工具调用就**执行它们**（否则用户收到空白）；
 * 两者都没有才算空。
 */
export function decideFallback(resp: FallbackResponse | null | undefined): FallbackDecision {
  const text = (resp?.content || '').trim()
  if (text) return { kind: 'content', text: resp!.content as string }
  const toolCalls = resp?.toolCalls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return { kind: 'tools', toolCalls }
  return { kind: 'empty' }
}
