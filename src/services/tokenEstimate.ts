const CJK_RANGES = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g
const CJK_TOKEN_WEIGHT = 1.8
const OTHER_TOKEN_WEIGHT = 0.25

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(CJK_RANGES)
  const cjk = cjkMatches ? cjkMatches.length : 0
  const other = text.length - cjk
  return Math.ceil(cjk * CJK_TOKEN_WEIGHT + other * OTHER_TOKEN_WEIGHT)
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.role) + estimateTokens(m.content) + 4
  }
  return total
}

export function estimatePromptTokens(systemPrompt: string, context: string, userMessage: string): number {
  return estimateTokens(systemPrompt) + estimateTokens(context) + estimateTokens(userMessage) + 20
}

export function getContextWindowBudget(
  totalBudget: number,
  systemTokens: number,
  reservedOutput: number = 1024
): number {
  return Math.max(0, totalBudget - systemTokens - reservedOutput)
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text)
  if (currentTokens <= maxTokens) return text
  const ratio = maxTokens / currentTokens
  const targetChars = Math.floor(text.length * ratio * 0.9)
  return text.substring(0, targetChars)
}
