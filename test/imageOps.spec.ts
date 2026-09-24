import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  validateImageRequest,
  buildOutputPath,
  processOne,
  processImages,
  INPUT_EXTS,
  MAX_BATCH_FILES,
  MAX_INPUT_BYTES,
  OUTPUT_FORMATS,
  type ImageOpRequest
} from '@electron/imageOps'
import { buildImageProcessArgs } from '@/services/nativeTools'
import sharp from 'sharp'

// 真 sharp（libvips）跑真实图片：既能验证参数语义，也顺带证明这个原生包在 vitest/node 下可用。
const fixtures = join(process.cwd(), 'test', 'fixtures')
const srcJpg = join(fixtures, 'no-exif.jpg')     // 8x8 JPEG（Pillow 生成）
const srcPng = join(fixtures, 'exif-datetime-only.jpg')
let outDir: string

beforeAll(() => { outDir = mkdtempSync(join(tmpdir(), 'holo-img-')) })
afterAll(() => { rmSync(outDir, { recursive: true, force: true }) })

describe('imageOps - 请求校验（失败一律给可读原因）', () => {
  const base = (over: Partial<ImageOpRequest>): ImageOpRequest => ({
    inputs: [srcJpg], op: { resize: { width: 4 } }, ...over
  })

  it('放行合法请求（各操作单独与组合）', () => {
    expect(validateImageRequest(base({}))).toBeNull()
    expect(validateImageRequest(base({ op: { format: 'webp', quality: 70 } }))).toBeNull()
    expect(validateImageRequest(base({ op: { rotate: 90, grayscale: true } }))).toBeNull()
    expect(validateImageRequest(base({ op: { resize: { percent: 50 } } }))).toBeNull()
  })

  it('拒绝空输入 / 超批量 / 无操作 / 非法参数', () => {
    expect(validateImageRequest(base({ inputs: [] }))).toContain('未提供任何源文件')
    expect(validateImageRequest(base({ inputs: Array(MAX_BATCH_FILES + 1).fill(srcJpg) }))).toContain('最多')
    expect(validateImageRequest(base({ op: {} }))).toContain('未指定任何有效操作')
    expect(validateImageRequest(base({ op: { format: 'bmp' as never } }))).toContain('不支持的输出格式')
    expect(validateImageRequest(base({ op: { quality: 0 } }))).toContain('1-100')
    expect(validateImageRequest(base({ op: { quality: 101 } }))).toContain('1-100')
    expect(validateImageRequest(base({ op: { rotate: 45 as never } }))).toContain('90/180/270')
    expect(validateImageRequest(base({ op: { resize: { width: -1 } } }))).toContain('正数')
    expect(validateImageRequest(base({ op: { resize: { width: 99999 } } }))).toContain('过大')
  })

  it('输入扩展名走显式白名单——heic 等不在列表内即拒绝（不做"交给解码器去试"）', () => {
    expect(INPUT_EXTS).not.toContain('heic')
    expect(INPUT_EXTS).not.toContain('heif')
    expect(validateImageRequest(base({ inputs: ['C:\\x\\a.heic'] }))).toContain('不支持的源格式')
    expect(validateImageRequest(base({ inputs: ['C:\\x\\a.txt'] }))).toContain('不支持的源格式')
    expect(validateImageRequest(base({ inputs: [srcJpg] }))).toBeNull()
  })
})

describe('imageOps - 输出路径与格式映射', () => {
  it('缺省同目录 + -out 后缀；扩展名按目标格式（jpeg→jpg）', () => {
    expect(buildOutputPath('C:\\pics\\a.png', { resize: { width: 4 } })).toBe('C:\\pics\\a-out.png')
    expect(buildOutputPath('C:\\pics\\a.png', { format: 'jpeg' })).toBe('C:\\pics\\a-out.jpg')
    expect(buildOutputPath('C:\\pics\\a.png', { format: 'webp' })).toBe('C:\\pics\\a-out.webp')
    expect(buildOutputPath('C:\\pics\\a.jpg', {})).toBe('C:\\pics\\a-out.jpg')
  })

  it('显式 outDir 与自定义后缀生效', () => {
    expect(buildOutputPath('C:\\pics\\a.png', { format: 'png' }, 'C:\\out', '-small')).toBe('C:\\out\\a-small.png')
  })

  it('支持的输出格式集合与文档一致', () => {
    expect([...OUTPUT_FORMATS]).toEqual(['jpeg', 'png', 'webp', 'avif', 'tiff'])
  })
})

