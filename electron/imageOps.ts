// 第二波·图像能力：批量图像处理（主进程）。
//
// 为什么用 sharp：它是"二进制以 npm 平台包形式发布"的标准形态——`@img/sharp-win32-x64`
// 直接从 registry 装下来（不走 GitHub），N-API 预编译所以在 Electron 里免 rebuild
// （本机实测：Electron 33 + sharp 0.35.4 / libvips 8.18.6，1920×1200 → 800×500 JPEG 10239 字节，
//  webp 分支 RIFF/WEBP 头正常）。同一棵树里 @xenova/transformers 本来就带 sharp，
// 这里把它提为直接依赖：既是 externalizeDepsPlugin 外置的前提，也把版本从 0.32.6
// 顶到 0.35.4（该版本是 GHSA-f88m-g3jw-g9cj 与 GHSA-rgj7-g3m4-5g8c 的修复版）。
//
// 本模块只做「校验 → 逐文件处理 → 汇总」，不碰 IPC 与权限（那在 ipc-handlers 与 writeGate）。

import { existsSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import sharp from 'sharp'

/** 允许的输出格式 */
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/**
 * 允许的输入扩展名（**显式白名单**，不是"除黑名单外都行"）：
 * 不含 heic/heif —— libheif 正是既有通告 GHSA-rgj7-g3m4-5g8c 的领域，
 * 0.35.4 已修，但这里仍然按最小面收口：不支持的输入一律大声拒绝，而不是交给解码器去试。
 */
export const INPUT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'bmp', 'gif', 'svg'] as const

/** 单批最多处理文件数 / 单文件字节上限 / 像素上限（防解压炸弹） */
export const MAX_BATCH_FILES = 200
export const MAX_INPUT_BYTES = 64 * 1024 * 1024
export const MAX_INPUT_PIXELS = 100_000_000

export interface ImageOp {
  resize?: { width?: number; height?: number; percent?: number }
  format?: OutputFormat
  /** 有损格式的质量（1-100） */
  quality?: number
  rotate?: 90 | 180 | 270
  grayscale?: boolean
}

export interface ImageOpRequest {
  inputs: string[]
  op: ImageOp
  /** 缺省与各源文件同目录 */
  outDir?: string
  /** 缺省 '-out'，生成 `<原名><suffix>.<新扩展名>` */
  suffix?: string
}

export interface ImageOpOutput {
  from: string
  to: string
  bytes: number
  width: number
  height: number
  format: string
}

export interface ImageOpFailure {
  from: string
  error: string
}

export interface ImageOpResult {
  outputs: ImageOpOutput[]
  failures: ImageOpFailure[]
}

export function extOf(filePath: string): string {
  return extname(String(filePath || '')).replace(/^\./, '').toLowerCase()
}

/** 校验请求；返回拒绝原因（null = 通过）。所有拒绝都给出可读原因，不静默吞掉。 */
export function validateImageRequest(req: ImageOpRequest): string | null {
  if (!req || !Array.isArray(req.inputs) || req.inputs.length === 0) return '未提供任何源文件'
  if (req.inputs.length > MAX_BATCH_FILES) return `单批最多 ${MAX_BATCH_FILES} 个文件（收到 ${req.inputs.length} 个）`
  if (!req.op || typeof req.op !== 'object') return '未指定处理方式（op）'
  const { resize, format, quality, rotate } = req.op
  const hasAnyOp = !!(resize || format || quality !== undefined || rotate || req.op.grayscale)
  if (!hasAnyOp) return '未指定任何有效操作（resize/format/quality/rotate/grayscale 至少给一项）'
  if (format && !(OUTPUT_FORMATS as readonly string[]).includes(format)) {
    return `不支持的输出格式: ${format}（支持 ${OUTPUT_FORMATS.join(' / ')}）`
  }
  if (quality !== undefined && (!Number.isFinite(quality) || quality < 1 || quality > 100)) {
    return `quality 必须在 1-100 之间（收到 ${quality}）`
  }
  if (rotate !== undefined && ![90, 180, 270].includes(rotate)) return `rotate 只支持 90/180/270（收到 ${rotate}）`
  if (resize) {
    const nums = [resize.width, resize.height, resize.percent].filter(v => v !== undefined)
    if (nums.length === 0) return 'resize 需要 width / height / percent 之一'
    if (nums.some(v => !Number.isFinite(v) || (v as number) <= 0)) return 'resize 参数必须为正数'
    if (resize.percent !== undefined && resize.percent > 1000) return 'resize.percent 过大（上限 1000%）'
    if (resize.width !== undefined && resize.width > 20000) return 'resize.width 过大（上限 20000）'
    if (resize.height !== undefined && resize.height > 20000) return 'resize.height 过大（上限 20000）'
  }
  for (const p of req.inputs) {
    if (typeof p !== 'string' || !p.trim()) return '源文件路径为空'
    const ext = extOf(p)
    if (!(INPUT_EXTS as readonly string[]).includes(ext)) {
      return `不支持的源格式: .${ext || '(无扩展名)'}（支持 ${INPUT_EXTS.join(' / ')}）`
    }
  }
  return null
}

