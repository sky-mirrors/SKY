import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { listDirectoryWithMeta } from '@electron/fileListing'

// file:list 的数据路径契约：handler 注册在 setupIpc 闭包里拿不到，故此处直接对真实目录断言——
// 「列举结果里带没带对拍摄时间」正是 Q15 与「按拍摄时间整理照片」依赖的那条契约。
const fixturesDir = resolve(process.cwd(), 'test', 'fixtures')

describe('file:list 数据路径——列举真实目录并取材 EXIF', () => {
  const { entries, entriesWithMeta } = listDirectoryWithMeta(fixturesDir)
  const by = (n: string) => entriesWithMeta.find(e => e.name === n)

  it('两个清单的条目名一一对应（契约不漂移）', () => {
    expect(entriesWithMeta.map(e => e.name)).toEqual([...entries])
  })

  it('带 DateTimeOriginal 的图片：取 EXIF 值，而不是文件系统时间', () => {
    const e = by('exif-datetimeoriginal.jpg')
    expect(e?.isDir).toBe(false)
    expect(e?.shootDateIso).toBe('2019-07-04T15:30:22')
    expect(e?.shootDateTag).toBe('DateTimeOriginal')
    // 同时保留 mtime 供回退/对照，且两者确实不同（否则本条测试证明不了"优先用 EXIF"）
    expect(typeof e?.mtimeIso).toBe('string')
    expect(e?.mtimeIso).not.toBe(e?.shootDateIso)
  })

  it('只有 DateTime 的图片：回退到 DateTime 并如实带出标签名', () => {
    const e = by('exif-datetime-only.jpg')
    expect(e?.shootDateIso).toBe('2021-03-09T08:07:06')
    expect(e?.shootDateTag).toBe('DateTime')
  })

  it('无 EXIF 的图片：shootDateIso 为 null、mtimeIso 可用（调用方据此标注回退来源）', () => {
    const e = by('no-exif.jpg')
    expect(e?.shootDateIso).toBeNull()
    expect(e?.shootDateTag).toBeNull()
    expect(typeof e?.mtimeIso).toBe('string')
  })

  it('子目录不参与 EXIF 解析，且名字带尾斜杠', () => {
    const sub = listDirectoryWithMeta(resolve(process.cwd(), 'test')).entriesWithMeta.find(e => e.name === 'unit/')
    expect(sub?.isDir).toBe(true)
    expect(sub?.shootDateIso).toBeNull()
  })
})
