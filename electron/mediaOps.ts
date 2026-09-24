// 第三波·媒体能力：音视频处理（主进程）。
//
// 二进制来源与图像波同一条通道：`@ffmpeg-installer/win32-x64` 把 ffmpeg.exe（61.5MB）
// **当 npm 包体发布**，不走 GitHub、无 postinstall 下载。本机实测：Electron 主进程里
// spawn 固定 argv（不经 shell）可完成 生成→转码→抽音轨→缩略图→探元数据 全链路。
//
// ⚠️ 已知限制（如实记录，别当"最新版"）：该平台包内是 **2018 年的构建**
// （`ffmpeg version N-92722-gf22fcd4483`，即 4.1 世代）。常见容器/编码够用，但：
//   - 老构建的 demuxer/decoder 历史 CVE 较多，而 npm audit **不覆盖二进制内部版本**；
//   - 新编码（AV1 编码、部分新滤镜）不支持。
// 缓解：输入走显式白名单 + 体积上限 + 每步超时强杀 + 不接收网络输入（只处理本机文件）。
// 升级路径：`/mirror china` 后拉较新的构建，或改用 WASM 版 ffmpeg（较新但更慢）。
//
// 本模块只做「校验 → 组 argv → spawn → 汇总」；argv 组装是纯函数，单独可测。

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, extname, basename } from 'path'

/** 允许的输入扩展名（显式白名单） */
export const MEDIA_INPUT_EXTS = [
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv',
  'mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac',
  'gif', 'jpg', 'jpeg', 'png', 'bmp'
] as const

/** 允许的输出容器/音频格式（转码目标） */
export const MEDIA_OUTPUT_FORMATS = ['mp4', 'webm', 'gif', 'mp3', 'wav', 'aac'] as const
/** 出缩略图时允许的图片格式 */
export const THUMBNAIL_FORMATS = ['jpg', 'jpeg', 'png'] as const

/** format 字段的合法取值：转码目标 + 缩略图图片格式（由校验按场景区分） */
export type MediaTargetFormat = (typeof MEDIA_OUTPUT_FORMATS)[number] | (typeof THUMBNAIL_FORMATS)[number]

export const MAX_MEDIA_FILES = 20
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024
export const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000

export interface MediaOp {
  /** 目标容器/格式：转码时取 MEDIA_OUTPUT_FORMATS，出缩略图时取 THUMBNAIL_FORMATS */
  format?: MediaTargetFormat
  /** 视频质量（CRF，越小越好；18-32 常用） */
  crf?: number
  /** 裁剪起点（秒） */
  start?: number
  /** 裁剪时长（秒） */
  duration?: number
  /** 出缩略图的时刻（秒）——给了它就只产图片 */
  thumbnailAt?: number
  /** 缩放宽度（像素，等比） */
  width?: number
}

export interface MediaRequest {
  inputs: string[]
  op: MediaOp
  outDir?: string
  suffix?: string
}

export interface MediaOutput {
  from: string
  to: string
  bytes: number
}
export interface MediaFailure {
  from: string
  error: string
}
export interface MediaResult {
  outputs: MediaOutput[]
  failures: MediaFailure[]
  probe?: MediaProbeInfo
}

export interface MediaProbeInfo {
  durationSec?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
}

export function extOf(filePath: string): string {
  return extname(String(filePath || '')).replace(/^\./, '').toLowerCase()
}