/** 输出路径：`<outDir|源目录>/<源名><suffix>.<由 format 决定的扩展名>` */
export function buildOutputPath(src: string, op: ImageOp, outDir?: string, suffix = '-out'): string {
  const srcExt = extOf(src)
  const targetFormat = op.format || (srcExt === 'jpg' ? 'jpeg' : srcExt)
  const targetExt = targetFormat === 'jpeg' ? 'jpg' : targetFormat
  const stem = basename(src, extname(src))
  const dir = outDir && outDir.trim() ? outDir : join(src, '..')
  return join(dir, `${stem}${suffix}.${targetExt}`)
}

/** 单个文件处理（内部函数，暴露给测试） */
export async function processOne(src: string, op: ImageOp, outPath: string): Promise<ImageOpOutput> {
  if (!existsSync(src)) throw new Error(`源文件不存在: ${src}`)
  const size = statSync(src).size
  if (size > MAX_INPUT_BYTES) throw new Error(`源文件过大（${Math.round(size / 1048576)}MB > ${MAX_INPUT_BYTES / 1048576}MB）`)
  if (size === 0) throw new Error('源文件为空')

  // limitInputPixels 防解压炸弹；failOn:'error' 让损坏文件报错而不是产出半图
  let pipe = sharp(src, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
  if (op.rotate) pipe = pipe.rotate(op.rotate)
  if (op.grayscale) pipe = pipe.grayscale()
  if (op.resize) {
    if (op.resize.percent !== undefined) {
      const meta = await sharp(src, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata()
      const w = meta.width ? Math.max(1, Math.round(meta.width * op.resize.percent / 100)) : undefined
      if (w) pipe = pipe.resize({ width: w, withoutEnlargement: true })
    } else {
      pipe = pipe.resize({ width: op.resize.width, height: op.resize.height, withoutEnlargement: true })
    }
  }
  const quality = op.quality ?? 82
  switch (op.format) {
    case 'png': pipe = pipe.png({ quality }); break
    case 'webp': pipe = pipe.webp({ quality }); break
    case 'avif': pipe = pipe.avif({ quality }); break
    case 'tiff': pipe = pipe.tiff({ quality }); break
    default: pipe = pipe.jpeg({ quality }); break
  }
  const info = await pipe.toFile(outPath)
  return { from: src, to: outPath, bytes: info.size, width: info.width, height: info.height, format: info.format }
}

/**
 * 批量处理。逐文件串行（避免同时开多份 libvips 抢 CPU），单文件失败不影响其余，
 * 失败逐条如实回传——调用方据此报告，不把部分成功说成全部成功。
 */
export async function processImages(req: ImageOpRequest): Promise<ImageOpResult> {
  const invalid = validateImageRequest(req)
  if (invalid) throw new Error(invalid)
  const outputs: ImageOpOutput[] = []
  const failures: ImageOpFailure[] = []
  for (const src of req.inputs) {
    try {
      const out = buildOutputPath(src, req.op, req.outDir, req.suffix ?? '-out')
      outputs.push(await processOne(src, req.op, out))
    } catch (e) {
      failures.push({ from: src, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { outputs, failures }
}
