// 目录列举 + 元数据取材（file:list 的数据路径，抽成模块是为了可测）。
//
// 为什么单独成模块：`file:list` 的 handler 注册在 setupIpc 闭包里、依赖 electron 的 ipcMain，
// 单测拿不到它；而「列举结果里到底有没有带对拍摄时间」正是 Q15 与日常「按拍摄时间整理照片」
// 依赖的契约，不能只靠读代码确认。这里把纯数据路径抽出来，handler 只保留
// 路径校验与错误包装，测试则可直接对真实目录断言。
//
// 时间来源优先级：图片自身的 EXIF 拍摄时间 → 文件系统 mtime（字段分开携带，来源由调用方如实标注）。
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'
import { extractExifShootDate, type ExifShootDate } from './exifDate'

export interface DirEntryMeta {
  name: string
  isDir: boolean
  mtimeMs: number
  mtimeIso: string | null
  /** EXIF 拍摄时间（本地时间语义）；无 EXIF 时为 null，调用方回退 mtimeIso 并标注来源 */
  shootDateIso: string | null
  /** 命中的 EXIF 标签名（DateTimeOriginal / DateTimeDigitized / DateTime）；无 EXIF 时为 null */
  shootDateTag: string | null
}

/** 只认 EXIF 可能存在的容器：JPEG / TIFF。HEIC、PNG 内的 EXIF 不在本轮范围 */
export const EXIF_CONTAINER_EXT = /\.(jpe?g|tiff?)$/i
/** 只读文件头——APP1(Exif) 段必然靠前，把整张大图读进来没有意义 */
export const EXIF_HEAD_BYTES = 128 * 1024
/** 单次列举最多解析多少个图片文件——防超大相册目录拖住主进程。
 *  超出的条目照常返回（name/isDir/mtime 齐全），只是拿不到 EXIF 日期 */
export const EXIF_SCAN_MAX_FILES = 500

/** 读文件头并抽取 EXIF 拍摄时间；读到即返回标签名，任何失败/缺失一律 null（不抛——它在列举路径上） */
export function readShootDateFromFile(fullPath: string): ExifShootDate | null {
  try {
    const fd = openSync(fullPath, 'r')
    try {
      const size = Math.min(EXIF_HEAD_BYTES, statSync(fullPath).size)
      if (size < 8) return null
      const head = Buffer.alloc(size)
      const read = readSync(fd, head, 0, size, 0)
      if (read <= 0) return null
      return extractExifShootDate(head.subarray(0, read))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** 列举目录：`entries` 为简名列表，`entriesWithMeta` 附带 mtime 与 EXIF 拍摄时间 */
export function listDirectoryWithMeta(dirPath: string): { entries: string[]; entriesWithMeta: DirEntryMeta[] } {
  const dirents = readdirSync(dirPath, { withFileTypes: true })
  const entries = dirents
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
  let exifBudget = EXIF_SCAN_MAX_FILES
  const entriesWithMeta = dirents
    .map(e => {
      const full = join(dirPath, e.name)
      let mtimeMs = 0
      try { mtimeMs = statSync(full).mtimeMs } catch { mtimeMs = 0 }
      let shootDate: ExifShootDate | null = null
      if (!e.isDirectory() && exifBudget > 0 && EXIF_CONTAINER_EXT.test(e.name)) {
        exifBudget--
        shootDate = readShootDateFromFile(full)
      }
      return {
        name: e.isDirectory() ? `${e.name}/` : e.name,
        isDir: e.isDirectory(),
        mtimeMs,
        mtimeIso: mtimeMs ? new Date(mtimeMs).toISOString() : null,
        shootDateIso: shootDate ? shootDate.iso : null,
        shootDateTag: shootDate ? shootDate.tag : null
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return { entries, entriesWithMeta }
}
