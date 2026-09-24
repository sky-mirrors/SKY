import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  validateMediaRequest,
  buildMediaOutputPath,
  buildFfmpegArgs,
  parseMediaProbe,
  processMedia,
  MEDIA_INPUT_EXTS,
  MEDIA_OUTPUT_FORMATS,
  THUMBNAIL_FORMATS,
  MAX_MEDIA_FILES,
  type FfmpegRunner,
  type MediaRequest
} from '@electron/mediaOps'
import { buildMediaProcessArgs } from '@/services/nativeTools'

// 真 ffmpeg（真起 Electron + 真 spawn）在 test/e2e/mediaPipeline.e2e.ts，用 `npm run verify:media` 跑。
// 这里覆盖除"真跑 ffmpeg"以外的全链：校验、argv 组装、stderr 解析、批量与失败语义（注入 runner）。

let workDir: string
beforeAll(() => { workDir = mkdtempSync(join(tmpdir(), 'holo-media-')) })
afterAll(() => { rmSync(workDir, { recursive: true, force: true }) })

function realFixture(): string {
  const p = join(workDir, 'src.mp4')
  if (!existsSync(p)) writeFileSync(p, Buffer.alloc(2048, 7))
  return p
}

/** 假 runner：把"ffmpeg 会写产物"这一步显式化，便于验证对接与失败语义 */
function fakeRunner(opts: { code?: number; stderr?: string; create?: boolean; empty?: boolean } = {}): FfmpegRunner & { calls: string[][] } {
  const calls: string[][] = []
  const fn = (async (args: string[]) => {
    calls.push(args)
    if (args.includes('-i') && args.includes('-hide_banner') && args.length <= 4) {
      return { code: 0, stdout: '', stderr: 'Duration: 00:00:02.02, start: 0.000000, bitrate: 120 kb/s\n  Stream #0:0: Video: h264, 320x240\n  Stream #0:1: Audio: aac' }
    }
    const out = args[args.length - 1]
    if (opts.create !== false && out && !out.startsWith('-')) {
      try { writeFileSync(out, opts.empty ? Buffer.alloc(0) : Buffer.alloc(512, 1)) } catch { /* 目录不存在等 */ }
    }
    return { code: opts.code ?? 0, stdout: '', stderr: opts.stderr ?? '' }
  }) as FfmpegRunner & { calls: string[][] }
  fn.calls = calls
  return fn
}

describe('mediaOps - 请求校验', () => {
  const base = (over: Partial<MediaRequest> = {}): MediaRequest => ({ inputs: ['C:\\v\\a.mp4'], op: { format: 'mp4' }, ...over })

  it('放行常见合法请求', () => {
    expect(validateMediaRequest(base())).toBeNull()
    expect(validateMediaRequest(base({ op: { crf: 28 } }))).toBeNull()
    expect(validateMediaRequest(base({ op: { thumbnailAt: 1.5, width: 320 } }))).toBeNull()
    expect(validateMediaRequest(base({ op: { start: 0, duration: 5, width: 640 } }))).toBeNull()
    expect(validateMediaRequest(base({ op: { format: 'mp3' } }))).toBeNull()
  })

  it('拒绝空输入 / 超批量 / 无操作', () => {
    expect(validateMediaRequest(base({ inputs: [] }))).toContain('未提供任何源文件')
    expect(validateMediaRequest(base({ inputs: Array(MAX_MEDIA_FILES + 1).fill('a.mp4') }))).toContain('最多')
    expect(validateMediaRequest(base({ op: {} }))).toContain('未指定任何有效操作')
  })

  it('拒绝越界参数（格式/crf/width/时间）', () => {
    expect(validateMediaRequest(base({ op: { format: 'avi' as never } }))).toContain('不支持的目标格式')
    expect(validateMediaRequest(base({ op: { crf: 99 } }))).toContain('0-51')
    expect(validateMediaRequest(base({ op: { width: 0 } }))).toContain('1-7680')
    expect(validateMediaRequest(base({ op: { thumbnailAt: -1 } }))).toContain('非负数')
    expect(validateMediaRequest(base({ op: { duration: 0 } }))).toContain('正数')
  })

  it('输入走显式白名单：未知扩展名一律拒绝', () => {
    expect(MEDIA_INPUT_EXTS).toContain('mp4')
    expect(MEDIA_INPUT_EXTS).not.toContain('exe')
    expect(validateMediaRequest(base({ inputs: ['C:\\v\\a.exe'] }))).toContain('不支持的源格式')
    expect(validateMediaRequest(base({ inputs: ['C:\\v\\无扩展名'] }))).toContain('不支持的源格式')
  })

  it('输出格式集合与文档一致', () => {
    expect([...MEDIA_OUTPUT_FORMATS]).toEqual(['mp4', 'webm', 'gif', 'mp3', 'wav', 'aac'])
  })

  // format 的合法取值分两个场景：转码取容器/音频格式，缩略图取图片格式——混用必须被拒
  it('format 按场景区分：缩略图只收图片格式，转码只收容器/音频格式', () => {
    expect(validateMediaRequest(base({ op: { thumbnailAt: 1, format: 'png' } }))).toBeNull()
    expect(validateMediaRequest(base({ op: { thumbnailAt: 1, format: 'webm' as never } }))).toContain('出缩略图时')
    expect(validateMediaRequest(base({ op: { format: 'png' as never } }))).toContain('不支持的目标格式')
  })
})