describe('imageOps - 真 sharp 处理真实图片', () => {
  it('按宽度缩放：尺寸真的变了，且产物可被再次解码', async () => {
    const out = join(outDir, 'resized.jpg')
    const r = await processOne(srcJpg, { resize: { width: 4 } }, out)
    expect(existsSync(out)).toBe(true)
    expect(r.width).toBe(4)
    expect(r.height).toBe(4)
    expect(r.bytes).toBeGreaterThan(0)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(4)
    expect(meta.format).toBe('jpeg')
  })

  it('percent 缩放：8x8 的 50% → 4x4', async () => {
    const out = join(outDir, 'half.png')
    const r = await processOne(srcJpg, { resize: { percent: 50 }, format: 'png' }, out)
    expect([r.width, r.height]).toEqual([4, 4])
    expect(r.format).toBe('png')
  })

  it('格式转换 jpg → webp：产物是真 webp（RIFF/WEBP 头）', async () => {
    const out = join(outDir, 'conv.webp')
    await processOne(srcJpg, { format: 'webp', quality: 70 }, out)
    const head = readFileSync(out).subarray(0, 12).toString('latin1')
    expect(head.startsWith('RIFF')).toBe(true)
    expect(head).toContain('WEBP')
  })

  it('灰度 + 旋转 90 不改尺寸（8x8 方图）', async () => {
    const out = join(outDir, 'gray.jpg')
    const r = await processOne(srcPng, { grayscale: true, rotate: 90 }, out)
    expect([r.width, r.height]).toEqual([8, 8])
  })

  it('批量：单个失败不影响其余，失败逐条回传（不把部分成功说成全部成功）', async () => {
    const res = await processImages({
      inputs: [srcJpg, join(fixtures, '不存在.jpg'), srcPng],
      op: { resize: { width: 4 } },
      outDir,
      suffix: '-batch'
    })
    expect(res.outputs).toHaveLength(2)
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0].from).toContain('不存在.jpg')
    expect(res.failures[0].error).toContain('源文件不存在')
  })

  it('请求非法时批量入口直接抛错（不进入逐文件循环）', async () => {
    await expect(processImages({ inputs: [], op: {} })).rejects.toThrow('未提供任何源文件')
  })

  it('常量与实现一致（防文档漂移）', () => {
    expect(MAX_BATCH_FILES).toBe(200)
    expect(MAX_INPUT_BYTES).toBe(64 * 1024 * 1024)
    expect(statSync(srcJpg).size).toBeLessThan(MAX_INPUT_BYTES)
  })
})

// 两条工具执行路径（macroExecutor / dialogStore）共用这个整理函数，所以它的行为要单独钉住。
describe('nativeTools - buildImageProcessArgs（模型扁平参数 → 请求体）', () => {
  it('字符串与数组两种 inputs 都接受，缺失则为空数组', () => {
    expect(buildImageProcessArgs({ inputs: 'C:\\a.jpg' }).inputs).toEqual(['C:\\a.jpg'])
    expect(buildImageProcessArgs({ inputs: ['C:\\a.jpg', 'C:\\b.png'] }).inputs).toEqual(['C:\\a.jpg', 'C:\\b.png'])
    expect(buildImageProcessArgs({ path: 'C:\\c.jpg' }).inputs).toEqual(['C:\\c.jpg'])
    expect(buildImageProcessArgs({}).inputs).toEqual([])
  })

  it('扁平参数编成 op 对象；未给的操作不出现（避免空对象被当成"有操作"）', () => {
    expect(buildImageProcessArgs({ inputs: 'a.jpg', width: 800 }).op).toEqual({ resize: { width: 800 } })
    expect(buildImageProcessArgs({ inputs: 'a.jpg', percent: 50, format: 'WEBP', quality: 70 }).op)
      .toEqual({ resize: { percent: 50 }, format: 'webp', quality: 70 })
    expect(buildImageProcessArgs({ inputs: 'a.jpg', grayscale: true }).op).toEqual({ grayscale: true })
    expect(buildImageProcessArgs({ inputs: 'a.jpg' }).op).toEqual({})
  })

  // 清单里的可选槽未绑定时是字面量 {{target_width}}：必须当作"没给"，不能变成 Number(...)=NaN
  it('未绑定的 {{...}} 占位符被丢弃（可选槽不污染参数）', () => {
    const r = buildImageProcessArgs({
      inputs: '{{image_files}}', width: '{{target_width}}', format: '{{target_format}}', quality: '{{target_quality}}'
    })
    expect(r.inputs).toEqual([])
    expect(r.op).toEqual({})
  })

  it('outDir / suffix 透传，空值不带', () => {
    expect(buildImageProcessArgs({ inputs: 'a.jpg', outDir: 'C:\\out', suffix: '-small' }))
      .toEqual({ inputs: ['a.jpg'], op: {}, outDir: 'C:\\out', suffix: '-small' })
    expect(buildImageProcessArgs({ inputs: 'a.jpg', suffix: '' })).toEqual({ inputs: ['a.jpg'], op: {} })
  })
})
