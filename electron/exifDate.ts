// EXIF 拍摄时间抽取（主进程纯函数，零依赖、零 I/O、不联网）。
//
// 为什么需要它：Q15「图片按拍摄日期重命名」此前只能拿文件系统时间冒充拍摄日期
// （26d8e77）。而「按拍摄时间归类/重命名」是高频日常诉求——相册整理、下载目录清理、
// 凭证与发票照片归档——所以这里补上真实数据源：图片自带的 EXIF 时间。
//
// 边界（有意收窄，别扩成通用 EXIF 库）：
//   - 只读一个日期字符串（DateTimeOriginal → DateTimeDigitized → DateTime）；
//   - 容器只认 JPEG（APP1/Exif 段）与裸 TIFF；HEIC/PNG 内的 EXIF 暂不支持，
//     调用方拿到 null 后自行回退文件系统时间并如实标注来源；
//   - 不解析时区（EXIF 该字段本就不带时区），语义按本地时间；
//   - 全程越界即退出并返回 null，绝不抛异常——它跑在目录列举路径上，
//     一张坏图不能影响整次列举。

export type ExifDateTag = 'DateTimeOriginal' | 'DateTimeDigitized' | 'DateTime'

export interface ExifShootDate {
  /** 'YYYY-MM-DDTHH:mm:ss'（本地时间语义，EXIF 不存时区） */
  iso: string
  /** 命中的标签名——调用方据此如实标注来源，不要笼统写成"拍摄日期" */
  tag: ExifDateTag
}

export const TAG_DATE_TIME = 0x0132
export const TAG_EXIF_IFD = 0x8769
export const TAG_DATE_TIME_ORIGINAL = 0x9003
export const TAG_DATE_TIME_DIGITIZED = 0x9004

/** 单条 IFD 的条目数上限——畸形文件里 count 可以大到 65535，防越界遍历 */
const MAX_IFD_ENTRIES = 512
/** 子 IFD 递归深度上限（IFD0 → ExifIFD 已足够） */
const MAX_IFD_DEPTH = 2

interface TiffView {
  buf: Buffer
  /** II = 小端，MM = 大端 */
  le: boolean
  /** TIFF 头在 buf 中的偏移，IFD 内的相对偏移都以此为基准 */
  base: number
}

function readU16(v: TiffView, off: number): number {
  return v.le ? v.buf.readUInt16LE(off) : v.buf.readUInt16BE(off)
}

function readU32(v: TiffView, off: number): number {
  return v.le ? v.buf.readUInt32LE(off) : v.buf.readUInt32BE(off)
}

function readAscii(v: TiffView, off: number, count: number): string {
  if (off < 0 || count <= 0) return ''
  const end = Math.min(off + count, v.buf.length)
  if (end <= off) return ''
  const s = v.buf.toString('latin1', off, end)
  const nul = s.indexOf('\0')
  return nul >= 0 ? s.slice(0, nul) : s
}

/** 定位 TIFF 头：裸 TIFF 自身，或 JPEG 的 APP1(Exif) 段载荷起点 */
function findTiffStart(buf: Buffer): number | null {
  if (buf.length < 8) return null
  const bareTiff = (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  if (bareTiff) return 0
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null

  let i = 2
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    // 填充字节 / 无长度字段的标记
    if (marker === 0xff) { i += 1; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    // SOS(压缩数据开始) / EOI —— 之前没找到 APP1 就没有 EXIF 了
    if (marker === 0xda || marker === 0xd9) return null
    const len = buf.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > buf.length) return null
    if (marker === 0xe1 && len >= 8 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      return i + 10
    }
    i += 2 + len
  }
  return null
}

/** 遍历一条 IFD，收集 ASCII 值；遇 ExifIFD 指针则下钻一层 */
function collectIfd(v: TiffView, ifdOffset: number, out: Map<number, string>, depth: number): void {
  if (depth > MAX_IFD_DEPTH) return
  const ifd = v.base + ifdOffset
  if (ifd + 2 > v.buf.length) return
  const count = readU16(v, ifd)
  if (count <= 0 || count > MAX_IFD_ENTRIES) return

  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12
    if (entry + 12 > v.buf.length) return
    const tag = readU16(v, entry)
    const type = readU16(v, entry + 2)
    const num = readU32(v, entry + 4)

    if (type === 2) { // ASCII
      const inline = num <= 4
      if (inline) {
        if (!out.has(tag)) out.set(tag, readAscii(v, entry + 8, num))
        continue
      }
      const abs = v.base + readU32(v, entry + 8)
      if (abs < v.base || abs >= v.buf.length) continue
      if (!out.has(tag)) out.set(tag, readAscii(v, abs, num))
    } else if (tag === TAG_EXIF_IFD && (type === 4 || type === 3)) {
      const sub = readU32(v, entry + 8)
      if (sub > 0 && v.base + sub < v.buf.length) collectIfd(v, sub, out, depth + 1)
    }
  }
}

/**
 * EXIF 日期写法固定为 'YYYY:MM:DD HH:MM:SS'（部分实现用 '-' 分隔）；
 * 相机未设置时间时会写成全零占位，这种要判为"无"而不是返回 0000-00-00。
 */
export function normalizeExifDate(raw: string | undefined): string | null {
  if (!raw) return null
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  if (y === '0000' || mo === '00' || d === '00') return null
  const moN = Number(mo)
  const dN = Number(d)
  if (moN < 1 || moN > 12 || dN < 1 || dN > 31) return null
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

/**
 * 抽取拍摄时间。按 DateTimeOriginal → DateTimeDigitized → DateTime 顺序取第一个可用值，
 * 与相机/图库工具的通用口径一致（原始拍摄时间优先于文件改写时间）。
 * 任何异常与畸形结构都收敛为 null。
 */
export function extractExifShootDate(buf: Buffer): ExifShootDate | null {
  try {
    const start = findTiffStart(buf)
    if (start === null || start + 8 > buf.length) return null
    const order = buf.toString('latin1', start, start + 2)
    if (order !== 'II' && order !== 'MM') return null
    const view: TiffView = { buf, le: order === 'II', base: start }
    if (readU16(view, start + 2) !== 42) return null
    const ifd0 = readU32(view, start + 4)
    if (ifd0 <= 0 || start + ifd0 >= buf.length) return null

    const values = new Map<number, string>()
    collectIfd(view, ifd0, values, 0)

    const priority: Array<[number, ExifDateTag]> = [
      [TAG_DATE_TIME_ORIGINAL, 'DateTimeOriginal'],
      [TAG_DATE_TIME_DIGITIZED, 'DateTimeDigitized'],
      [TAG_DATE_TIME, 'DateTime']
    ]
    for (const [tag, name] of priority) {
      const iso = normalizeExifDate(values.get(tag))
      if (iso) return { iso, tag: name }
    }
    return null
  } catch {
    return null
  }
}