describe('mediaOps - 输出路径', () => {
  it('缩略图走图片扩展名；其余按目标格式或沿用源格式', () => {
    expect(buildMediaOutputPath('C:\\v\\a.mp4', { thumbnailAt: 1 })).toBe('C:\\v\\a-out.jpg')
    expect(buildMediaOutputPath('C:\\v\\a.mp4', { thumbnailAt: 1, format: 'png' as never })).toBe('C:\\v\\a-out.png')
    expect(buildMediaOutputPath('C:\\v\\a.mov', { format: 'mp4' })).toBe('C:\\v\\a-out.mp4')
    expect(buildMediaOutputPath('C:\\v\\a.mp4', { crf: 28 })).toBe('C:\\v\\a-out.mp4')
    expect(buildMediaOutputPath('C:\\v\\a.mp4', { format: 'mp3' }, 'C:\\o', '-audio')).toBe('C:\\o\\a-audio.mp3')
  })
})

describe('mediaOps - ffmpeg argv 组装（纯函数，钉住参数语义）', () => {
  const IN = 'C:\\v\\in.mp4'
  const OUT = 'C:\\v\\out.mp4'

  it('缩略图：-ss 在 -i 前、只出 1 帧、可带缩放', () => {
    const a = buildFfmpegArgs(IN, 'C:\\v\\t.jpg', { thumbnailAt: 0.5, width: 160 })
    expect(a.slice(0, 2)).toEqual(['-y', '-hide_banner'])
    expect(a.join(' ')).toContain(`-ss 0.5 -i ${IN} -frames:v 1 -vf scale=160:-1`)
    expect(a[a.length - 1]).toBe('C:\\v\\t.jpg')
  })

  it('音轨抽取：丢掉视频轨并选对编码器', () => {
    expect(buildFfmpegArgs(IN, 'C:\\v\\o.mp3', { format: 'mp3' }).join(' ')).toContain('-vn -c:a libmp3lame')
    expect(buildFfmpegArgs(IN, 'C:\\v\\o.wav', { format: 'wav' }).join(' ')).toContain('-vn -c:a pcm_s16le')
    expect(buildFfmpegArgs(IN, 'C:\\v\\o.aac', { format: 'aac' }).join(' ')).toContain('-vn -c:a aac')
  })

  it('webm / gif 走各自编码器与滤镜', () => {
    expect(buildFfmpegArgs(IN, OUT, { format: 'webm' }).join(' ')).toContain('-c:v libvpx')
    const gif = buildFfmpegArgs(IN, 'C:\\v\\o.gif', { format: 'gif', width: 320 }).join(' ')
    expect(gif).toContain('-vf fps=12,scale=320:-1')
    expect(gif).toContain('-loop 0')
  })

  it('mp4 缺省 libx264 + crf 23；指定 crf 生效；缩放走 -vf', () => {
    expect(buildFfmpegArgs(IN, OUT, {}).join(' ')).toContain('-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac')
    expect(buildFfmpegArgs(IN, OUT, { crf: 30 }).join(' ')).toContain('-crf 30')
    expect(buildFfmpegArgs(IN, OUT, { width: 640 }).join(' ')).toContain('-vf scale=640:-1')
  })

  it('裁剪：-ss 必须出现在 -i 之前（快速定位），-t 在 -i 之后', () => {
    const a = buildFfmpegArgs(IN, OUT, { start: 2, duration: 3 })
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a.indexOf('-t')).toBeGreaterThan(a.indexOf('-i'))
    expect(a[a.indexOf('-ss') + 1]).toBe('2')
    expect(a[a.indexOf('-t') + 1]).toBe('3')
  })
})

describe('mediaOps - stderr 解析（ffmpeg 自身即探针）', () => {
  it('真实格式的 stderr 能抽出时长/分辨率/编码', () => {
    const stderr = [
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'test.mp4\':',
      '  Duration: 00:00:02.02, start: 0.000000, bitrate: 123 kb/s',
      '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 320x240, 118 kb/s',
      '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s'
    ].join('\n')
    expect(parseMediaProbe(stderr)).toEqual({
      durationSec: 2.02, width: 320, height: 240, videoCodec: 'h264', audioCodec: 'aac'
    })
  })

  it('解析不出就返回空对象（不猜、不抛）', () => {
    expect(parseMediaProbe('nonsense')).toEqual({})
  })
})

