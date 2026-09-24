import { join } from 'path'
import { existsSync, readdirSync, statSync, renameSync } from 'fs'

// E-4 修复：备份/恢复的目录校验与原子交换。
// 抽成无 Electron 依赖的纯 fs 模块，便于在 vitest 中直测交换/回滚逻辑
// （原实现在 ipc-handlers 内联，且 validateExtractedBackup 只认 store 的 .json/.bin，
//  无法校验含 default.db/-wal/-shm 的 vaults 目录）。

export type BackupKind = 'store' | 'vaults' | 'knowledge'

/** 各目录允许的条目扩展名。vaults 是真 SQLite 库及其 WAL 伴生文件 */
export const BACKUP_EXTS: Record<BackupKind, readonly string[]> = {
  store: ['json', 'bin'],
  vaults: ['db', 'db-wal', 'db-shm'],
  knowledge: ['json', 'bin'],
}

export interface BackupLimits {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

const DEFAULT_LIMITS: Required<BackupLimits> = {
  maxFiles: 5000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
}

/** 递归校验备份目录：拒符号链接/非常规文件/未列出的扩展名，并限制条目数与体积 */
export function validateBackupDir(
  rootDir: string,
  allowedExts: readonly string[],
  limits: BackupLimits = {}
): { files: number } {
  const { maxFiles, maxFileBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits }
  const allowed = new Set(allowedExts.map(e => e.toLowerCase()))
  let files = 0
  let total = 0

  if (!existsSync(rootDir)) throw new Error(`备份缺少目录，拒绝恢复: ${rootDir}`)
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`备份包含符号链接，拒绝恢复: ${entry.name}`)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) throw new Error(`备份包含非常规文件，拒绝恢复: ${entry.name}`)
      const ext = entry.name.toLowerCase().split('.').pop() || ''
      if (!allowed.has(ext)) throw new Error(`备份包含不支持的文件类型(.${ext})，拒绝恢复: ${entry.name}`)
      const size = statSync(full).size
      if (size > maxFileBytes) throw new Error(`备份条目过大，拒绝恢复: ${entry.name}`)
      files++
      total += size
      if (files > maxFiles) throw new Error(`备份条目数超过上限(${maxFiles})，拒绝恢复`)
      if (total > maxTotalBytes) throw new Error(`备份总量超过上限(${maxTotalBytes} 字节)，拒绝恢复`)
    }
  }
  walk(rootDir)
  return { files }
}

export interface RestoreTarget {
  kind: BackupKind
  /** 现网目录（将被交换为 staged） */
  live: string
  /** 备份解压出的新目录 */
  staged: string
}

export interface RestoreDirs {
  storeDir: string
  vaultsDir: string
  knowledgeDir: string
}

export function snapshotDirFor(live: string, timestamp: number): string {
  return `${live}-pre-restore-${timestamp}`
}

/**
 * 依据解压出的临时目录规划要交换的目标。
 * store 是有效备份的必要条件；vaults/knowledge 存在则一并纳入——
 * 否则「恢复成功」只换上 store、保留旧 vault（唯一真相源），灾难迁移场景静默丢核心数据。
 */
export function planRestoreTargets(tmpDir: string, dirs: RestoreDirs): RestoreTarget[] {
  const storeStaged = join(tmpDir, 'store')
  if (!existsSync(storeStaged)) {
    throw new Error('备份内不含 store 目录，不是有效的 HoloStarmap 备份')
  }
  const plan: RestoreTarget[] = [{ kind: 'store', live: dirs.storeDir, staged: storeStaged }]
  const vaultsStaged = join(tmpDir, 'vaults')
  if (existsSync(vaultsStaged)) plan.push({ kind: 'vaults', live: dirs.vaultsDir, staged: vaultsStaged })
  const knowledgeStaged = join(tmpDir, 'knowledge')
  if (existsSync(knowledgeStaged)) plan.push({ kind: 'knowledge', live: dirs.knowledgeDir, staged: knowledgeStaged })
  return plan
}

/**
 * 原子交换 plan 中每个目标（live → 快照，staged → live）：
 * 1) 交换前对**全部** staged 做校验——任一失败即中止，不动任何 live 目录；
 * 2) 每个目标交换前触发 beforeSwap(kind)——调用方在此释放 SQLite 文件锁
 *    （Windows 下被打开的文件不可 rename，vaults 交换前必须 closeVault）；
 * 3) 任一交换失败 → 尽力回滚此前已完成的交换，再抛错。
 * @returns 生成的快照目录列表（与 targets 同序）
 */
export function applyRestore(
  targets: RestoreTarget[],
  timestamp: number,
  beforeSwap?: (kind: BackupKind) => void
): string[] {
  // 1) 全量校验先行（任一不合法 → 不动任何现网目录）
  for (const t of targets) validateBackupDir(t.staged, BACKUP_EXTS[t.kind])

  const snapshots: string[] = []
  const swapped: Array<{ live: string; snapshot: string | null }> = []
  try {
    for (const t of targets) {
      beforeSwap?.(t.kind)
      const snapshot = snapshotDirFor(t.live, timestamp)
      const hadLive = existsSync(t.live)
      if (hadLive) renameSync(t.live, snapshot)
      try {
        renameSync(t.staged, t.live)
      } catch (e) {
        if (hadLive) renameSync(snapshot, t.live)
        throw e
      }
      swapped.push({ live: t.live, snapshot: hadLive ? snapshot : null })
      snapshots.push(snapshot)
    }
    return snapshots
  } catch (e) {
    // 2) 回滚已完成的交换（把换上来的内容挪走，再恢复快照）
    for (const s of swapped.reverse()) {
      try {
        if (existsSync(s.live)) renameSync(s.live, `${s.live}-failed-${timestamp}`)
        if (s.snapshot && existsSync(s.snapshot)) renameSync(s.snapshot, s.live)
      } catch { /* 回滚尽力而为，不掩盖原始错误 */ }
    }
    throw e
  }
}
