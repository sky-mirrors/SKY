import type { DagCheckpoint } from '@/models'
import { vault } from '@/vault'

const CHECKPOINT_STORE_KEY = 'dag-checkpoints'
const MAX_CHECKPOINTS = 20
const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000

let cache: DagCheckpoint[] | null = null

// C-22：保存/删除的缓存竞态会让旧快照回写"复活"已删 checkpoint——
// 所有变更操作经 promise 链互斥串行化
let opLock: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opLock.then(fn, fn)
  opLock = run.then(() => undefined, () => undefined)
  return run
}

async function loadAll(): Promise<DagCheckpoint[]> {
  if (cache) return cache
  const all: DagCheckpoint[] = []
  try {
    const raw = await vault.read('dag', CHECKPOINT_STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DagCheckpoint[]
      if (Array.isArray(parsed)) all.push(...parsed)
    }
  } catch { /* non-critical */ }
  cache = all
  return all
}

async function saveAll(checkpoints: DagCheckpoint[]): Promise<void> {
  cache = checkpoints
  try {
    await vault.write('dag', CHECKPOINT_STORE_KEY, JSON.stringify(checkpoints))
  } catch { /* non-critical */ }
}

export async function saveCheckpoint(cp: DagCheckpoint): Promise<void> {
  await withLock(async () => {
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
  })
}

export async function removeCheckpoint(id: string): Promise<void> {
  await withLock(async () => {
    const all = await loadAll()
    const filtered = all.filter(c => c.id !== id)
    await saveAll(filtered)
  })
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
    // C-23：过期判定以"最后活跃时间"为准——保存时会刷新 updatedAt，
    // 跨天长任务的活跃 checkpoint 不应被误删
    const lastActive = Math.max(c.createdAt, c.updatedAt || 0)
    const notExpired = now - lastActive < CHECKPOINT_EXPIRY_MS
    return incomplete && notExpired
  })
}

export async function getAllCheckpoints(): Promise<DagCheckpoint[]> {
  return loadAll()
}

export async function pruneExpired(): Promise<number> {
  return withLock(async () => {
    const all = await loadAll()
    const now = Date.now()
    // C-23：与 getIncompleteCheckpoints 同口径——按最后活跃时间判定过期
    const kept = all.filter(c => now - Math.max(c.createdAt, c.updatedAt || 0) < CHECKPOINT_EXPIRY_MS)
    const pruned = all.length - kept.length
    if (pruned > 0) await saveAll(kept)
    return pruned
  })
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