/** 校验请求；返回拒绝原因（null = 通过） */
export function validateMediaRequest(req: MediaRequest): string | null {
  if (!req || !Array.isArray(req.inputs) || req.inputs.length === 0) return '未提供任何源文件'
  if (req.inputs.length > MAX_MEDIA_FILES) return `单批最多 ${MAX_MEDIA_FILES} 个文件（收到 ${req.inputs.length} 个）`
  const op = req.op
  if (!op || typeof op !== 'object') return '未指定处理方式（op）'
  const hasAny = !!(op.format || op.crf !== undefined || op.start !== undefined ||
    op.duration !== undefined || op.thumbnailAt !== undefined || op.width !== undefined)
  if (!hasAny) return '未指定任何有效操作（format/crf/start/duration/thumbnailAt/width 至少给一项）'
  const isThumbnail = op.thumbnailAt !== undefined
  if (op.format && !isThumbnail && !(MEDIA_OUTPUT_FORMATS as readonly string[]).includes(op.format)) {
    return `不支持的目标格式: ${op.format}（支持 ${MEDIA_OUTPUT_FORMATS.join(' / ')}）`
  }
  if (op.format && isThumbnail && !(THUMBNAIL_FORMATS as readonly string[]).includes(op.format)) {
    return `出缩略图时 format 只能是 ${THUMBNAIL_FORMATS.join(' / ')}（收到 ${op.format}）`
  }
  if (op.crf !== undefined && (!Number.isFinite(op.crf) || op.crf < 0 || op.crf > 51)) return `crf 必须在 0-51 之间（收到 ${op.crf}）`
  if (op.width !== undefined && (!Number.isFinite(op.width) || op.width <= 0 || op.width > 7680)) return `width 必须是 1-7680（收到 ${op.width}）`
  if (op.thumbnailAt !== undefined && (!Number.isFinite(op.thumbnailAt) || op.thumbnailAt < 0)) return `thumbnailAt 必须是非负数（收到 ${op.thumbnailAt}）`
  if (op.start !== undefined && (!Number.isFinite(op.start) || op.start < 0)) return `start 必须是非负数（收到 ${op.start}）`
  if (op.duration !== undefined && (!Number.isFinite(op.duration) || op.duration <= 0)) return `duration 必须为正数（收到 ${op.duration}）`
  for (const p of req.inputs) {
    if (typeof p !== 'string' || !p.trim()) return '源文件路径为空'
    const ext = extOf(p)
    if (!(MEDIA_INPUT_EXTS as readonly string[]).includes(ext)) {
      return `不支持的源格式: .${ext || '(无扩展名)'}（支持 ${MEDIA_INPUT_EXTS.join(' / ')}）`
    }
  }
  return null
}

/** 输出路径与扩展名：缩略图走图片扩展名，其余按目标格式（缺省沿用源格式） */
export function buildMediaOutputPath(src: string, op: MediaOp, outDir?: string, suffix = '-out'): string {
  const srcExt = extOf(src)
  const stem = basename(src, extname(src))
  const dir = outDir && outDir.trim() ? outDir : join(src, '..')
  let ext: string
  if (op.thumbnailAt !== undefined) ext = (op.format === 'png' ? 'png' : 'jpg')
  else ext = op.format || srcExt
  return join(dir, `${stem}${suffix}.${ext}`)
}

/**
 * 组装 ffmpeg argv（**纯函数**，单独可测）。
 * 约定：`-ss` 放在 `-i` 之前走快速定位；输出文件放最后；`-y` 覆盖已存在产物。
 */
export function buildFfmpegArgs(input: string, output: string, op: MediaOp): string[] {
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error']

  // 缩略图：只产一帧图片
  if (op.thumbnailAt !== undefined) {
    args.push('-ss', String(op.thumbnailAt))
    args.push('-i', input, '-frames:v', '1')
    if (op.width) args.push('-vf', `scale=${Math.round(op.width)}:-1`)
    args.push(output)
    return args
  }

  if (op.start !== undefined) args.push('-ss', String(op.start))
  args.push('-i', input)
  if (op.duration !== undefined) args.push('-t', String(op.duration))

  // 目标格式：缩略图走图片分支（上面已返回）；这里只可能是转码/音频容器。
  // 若调用方给了非法组合（如 format='png' 但没要缩略图），退回沿用源格式，避免产出扩展名与内容不符的文件。
  const target = op.format && (MEDIA_OUTPUT_FORMATS as readonly string[]).includes(op.format)
    ? op.format
    : extOf(input)
  const crf = op.crf !== undefined ? String(Math.round(op.crf)) : '23'
  const widthFilter = op.width ? `scale=${Math.round(op.width)}:-1` : null

  // 纯音频输出：丢掉视频轨，按格式选编码器
  if (['mp3', 'wav', 'aac'].includes(target)) {
    const acodec = target === 'mp3' ? 'libmp3lame' : target === 'wav' ? 'pcm_s16le' : 'aac'
    args.push('-vn', '-c:a', acodec)
    args.push(output)
    return args
  }

  if (target === 'gif') {
    const vf = [ 'fps=12', widthFilter ].filter(Boolean).join(',')
    args.push('-vf', vf, '-loop', '0')
    args.push(output)
    return args
  }

  if (target === 'webm') {
    args.push('-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis', '-deadline', 'realtime', '-cpu-used', '5')
    if (widthFilter) args.push('-vf', widthFilter)
    args.push(output)
    return args
  }

  // 缺省 mp4（含压缩）：H.264 + AAC，veryfast 换取可接受的等待
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac')
  if (widthFilter) args.push('-vf', widthFilter)
  args.push(output)
  return args
}

