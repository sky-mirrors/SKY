import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import {
  extractExifShootDate,
  normalizeExifDate,
  TAG_DATE_TIME,
  TAG_DATE_TIME_ORIGINAL,
  TAG_EXIF_IFD
} from '@electron/exifDate'

// ---------------------------------------------------------------------------
// 合成字节构造器：相机文件端序不一（II/MM），且 DateTimeOriginal 放在 ExifIFD
// 子目录里——单靠 Pillow 生成的素材无法覆盖端序分支，故这里手工拼一份 TIFF/JPEG。
// ---------------------------------------------------------------------------
interface SynthEntry { tag: number; ascii: string }

function buildTiff(opts: { le: boolean; ifd0: SynthEntry[]; exifIfd?: SynthEntry[] }): Buffer {
  const le = opts.le
  const entrySize = 12
  const sub = opts.exifIfd ?? []
  const hasSub = sub.length > 0
  const ifd0Count = opts.ifd0.length + (hasSub ? 1 : 0)

  const ifd0Offset = 8
  const ifd0Size = 2 + ifd0Count * entrySize + 4
  const ifd0ValuesOffset = ifd0Offset + ifd0Size
  const ifd0ValueBytes = opts.ifd0.reduce((n, e) => n + e.ascii.length + 1, 0)
  const subIfdOffset = ifd0ValuesOffset + ifd0ValueBytes
  const subSize = hasSub ? 2 + sub.length * entrySize + 4 : 0
  const subValuesOffset = subIfdOffset + subSize
  const subValueBytes = sub.reduce((n, e) => n + e.ascii.length + 1, 0)

  const b = Buffer.alloc(subValuesOffset + subValueBytes)
  if (le) {
    b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(ifd0Offset, 4)
  } else {
    b.write('MM', 0, 'latin1'); b.writeUInt16BE(42, 2); b.writeUInt32BE(ifd0Offset, 4)
  }
  const w16 = (v: number, o: number): void => { if (le) b.writeUInt16LE(v, o); else b.writeUInt16BE(v, o) }
  const w32 = (v: number, o: number): void => { if (le) b.writeUInt32LE(v, o); else b.writeUInt32BE(v, o) }

  let p = ifd0Offset
  w16(ifd0Count, p); p += 2
  let valOff = ifd0ValuesOffset
  for (const e of opts.ifd0) {
    w16(e.tag, p); w16(2, p + 2); w32(e.ascii.length + 1, p + 4); w32(valOff, p + 8)
    b.write(`${e.ascii}\0`, valOff, 'latin1')
    valOff += e.ascii.length + 1
    p += entrySize
  }
  if (hasSub) {
    w16(TAG_EXIF_IFD, p); w16(4, p + 2); w32(1, p + 4); w32(subIfdOffset, p + 8)
    p += entrySize
  }
  w32(0, p)

  if (hasSub) {
    let q = subIfdOffset
    w16(sub.length, q); q += 2
    let so = subValuesOffset
    for (const e of sub) {
      w16(e.tag, q); w16(2, q + 2); w32(e.ascii.length + 1, q + 4); w32(so, q + 8)
      b.write(`${e.ascii}\0`, so, 'latin1')
      so += e.ascii.length + 1
      q += entrySize
    }
    w32(0, q)
  }
  return b
}

function wrapJpeg(tiff: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(payload.length + 2)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, payload, Buffer.from([0xff, 0xd9])
  ])
}

const fixture = (name: string): Buffer => {
  const p = resolve(process.cwd(), 'test', 'fixtures', name)
  expect(existsSync(p), `素材缺失: ${p}`).toBe(true)
  return readFileSync(p)
}

