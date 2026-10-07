/**
 * 「解压并归类」的**纯计划核心**（2026-10-08）—— CI-05 缺口的算子所需的判定层。
 *
 * 背景：「把桌面的 zip 压缩包都解压，然后放进一个新建的文件夹里」。此前系统只能如实说
 * 「没有解压算子」（见 src/data/compositeCombos.json 的 $missing.archive-collect）；本模块补上判定层，
 * 真正的解压（extract-zip）在 electron/ipc-handlers.ts 的 file:unzip 里做，按 file:move 同款路径校验口径。
 *
 * 与 electron/fileSortByType.ts 同款约定：跨层共享的零依赖叶子逻辑放 electron/（主进程与渲染层都要用）。
 *
 * 语义选型（刻意，且与系统解压工具默认一致）：
 *   · **每个压缩包解成一个同名子目录**（`<目标>\<压缩包名>\`）——不把 N 个包的内容摊平混合；
 *   · 目标子目录已存在 ⇒ 该包**跳过并上报**（不做覆盖式解压，重复执行安全）；
 *   · 支持面只有 `.zip`（extract-zip 的能力边界）；`.rar` / `.7z` **如实报告不支持**，不假装解压过。
 */

import { join } from 'path'
import { extOf } from './fileSortByType'

/** 支持解压的扩展名（刻意只 zip） */
export const SUPPORTED_ARCHIVE_EXTS = ['zip']

/** 是否是可解压的压缩包名（扩展名口径复用 fileSortByType.extOf：点在开头不算扩展名） */
export function isArchiveName(fileName: string): boolean {
  return SUPPORTED_ARCHIVE_EXTS.includes(extOf(fileName))
}

/** 压缩包名 → 子目录名（去掉最后一个扩展名） */
export function archiveStem(fileName: string): string {
  const name = String(fileName || '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(0, dot)
}

export interface UnzipTarget {
  /** 压缩包文件名（不含目录） */
  archive: string
  /** 解压目标目录（绝对路径） */
  dir: string
}

/**
 * 解压计划：按**传入顺序**挑出压缩包、各配一个目标子目录。纯函数，不碰磁盘。
 * 同名（含大小写差异）的压缩包会映射到同一目录——运行时按「目标已存在」跳过后者，行为确定。
 */
export function planUnzip(names: string[], toDir: string): UnzipTarget[] {
  const out: UnzipTarget[] = []
  for (const raw of names || []) {
    const name = String(raw || '')
    if (!isArchiveName(name)) continue
    out.push({ archive: name, dir: join(String(toDir), archiveStem(name)) })
  }
  return out
}
