/**
 * 「批量改扩展名（留在原位）」的**纯计划核心**（2026-10-08）—— CI-07 缺口的算子所需的判定层。
 *
 * 背景：「把桌面上所有 txt 文件改成 md 后缀，然后放进一个新建的文件夹」。此前系统只能如实说
 * 「没有『只改扩展名、留在原位』的批量形态」（见 src/data/compositeCombos.json 的 $missing.change-ext-collect）。
 * 本模块补上判定层，实际的改名在 electron/ipc-handlers.ts 的 file:renameExt 里做（file:move 同款路径校验口径）。
 *
 * 与 electron/fileSortByType.ts / fileUnzip.ts 同款约定：跨层共享的零依赖叶子逻辑放 electron/。
 * 扩展名口径复用 fileSortByType 的 `extOf`（同一个判断：点在开头不算扩展名）。
 */

import { join } from 'path'
import { extOf } from './fileSortByType'

/** 扩展名 token 归一：去前导点、去空白、转小写 */
export function normalizeExtToken(ext: string): string {
  return String(ext || '').trim().toLowerCase().replace(/^\.+/, '')
}

export interface RenameExtPlan {
  /** 原文件名 */
  from: string
  /** 新文件名（同目录，仅换扩展名） */
  to: string
}

/**
 * 批量改扩展名计划（就地）：挑出扩展名等于 `fromExt` 的文件，算出换后缀后的新名。
 * 纯函数，不碰磁盘。三种情况返回空计划（fail-closed，不做无意义或破坏性改名）：
 *   · `toExt` 为空（不产出"删掉扩展名"这类破坏性改名）；
 *   · `fromExt` 与 `toExt` 相同（忽略大小写）——改了个寂寞，且会产生假成功；
 *   · 目录里没有匹配的源文件。
 */
export function planRenameExt(names: string[], fromExt: string, toExt: string): RenameExtPlan[] {
  const from = normalizeExtToken(fromExt)
  const to = normalizeExtToken(toExt)
  if (!from || !to || from === to) return []
  const out: RenameExtPlan[] = []
  for (const raw of names || []) {
    const name = String(raw || '')
    if (!name) continue
    if (extOf(name) !== from) continue
    out.push({ from: name, to: `${name.slice(0, name.length - from.length - 1)}.${to}` })
  }
  return out
}

/** 目标路径（同目录 + 新名）——供 IPC handler 做写类校验用 */
export function renameTargetPath(dir: string, plan: RenameExtPlan): string {
  return join(String(dir), plan.to)
}
