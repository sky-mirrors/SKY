import { L2ToolManifest } from '@/models'
import l2Manifests from '@/data/l2Manifests'

interface ProactiveRule {
  manifestId: string
  trigger: 'time' | 'behavior' | 'file_open'
  cronPattern?: string
  behaviorPattern?: {
    minUsageCount: number
    timeWindowHours: number
  }
  filePattern?: string
  preGenerateTier: 'nano' | 'mini' | 'standard' | 'pro'
  lastTriggeredAt: number
}

interface ProactiveResult {
  manifestId: string
  manifestName: string
  cachedResult: string
  triggeredAt: number
  triggerType: 'time' | 'behavior' | 'file_open'
}

const STORE_KEY_RULES = 'proactive-rules-state'
const STORE_KEY_BEHAVIOR = 'proactive-behavior-log'
const STORE_KEY_PENDING = 'proactive-pending-results'
const MAX_BEHAVIOR_LOG = 200
const MAX_PENDING_RESULTS = 20

const proactiveRules: ProactiveRule[] = [
  {
    manifestId: 'l2-weekly-report-draft-v1',
    trigger: 'time',
    cronPattern: 'friday-16',
    preGenerateTier: 'nano',
    lastTriggeredAt: 0
  },
  {
    manifestId: 'l2-weekly-report-draft-v1',
    trigger: 'behavior',
    behaviorPattern: { minUsageCount: 3, timeWindowHours: 168 },
    preGenerateTier: 'nano',
    lastTriggeredAt: 0
  },
  {
    manifestId: 'l2-kpi-report-gen-v1',
    trigger: 'time',
    cronPattern: 'monday-9',
    preGenerateTier: 'mini',
    lastTriggeredAt: 0
  },
  {
    manifestId: 'l2-reimbursement-check-v1',
    trigger: 'time',
    cronPattern: '1-9',
    preGenerateTier: 'nano',
    lastTriggeredAt: 0
  }
]

let behaviorLog: { manifestId: string; timestamp: number }[] = []
let pendingResults: ProactiveResult[] = []

function persistRulesState(): void {
  try {
    const state = proactiveRules.map(r => ({ manifestId: r.manifestId, trigger: r.trigger, lastTriggeredAt: r.lastTriggeredAt }))
    localStorage.setItem(STORE_KEY_RULES, JSON.stringify(state))
  } catch { /* non-critical */ }
}

function persistBehaviorLog(): void {
  try {
    localStorage.setItem(STORE_KEY_BEHAVIOR, JSON.stringify(behaviorLog))
  } catch { /* non-critical */ }
}

function persistPendingResults(): void {
  try {
    localStorage.setItem(STORE_KEY_PENDING, JSON.stringify(pendingResults))
  } catch { /* non-critical */ }
}

export function loadPersistedState(): void {
  let restoredRules = 0
  let restoredBehavior = 0
  let restoredPending = 0
  try {
    const rulesRaw = localStorage.getItem(STORE_KEY_RULES)
    if (rulesRaw) {
      const saved: { manifestId: string; trigger: string; lastTriggeredAt: number }[] = JSON.parse(rulesRaw)
      for (const s of saved) {
        const rule = proactiveRules.find(r => r.manifestId === s.manifestId && r.trigger === s.trigger)
        if (rule) { rule.lastTriggeredAt = s.lastTriggeredAt; restoredRules++ }
      }
    }
  } catch { /* ignore */ }
  try {
    const behRaw = localStorage.getItem(STORE_KEY_BEHAVIOR)
    if (behRaw) {
      behaviorLog = JSON.parse(behRaw)
      restoredBehavior = behaviorLog.length
      if (behaviorLog.length > MAX_BEHAVIOR_LOG) behaviorLog = behaviorLog.slice(-MAX_BEHAVIOR_LOG)
    }
  } catch { /* ignore */ }
  try {
    const pendRaw = localStorage.getItem(STORE_KEY_PENDING)
    if (pendRaw) {
      pendingResults = JSON.parse(pendRaw)
      const cutoff = Date.now() - 86400000
      pendingResults = pendingResults.filter(p => p.triggeredAt >= cutoff)
      restoredPending = pendingResults.length
      if (pendingResults.length > MAX_PENDING_RESULTS) pendingResults = pendingResults.slice(-MAX_PENDING_RESULTS)
    }
  } catch { /* ignore */ }
  console.log(`[ProactiveScheduler] 恢复状态: ${restoredRules}条规则, ${restoredBehavior}条行为日志, ${restoredPending}条待处理结果`)
}