describe('mediaOps - 批量与失败语义（注入 runner）', () => {
  it('happy path：逐文件处理并回传产物字节数', async () => {
    const run = fakeRunner()
    const r = await processMedia({ inputs: [realFixture()], op: { crf: 28 }, outDir: workDir, suffix: '-ok' }, run)
    expect(r.failures).toHaveLength(0)
    expect(r.outputs).toHaveLength(1)
    expect(r.outputs[0].bytes).toBeGreaterThan(0)
    expect(r.probe).toMatchObject({ durationSec: 2.02, width: 320, height: 240 })
  })

  it('ffmpeg 非零退出：错误落到该文件，不产出 outputs', async () => {
    const run = fakeRunner({ code: 1, stderr: 'Invalid data found when processing input' })
    const r = await processMedia({ inputs: [realFixture()], op: { crf: 28 }, outDir: workDir, suffix: '-bad' }, run)
    expect(r.outputs).toHaveLength(0)
    expect(r.failures[0].error).toContain('code=1')
    expect(r.failures[0].error).toContain('Invalid data found')
  })

  // "不得假装成功"：ffmpeg 说成功但没产物 / 产物 0 字节，都必须算失败
  it('返回成功但无产物 → 判失败', async () => {
    const run = fakeRunner({ create: false })
    const r = await processMedia({ inputs: [realFixture()], op: { crf: 28 }, outDir: workDir, suffix: '-none' }, run)
    expect(r.outputs).toHaveLength(0)
    expect(r.failures[0].error).toContain('没有产物文件')
  })

  it('产物 0 字节 → 判失败', async () => {
    const run = fakeRunner({ empty: true })
    const r = await processMedia({ inputs: [realFixture()], op: { crf: 28 }, outDir: workDir, suffix: '-empty' }, run)
    expect(r.outputs).toHaveLength(0)
    expect(r.failures[0].error).toContain('0 字节')
  })

  it('部分失败：成功与失败分别回传，互不掩盖', async () => {
    const ok = realFixture()
    const missing = join(workDir, '不存在.mp4')
    const r = await processMedia({ inputs: [ok, missing], op: { crf: 28 }, outDir: workDir, suffix: '-mix' }, fakeRunner())
    expect(r.outputs).toHaveLength(1)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].error).toContain('源文件不存在')
  })
})

// 两条工具执行路径共用这个整理函数（macroExecutor / dialogStore），行为要单独钉住。
describe('nativeTools - buildMediaProcessArgs（扁平参数 → 请求体）', () => {
  it('inputs：字符串/数组/同义字段都收，缺失为空数组', () => {
    expect(buildMediaProcessArgs({ inputs: 'C:\\v\\a.mp4' }).inputs).toEqual(['C:\\v\\a.mp4'])
    expect(buildMediaProcessArgs({ inputs: ['a.mp4', 'b.mkv'] }).inputs).toEqual(['a.mp4', 'b.mkv'])
    expect(buildMediaProcessArgs({ source: 'c.webm' }).inputs).toEqual(['c.webm'])
    expect(buildMediaProcessArgs({}).inputs).toEqual([])
  })

  it('同义字段收编：targetFormat/target→format，thumbnail/atSecond→thumbnailAt', () => {
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', targetFormat: 'WEBM' }).op).toEqual({ format: 'webm' })
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', target: '.MP4' }).op).toEqual({ format: 'mp4' })
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', thumbnail: 3 }).op).toEqual({ thumbnailAt: 3 })
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', atSecond: 1.5 }).op).toEqual({ thumbnailAt: 1.5 })
  })

  it('crf/start/duration/width 透传；未给的操作不出现', () => {
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', crf: 30, start: 1, duration: 2, width: 640 }).op)
      .toEqual({ crf: 30, start: 1, duration: 2, width: 640 })
    expect(buildMediaProcessArgs({ inputs: 'a.mp4' }).op).toEqual({})
  })

  // 「质量」与 CRF 反义，宁可让模型显式说 crf 也不猜——这条防的是"猜错方向"
  it('刻意不把 quality 映射成 crf', () => {
    expect(buildMediaProcessArgs({ inputs: 'a.mp4', quality: 80 }).op).toEqual({})
  })

  it('未绑定的 {{...}} 占位符被丢弃（清单可选槽不污染参数）', () => {
    const r = buildMediaProcessArgs({
      inputs: '{{media_files}}', format: '{{target_format}}', crf: '{{target_crf}}', thumbnailAt: '{{thumbnail_at}}'
    })
    expect(r.inputs).toEqual([])
    expect(r.op).toEqual({})
  })
})
