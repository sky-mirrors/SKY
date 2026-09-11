import { debugLog } from '@/services/debugLog'
import { vault } from '@/vault'

const STORE_KEY_BEHAVIOR = 'proactive-behavior-log'
const MAX_BEHAVIOR_LOG = 200

let behaviorLog: { manifestId: string; timestamp: number }[] = []

function persistBehaviorLog(): void {
  try {
    vault.writeThrough('proactive', STORE_KEY_BEHAVIOR, JSON.stringify(behaviorLog))
  } catch { /* non-critical */ }
}

export function loadPersistedState(): void {
  try {
    const behRaw = vault.readCache('proactive', STORE_KEY_BEHAVIOR)
    if (behRaw) {
      behaviorLog = JSON.parse(behRaw)
      if (behaviorLog.length > MAX_BEHAVIOR_LOG) behaviorLog = behaviorLog.slice(-MAX_BEHAVIOR_LOG)
    }
  } catch { /* ignore */ }
  debugLog(`[ProactiveScheduler] 恢复状态: ${behaviorLog.length}条行为日志`)
}

export async function initProactiveScheduler(): Promise<void> {
  const behRaw = await vault.read('proactive', STORE_KEY_BEHAVIOR)
  if (behRaw) {
    try {
      behaviorLog = JSON.parse(behRaw)
      if (behaviorLog.length > MAX_BEHAVIOR_LOG) behaviorLog = behaviorLog.slice(-MAX_BEHAVIOR_LOG)
    } catch { /* ignore */ }
  }
  debugLog(`[ProactiveScheduler] 恢复状态: ${behaviorLog.length}条行为日志`)
}

export function logManifestUsage(manifestId: string): void {
  behaviorLog.push({ manifestId, timestamp: Date.now() })
  if (behaviorLog.length > MAX_BEHAVIOR_LOG) behaviorLog.splice(0, behaviorLog.length - MAX_BEHAVIOR_LOG)
  persistBehaviorLog()
}

initProactiveScheduler().catch(() => {})
