import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { FeedbackEntry, FeedbackAction, SkillWeightModifier, SideEffectManifest, DecisionContext } from '@/models'
import { recordStrategyOutcome } from '@/services/strategySelector'
import { debugLog } from '@/services/debugLog'
import { vault } from '@/vault'

const FEEDBACK_KEY = 'holo-feedback-entries'
const WEIGHTS_KEY = 'holo-skill-weights'
const EFFECTS_KEY = 'holo-side-effects'

const STOP_WORDS = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '或', '帮', '给', '让', '把', '被', '从', '到', '用', '对', '为', '以', '及', '等', '着', '过', '一下', '一下下', '一个', '一些', '请', '要', '会', '能', '可以', '帮我', '帮我看看', '搞', '搞一下', '做', '做一下', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'it', 'this', 'that', 'me', 'my', 'your'])

export function computeQueryFingerprint(query: string): string {
  const tokens = query.toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOP_WORDS.has(t))
  tokens.sort()
  return tokens.join('_')
}

export const useFeedbackStore = defineStore('feedback', () => {
  const entries = ref<FeedbackEntry[]>([])
  const weights = ref<Map<string, SkillWeightModifier>>(new Map())
  const sideEffects = ref<SideEffectManifest[]>([])

  async function loadFromStorage(): Promise<void> {
    const rawEntries = vault.readCache('feedback', FEEDBACK_KEY)
    if (rawEntries) {
      try { entries.value = JSON.parse(rawEntries) } catch { /* ignore */ }
    }
    const rawWeights = vault.readCache('feedback', WEIGHTS_KEY)
    if (rawWeights) {
      try {
        const arr: SkillWeightModifier[] = JSON.parse(rawWeights)
        weights.value = new Map(arr.map(w => [w.skillId, w]))
      } catch { /* ignore */ }
    }
    try {
      if (window.electronAPI?.storeRead) {
        const data: string | null = await window.electronAPI.storeRead(EFFECTS_KEY)
        if (data) sideEffects.value = JSON.parse(data)
      }
    } catch { /* ignore */ }
  }

  function saveEntries(): void {
    const trimmed = entries.value.slice(-200)
    entries.value = trimmed
    vault.writeThrough('feedback', FEEDBACK_KEY, JSON.stringify(trimmed))
  }

  function saveWeights(): void {
    const arr = Array.from(weights.value.values())
    vault.writeThrough('feedback', WEIGHTS_KEY, JSON.stringify(arr))
  }

  async function saveSideEffects(): Promise<void> {
    try {
      if (window.electronAPI?.storeWrite) {
        await window.electronAPI.storeWrite(EFFECTS_KEY, JSON.stringify(sideEffects.value.slice(-50)))
      }
    } catch { /* ignore */ }
  }

  function recordFeedback(
    queryFingerprint: string,
    matchedSkillId: string,
    action: FeedbackAction,
    contextFiles: string[] = [],
    sessionId: string = '',
    decisionContext?: DecisionContext
  ): void {
    const entry: FeedbackEntry = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      queryFingerprint,
      matchedSkillId,
      contextFiles,
      action,
      timestamp: Date.now(),
      sessionId,
      decisionContext
    }
    entries.value.push(entry)
    saveEntries()

    let modifier = 0
    if (action === 'thumbs_up') modifier = 0.10
    else if (action === 'thumbs_down') modifier = -0.15
    else if (action === 'undo') modifier = -0.20

    adjustWeight(matchedSkillId, modifier)

    if (decisionContext) {
      const outcome: 'success' | 'failure' = (action === 'thumbs_up') ? 'success' : 'failure'
      if (decisionContext.rewriteStrategy && decisionContext.rewriteStrategy !== 'none') {
        recordStrategyOutcome({
          strategyType: 'rewrite',
          strategy: decisionContext.rewriteStrategy,
          outcome,
          contextSnapshot: decisionContext.strategyContextSnapshot,
        })
      }
      if (decisionContext.disambigStrategy) {
        recordStrategyOutcome({
          strategyType: 'disambig',
          strategy: decisionContext.disambigStrategy,
          outcome,
          contextSnapshot: decisionContext.strategyContextSnapshot,
        })
      }
    }
  }

  function adjustWeight(skillId: string, delta: number): void {
    const existing = weights.value.get(skillId)
    if (existing) {
      existing.modifier = Math.max(-0.50, Math.min(0.50, existing.modifier + delta))
      existing.lastUpdated = Date.now()
    } else {
      weights.value.set(skillId, {
        skillId,
        modifier: Math.max(-0.50, Math.min(0.50, delta)),
        decayRate: delta > 0 ? 0.005 : 0.003,
        lastUpdated: Date.now()
      })
    }
    saveWeights()
  }

  function getWeightModifier(skillId: string): number {
    return weights.value.get(skillId)?.modifier || 0
  }

  function decayModifiers(): void {
    const toDelete: string[] = []
    for (const [skillId, entry] of weights.value) {
      if (entry.modifier > 0) {
        entry.modifier = Math.max(0, entry.modifier - 0.005)
      } else if (entry.modifier < 0) {
        entry.modifier = Math.min(0, entry.modifier + 0.003)
      }
      if (Math.abs(entry.modifier) < 0.01) {
        toDelete.push(skillId)
      } else {
        entry.lastUpdated = Date.now()
      }
    }
    for (const id of toDelete) weights.value.delete(id)
    if (toDelete.length > 0 || weights.value.size > 0) saveWeights()
  }

  function addSideEffectManifest(manifest: SideEffectManifest): void {
    sideEffects.value.push(manifest)
    saveSideEffects()
  }

  function getLatestSideEffect(executionId: string): SideEffectManifest | null {
    for (let i = sideEffects.value.length - 1; i >= 0; i--) {
      if (sideEffects.value[i].executionId === executionId) return sideEffects.value[i]
    }
    return null
  }

  async function undoExecution(executionId: string): Promise<{ success: boolean; message: string }> {
    const effect = getLatestSideEffect(executionId)
    if (!effect) return { success: false, message: '未找到执行记录' }

    const fileOps = effect.sideEffects.filter(s => s.operation === 'create' || s.operation === 'modify')
    let movedCount = 0

    for (const op of fileOps) {
      if (op.operation === 'create' && op.filePath) {
        try {
          if (window.electronAPI?.shellExec) {
            const result = await window.electronAPI.shellExec({
              command: `node -e "const fs=require('fs');const p=require('path');const home=process.env.USERPROFILE||process.env.HOME||'C:\\\\Users\\\\Administrator';const trash=p.join(home,'Desktop','holo-trash');if(!fs.existsSync(trash))fs.mkdirSync(trash,{recursive:true});const src=process.env.SRC_PATH;if(!fs.existsSync(src)){debugLog('SKIP');process.exit(0)}const dest=p.join(trash,'_cancelled_'+Date.now()+'_'+p.basename(src));fs.renameSync(src,dest);debugLog('MOVED:'+dest)"`,
              timeout: 5000,
              env: { SRC_PATH: op.filePath }
            })
            if (result.success && result.stdout.includes('MOVED')) movedCount++
          }
        } catch { /* move failed */ }
      }
    }

    recordFeedback(effect.queryFingerprint, effect.manifestId, 'undo', [], executionId)

    return {
      success: true,
      message: `已撤销执行，${movedCount > 0 ? `${movedCount}个生成文件已移至回收目录` : '无文件副作用'}`
    }
  }

  async function clearExecutionCache(queryFingerprint: string): Promise<void> {
    try {
      if (window.electronAPI?.storeRead) {
        const data: string | null = await window.electronAPI.storeRead('execution-fingerprints')
        if (data) {
          const parsed = JSON.parse(data)
          if (parsed[queryFingerprint]) {
            delete parsed[queryFingerprint]
            if (window.electronAPI?.storeWrite) {
              await window.electronAPI.storeWrite('execution-fingerprints', JSON.stringify(parsed))
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  loadFromStorage()

  let decayIntervalHandle: ReturnType<typeof setInterval> | null = setInterval(() => {
    decayModifiers()
  }, 24 * 60 * 60 * 1000)

  function dispose() {
    if (decayIntervalHandle) { clearInterval(decayIntervalHandle); decayIntervalHandle = null }
  }

  return {
    entries,
    weights,
    sideEffects,
    recordFeedback,
    getWeightModifier,
    adjustWeight,
    decayModifiers,
    addSideEffectManifest,
    getLatestSideEffect,
    undoExecution,
    clearExecutionCache,
    loadFromStorage,
    dispose
  }
})
