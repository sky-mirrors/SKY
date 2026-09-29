import { DialogMessage } from '@/models'
import { ingestText, hybridSearch } from './knowledgeBase'
import { vault } from '@/vault'

const CONV_SUMMARY_KEY = 'holo-conv-summaries'
/** K-2：会话索引水位线——必须随 vault 持久化 */
const INDEX_WATERMARK_KEY = 'holo-conv-index-watermark'

interface PeriodSummary {
  period: string
  summary: string
  from: number
  to: number
}

function loadSummaries(): PeriodSummary[] {
  try {
    const raw = vault.readCache('conv', CONV_SUMMARY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveSummaries(summaries: PeriodSummary[]): void {
  vault.writeThrough('conv', CONV_SUMMARY_KEY, JSON.stringify(summaries.slice(-20)))
}

function loadWatermark(): number {
  try {
    const raw = vault.readCache('conv', INDEX_WATERMARK_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch { return 0 }
}

/**
 * K-2：索引水位线原先只是模块级变量（只写不读回）⇒ 每次重启归零，
 * `indexConversationRound` 会把已索引过的历史对白再次全量摄取。
 * 现随 vault 持久化；惰性读回（不在模块顶层读）以免 vault 尚未就绪时把水位线
 * 误判为 0 并就此固化。
 */
let lastIndexTimestamp: number | null = null

function getWatermark(): number {
  if (lastIndexTimestamp === null) lastIndexTimestamp = loadWatermark()
  return lastIndexTimestamp
}

function setWatermark(ts: number): void {
  lastIndexTimestamp = ts
  try {
    vault.writeThrough('conv', INDEX_WATERMARK_KEY, String(ts))
  } catch { /* 持久化失败不阻断本次索引 */ }
}

export async function indexConversationRound(messages: DialogMessage[]): Promise<void> {
  const userMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  if (userMsgs.length === 0) return

  const watermark = getWatermark()
  const newMsgs = userMsgs.filter(m =>
    m.timestamp > watermark &&
    m.type !== 'system_notice' &&
    m.type !== 'tool_log' &&
    m.content && m.content.trim().length >= 5
  )

  if (newMsgs.length === 0) return

  const batchText = newMsgs.map(m =>
    `${m.role === 'user' ? '用户' : 'AI'}：${m.content.substring(0, 500)}`
  ).join('\n\n')

  try {
    await ingestText(batchText, { type: 'conversation' }, `conv-round-${Date.now()}`)
    setWatermark(newMsgs[newMsgs.length - 1].timestamp)
  } catch { /* non-critical */ }
}

export async function searchConversationContext(query: string, topK: number = 3): Promise<string[]> {
  try {
    const results = await hybridSearch(query, topK, { ownerType: 'conversation' })
    return results.map(r => r.text)
  } catch {
    return []
  }
}

export function getLatestSummary(): string {
  const summaries = loadSummaries()
  if (summaries.length === 0) return ''
  return summaries[summaries.length - 1].summary
}

export function savePeriodSummary(summary: string, from: number, to: number): void {
  const summaries = loadSummaries()
  summaries.push({
    period: new Date(from).toLocaleDateString('zh-CN'),
    summary,
    from,
    to
  })
  saveSummaries(summaries)
}

export function getAllSummaries(): string {
  const summaries = loadSummaries()
  if (summaries.length === 0) return ''
  return summaries.map(s => `[${s.period}] ${s.summary}`).join('\n\n')
}

export function shouldCompress(messages: DialogMessage[]): boolean {
  const userRounds = messages.filter(m => m.role === 'user').length
  if (userRounds >= 10) return true

  let totalChars = 0
  for (const m of messages) {
    totalChars += (m.content || '').length
  }
  return totalChars > 20000
}

export function detectChallenge(userInput: string, lastAssistantContent: string): boolean {
  const challengePhrases = [
    '不对', '不是吧', '你确定吗', '明明是', '搞错了', '说错了',
    '记错了', '不可能', '跟之前不一样', '和昨天说的不一样',
    '怎么会是', '我记得是', '之前说的是', '上次你说', '刚才你说',
    '不是这样的', '不准确', '有误', '错的', '纠正', '更正'
  ]
  const lower = userInput.toLowerCase()
  for (const phrase of challengePhrases) {
    if (lower.includes(phrase)) return true
  }

  const numberPattern = /\d+\.?\d*/g
  const userNums: string[] = userInput.match(numberPattern) || []
  const aiNums: string[] = lastAssistantContent.match(numberPattern) || []
  if (userNums.length > 0 && aiNums.length > 0) {
    for (const n of userNums) {
      if (aiNums.includes(n)) continue
      const val = parseFloat(n)
      for (const aiN of aiNums) {
        if (Math.abs(val - parseFloat(aiN)) < 0.01) continue
        if (Math.abs(val - parseFloat(aiN)) / Math.max(Math.abs(val), 1) < 0.3) {
          return true
        }
      }
    }
  }

  return false
}

export function clearConvMemory(): void {
  vault.delete('conv', CONV_SUMMARY_KEY).catch(() => {})
  vault.delete('conv', 'holo-conv-chunks').catch(() => {})
  // K-2：清空会话记忆时水位线一并归零——否则清库后旧水位线会挡住全部历史重新入库
  lastIndexTimestamp = 0
  vault.delete('conv', INDEX_WATERMARK_KEY).catch(() => {})
}