/** 解析 `ffmpeg -i` 的 stderr 得到时长/分辨率/编码（ffmpeg 自身即探针，省掉再拉一个 ffprobe 二进制） */
export function parseMediaProbe(stderr: string): MediaProbeInfo {
  const info: MediaProbeInfo = {}
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (dur) info.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
  const res = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (res) { info.width = Number(res[1]); info.height = Number(res[2]) }
  const v = /Video:\s*([A-Za-z0-9_]+)/.exec(stderr)
  if (v) info.videoCodec = v[1]
  const a = /Audio:\s*([A-Za-z0-9_]+)/.exec(stderr)
  if (a) info.audioCodec = a[1]
  return info
}

/** 平台包导出的 exe 路径（该包无类型声明，按需 require；只在主进程运行时调用） */
export function resolveFfmpegPath(): string {
  // 生产环境由 electron-vite 打成 CJS，require 可用；测试不调用本函数
  const mod = require('@ffmpeg-installer/ffmpeg') as { path?: string }
  if (!mod?.path) throw new Error('未找到 ffmpeg 可执行文件（@ffmpeg-installer/ffmpeg 未正确安装）')
  return mod.path
}

export interface SpawnResult { code: number; stdout: string; stderr: string }

/** 注入点：生产用真 ffmpeg，测试可替换 */
export type FfmpegRunner = (args: string[], timeoutMs?: number) => Promise<SpawnResult>

/** 生产实现：resolveFfmpegPath() 拿平台包里的 exe，固定 argv spawn（绝不拼 shell 字符串） */
export function createFfmpegRunner(ffmpegPath: string): FfmpegRunner {
  return (args, timeoutMs = FFMPEG_TIMEOUT_MS) => new Promise<SpawnResult>((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number, extra = ''): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr: stderr + extra })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(-1, `\n[超时 ${timeoutMs}ms 已强杀]`)
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e) => finish(-2, `\n[spawn 失败] ${e.message}`))
    child.on('close', (code) => finish(code ?? -3))
  })
}

/** 探元数据（失败不抛——调用方按需报告） */
export async function probeMedia(run: FfmpegRunner, input: string): Promise<MediaProbeInfo> {
  const r = await run(['-hide_banner', '-i', input], 30000)
  return parseMediaProbe(r.stderr)
}

/** 单文件处理 */
export async function processOneMedia(
  run: FfmpegRunner, src: string, op: MediaOp, outPath: string
): Promise<MediaOutput> {
  if (!existsSync(src)) throw new Error(`源文件不存在: ${src}`)
  const size = statSync(src).size
  if (size === 0) throw new Error('源文件为空')
  if (size > MAX_MEDIA_BYTES) throw new Error(`源文件过大（${Math.round(size / 1048576)}MB > ${MAX_MEDIA_BYTES / 1048576}MB）`)
  const args = buildFfmpegArgs(src, outPath, op)
  const r = await run(args)
  if (r.code !== 0) {
    const tail = r.stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 400)
    throw new Error(`ffmpeg 失败(code=${r.code}): ${tail || '(无输出)'}`)
  }
  if (!existsSync(outPath)) throw new Error('ffmpeg 返回成功但没有产物文件')
  const outSize = statSync(outPath).size
  if (outSize === 0) throw new Error('产物为 0 字节')
  return { from: src, to: outPath, bytes: outSize }
}

/** 批量处理：逐文件串行，单文件失败不影响其余，失败逐条如实回传 */
export async function processMedia(
  req: MediaRequest, run: FfmpegRunner
): Promise<MediaResult> {
  const invalid = validateMediaRequest(req)
  if (invalid) throw new Error(invalid)
  const outputs: MediaOutput[] = []
  const failures: MediaFailure[] = []
  let probe: MediaProbeInfo | undefined
  for (const [i, src] of req.inputs.entries()) {
    try {
      const out = buildMediaOutputPath(src, req.op, req.outDir, req.suffix ?? '-out')
      if (i === 0) probe = await probeMedia(run, src)
      outputs.push(await processOneMedia(run, src, req.op, out))
    } catch (e) {
      failures.push({ from: src, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { outputs, failures, ...(probe ? { probe } : {}) }
}
