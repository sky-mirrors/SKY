import type { DagCheckpoint } from '@/models'
import { vault } from '@/vault'

const CHECKPOINT_STORE_KEY = 'dag-checkpoints'
const MAX_CHECKPOINTS = 20
const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000

let cache: DagCheckpoint[] | null = null

async function loadAll(): Promise<DagCheckpoint[]> {
  if (cache) return cache
  try {
    const raw = await vault.read('dag', CHECKPOINT_STORE_KEY)
    cache = raw ? JSON.parse(raw) : []
  } catch {
    cache = []
  }
  return cache
}

async function saveAll(checkpoints: DagCheckpoint[]): Promise<void> {
  cache = checkpoints
  try {
    await vault.write('dag', CHECKPOINT_STORE_KEY, JSON.stringify(checkpoints))
  } catch { /* non-critical */ }
}

export async function saveCheckpoint(cp: DagCheckpoint): Promise<void> {
  const all = await loadAll()
  const idx = all.findIndex(c => c.id === cp.id)
  cp.updatedAt = Date.now()
  if (idx >= 0) {
    all[idx] = cp
  } else {
    all.push(cp)
  }
  if (all.length > MAX_CHECKPOINTS) {
    all.sort((a, b) => a.updatedAt - b.updatedAt)
    all.splice(0, all.length - MAX_CHECKPOINTS)
  }
  await saveAll(all)
}

export async function removeCheckpoint(id: string): Promise<void> {
  const all = await loadAll()
  const filtered = all.filter(c => c.id !== id)
  await saveAll(filtered)
}

export async function getCheckpoint(id: string): Promise<DagCheckpoint | null> {
  const all = await loadAll()
  return all.find(c => c.id === id) || null
}

export async function getIncompleteCheckpoints(): Promise<DagCheckpoint[]> {
  const all = await loadAll()
  const now = Date.now()
  return all.filter(c => {
    const completedCount = Object.keys(c.completedResults).length
    const incomplete = completedCount + c.failedSteps.length + c.skipSteps.length < c.totalSteps
    const notExpired = now - c.createdAt < CHECKPOINT_EXPIRY_MS
    return incomplete && notExpired
  })
}

export async function getAllCheckpoints(): Promise<DagCheckpoint[]> {
  return loadAll()
}

export async function pruneExpired(): Promise<number> {
  const all = await loadAll()
  const now = Date.now()
  const kept = all.filter(c => now - c.createdAt < CHECKPOINT_EXPIRY_MS)
  const pruned = all.length - kept.length
  if (pruned > 0) await saveAll(kept)
  return pruned
}

export function createCheckpointId(manifestId: string, userInput: { filePath?: string; inputText?: string; context?: string }): string {
  const inputKey = `${userInput.filePath || ''}:${userInput.inputText || ''}:${userInput.context || ''}`
  let hash = 0
  for (let i = 0; i < inputKey.length; i++) {
    const ch = inputKey.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0
  }
  return `cp-${manifestId}-${Math.abs(hash).toString(36)}`
}