// ---------------------------------------------------------------------------
// 真实文件：素材由 Pillow 生成（独立实现），期望值取自 Pillow 的回读结果
// ---------------------------------------------------------------------------
describe('EXIF 拍摄时间——真实素材（Pillow 生成，独立实现对账）', () => {
  it('DateTimeOriginal 优先于被改写过的 DateTime', () => {
    const r = extractExifShootDate(fixture('exif-datetimeoriginal.jpg'))
    // Pillow 回读：ExifIFD.DateTimeOriginal='2019:07:04 15:30:22'，IFD0.DateTime='2026:09:24 11:00:00'
    expect(r).toEqual({ iso: '2019-07-04T15:30:22', tag: 'DateTimeOriginal' })
  })

  it('只有 IFD0.DateTime 时回退到 DateTime', () => {
    const r = extractExifShootDate(fixture('exif-datetime-only.jpg'))
    expect(r).toEqual({ iso: '2021-03-09T08:07:06', tag: 'DateTime' })
  })

  it('完全无 EXIF 的图片返回 null（考试素材即此情形）', () => {
    expect(extractExifShootDate(fixture('no-exif.jpg'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 端序 / 结构分支：合成字节
// ---------------------------------------------------------------------------
describe('EXIF 拍摄时间——端序与结构分支', () => {
  it('小端（II）+ ExifIFD 里的 DateTimeOriginal', () => {
    const buf = wrapJpeg(buildTiff({
      le: true,
      ifd0: [{ tag: TAG_DATE_TIME, ascii: '2026:01:02 03:04:05' }],
      exifIfd: [{ tag: TAG_DATE_TIME_ORIGINAL, ascii: '2018:12:31 23:59:58' }]
    }))
    expect(extractExifShootDate(buf)).toEqual({ iso: '2018-12-31T23:59:58', tag: 'DateTimeOriginal' })
  })

  it('大端（MM）同样可解析', () => {
    const buf = wrapJpeg(buildTiff({
      le: false,
      ifd0: [{ tag: TAG_DATE_TIME, ascii: '2020:05:06 07:08:09' }]
    }))
    expect(extractExifShootDate(buf)).toEqual({ iso: '2020-05-06T07:08:09', tag: 'DateTime' })
  })

  it('裸 TIFF（无 JPEG 外壳）也能读', () => {
    const tiff = buildTiff({ le: true, ifd0: [{ tag: TAG_DATE_TIME, ascii: '2017:07:07 07:07:07' }] })
    expect(extractExifShootDate(tiff)).toEqual({ iso: '2017-07-07T07:07:07', tag: 'DateTime' })
  })

  it('全零占位（相机未设时间）视为无', () => {
    const buf = wrapJpeg(buildTiff({
      le: true,
      ifd0: [],
      exifIfd: [{ tag: TAG_DATE_TIME_ORIGINAL, ascii: '0000:00:00 00:00:00' }]
    }))
    expect(extractExifShootDate(buf)).toBeNull()
  })

  it('截断 / 非图片 / 空输入不抛异常，一律 null', () => {
    const full = wrapJpeg(buildTiff({ le: true, ifd0: [{ tag: TAG_DATE_TIME, ascii: '2020:05:06 07:08:09' }] }))
    expect(() => extractExifShootDate(full.subarray(0, 10))).not.toThrow()
    expect(extractExifShootDate(full.subarray(0, 10))).toBeNull()
    expect(extractExifShootDate(Buffer.from('这不是图片', 'utf8'))).toBeNull()
    expect(extractExifShootDate(Buffer.alloc(0))).toBeNull()
  })

  it('APP1 载荷长度自相矛盾时收敛为 null', () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.alloc(16)
    ])
    expect(extractExifShootDate(buf)).toBeNull()
  })
})

describe('normalizeExifDate', () => {
  it('接受 EXIF 标准写法与短横线变体', () => {
    expect(normalizeExifDate('2019:07:04 15:30:22')).toBe('2019-07-04T15:30:22')
    expect(normalizeExifDate('2019-07-04T15:30:22')).toBe('2019-07-04T15:30:22')
  })

  it('拒绝占位值、越界月日与非日期串', () => {
    expect(normalizeExifDate('0000:00:00 00:00:00')).toBeNull()
    expect(normalizeExifDate('2019:13:04 15:30:22')).toBeNull()
    expect(normalizeExifDate('2019:07:32 15:30:22')).toBeNull()
    expect(normalizeExifDate('not a date')).toBeNull()
    expect(normalizeExifDate(undefined)).toBeNull()
  })
})