export function logManifestUsage(manifestId: string): void {
  behaviorLog.push({ manifestId, timestamp: Date.now() })
  if (behaviorLog.length > MAX_BEHAVIOR_LOG) behaviorLog.splice(0, behaviorLog.length - MAX_BEHAVIOR_LOG)
  persistBehaviorLog()
}

function checkCronPattern(pattern: string): boolean {
  const now = new Date()
  const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()]
  const hour = now.getHours()
  const dayOfMonth = now.getDate()

  const dayHourMatch = pattern.match(/^(\w+)-(\d+)$/)
  if (dayHourMatch) {
    return dayHourMatch[1] === dayOfWeek && Number(dayHourMatch[2]) === hour
  }

  const dayOfMonthMatch = pattern.match(/^(\d+)-(\d+)$/)
  if (dayOfMonthMatch) {
    return Number(dayOfMonthMatch[1]) === dayOfMonth && Number(dayOfMonthMatch[2]) === hour
  }

  return false
}

function checkBehaviorPattern(pattern: { minUsageCount: number; timeWindowHours: number }, manifestId: string): boolean {
  const cutoff = Date.now() - pattern.timeWindowHours * 3600000
  const recentUses = behaviorLog.filter(l => l.manifestId === manifestId && l.timestamp >= cutoff)
  return recentUses.length >= pattern.minUsageCount
}

export function checkProactiveTriggers(): ProactiveResult[] {
  const triggered: ProactiveResult[] = []
  const cooldownMs = 3600000

  for (const rule of proactiveRules) {
    if (Date.now() - rule.lastTriggeredAt < cooldownMs) continue

    let shouldTrigger = false
    let triggerType: 'time' | 'behavior' | 'file_open' = 'time'

    if (rule.trigger === 'time' && rule.cronPattern) {
      shouldTrigger = checkCronPattern(rule.cronPattern)
      triggerType = 'time'
    } else if (rule.trigger === 'behavior' && rule.behaviorPattern) {
      shouldTrigger = checkBehaviorPattern(rule.behaviorPattern, rule.manifestId)
      triggerType = 'behavior'
    } else if (rule.trigger === 'file_open' && rule.filePattern) {
      shouldTrigger = false
      triggerType = 'file_open'
    }

    if (shouldTrigger) {
      rule.lastTriggeredAt = Date.now()
      persistRulesState()
      const manifest = l2Manifests.find(m => m.identity.id === rule.manifestId)
      if (manifest) {
        triggered.push({
          manifestId: rule.manifestId,
          manifestName: manifest.identity.name,
          cachedResult: '',
          triggeredAt: Date.now(),
          triggerType
        })
      }
    }
  }

  return triggered
}

export async function preGenerateForManifest(
  manifest: L2ToolManifest,
  tier: 'nano' | 'mini' | 'standard' | 'pro'
): Promise<string | null> {
  const { executeMacro } = await import('./macroExecutor')
  try {
    const forcedTierManifest = { ...manifest }
    if (forcedTierManifest.execution.dagPlan) {
      forcedTierManifest.execution = {
        ...forcedTierManifest.execution,
        dagPlan: {
          ...forcedTierManifest.execution.dagPlan,
          steps: forcedTierManifest.execution.dagPlan.steps.map(s =>
            s.tool === 'llm_generate' ? { ...s, modelTier: tier } : s
          )
        }
      }
    }
    const { lastResult } = await executeMacro(
      forcedTierManifest,
      { inputText: `[预生成] ${manifest.identity.name}` },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    return lastResult
  } catch {
    return null
  }
}

export function getPendingResults(): ProactiveResult[] {
  const results = pendingResults.splice(0)
  persistPendingResults()
  return results
}

export function addProactiveResult(result: ProactiveResult): void {
  pendingResults.push(result)
  if (pendingResults.length > MAX_PENDING_RESULTS) pendingResults.splice(0, pendingResults.length - MAX_PENDING_RESULTS)
  persistPendingResults()
}

export function getProactiveRules(): ProactiveRule[] {
  return proactiveRules
}
