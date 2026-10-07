import { describe, it, expect } from 'vitest'
import { parseExtSpec, matchesExtSpec } from '@electron/fileMoveBatch'

// ─────────────────────────────────────────────────────────────────────────────
// 批量移动的扩展名过滤器（2026-10-08）
//
// 这段逻辑原来内联在 electron/ipc-handlers.ts 的 file:move 里，只有 electron 环境跑得到 ⇒ 无单测可钉。
// 抽成纯函数后把三条边界钉死：
//   ① 空规格 = **不过滤**（移动目录下全部文件）——这是"会把用户没点名的文件搬走"的那个危险语义，
//      必须有显式测试，防止有人把它当成"什么都没匹配"；
//   ② 单个扩展名的行为与旧内联实现逐字一致（大小写不敏感、前缀点可省）；
//   ③ 逗号分隔的**扩展名集**（类型词请求要靠它，"图片" ≠ 只有 .jpg）。
// ─────────────────────────────────────────────────────────────────────────────

describe('parseExtSpec：ext 规格 → 扩展名集', () => {
  it('单个扩展名（点可省、大小写不敏感）', () => {
    expect(parseExtSpec('docx')).toEqual(['docx'])
    expect(parseExtSpec('.DOCX')).toEqual(['docx'])
    expect(parseExtSpec('  Jpg ')).toEqual(['jpg'])
  })

  it('逗号分隔的集合', () => {
    expect(parseExtSpec('jpg,png,GIF')).toEqual(['jpg', 'png', 'gif'])
    expect(parseExtSpec(' jpg , .png ,, ')).toEqual(['jpg', 'png'])
  })

  it('空/空白 ⇒ 空集（= 不过滤，全部文件）', () => {
    expect(parseExtSpec('')).toEqual([])
    expect(parseExtSpec(' , , ')).toEqual([])
    expect(parseExtSpec(undefined)).toEqual([])
  })
})

describe('matchesExtSpec：文件名是否落在集合内', () => {
  it('空集 = 全部通过（危险语义，显式钉住）', () => {
    expect(matchesExtSpec('a.docx', [])).toBe(true)
    expect(matchesExtSpec('no-extension', [])).toBe(true)
  })

  it('单扩展名：与旧内联实现同口径（大小写不敏感、需真以 .ext 结尾）', () => {
    expect(matchesExtSpec('a.docx', ['docx'])).toBe(true)
    expect(matchesExtSpec('A.DOCX', ['docx'])).toBe(true)
    expect(matchesExtSpec('a.txt', ['docx'])).toBe(false)
    expect(matchesExtSpec('no-extension', ['docx'])).toBe(false)
    expect(matchesExtSpec('docx', ['docx'])).toBe(false) // 没有点 ⇒ 不匹配
    expect(matchesExtSpec('adocx', ['docx'])).toBe(false)
  })

  it('扩展名集：任一命中即可（"图片"这类类型词靠它）', () => {
    const images = parseExtSpec('jpg,jpeg,png,gif,bmp,webp,tiff,heic')
    expect(matchesExtSpec('IMG_0001.JPG', images)).toBe(true)
    expect(matchesExtSpec('shot.png', images)).toBe(true)
    expect(matchesExtSpec('doc.pdf', images)).toBe(false)
    expect(matchesExtSpec('note.md', images)).toBe(false)
  })

  it('多点文件名：按"以 .ext 结尾"判定（与旧实现一致，非"最后一段点"）', () => {
    expect(matchesExtSpec('archive.tar.gz', ['gz'])).toBe(true)
    expect(matchesExtSpec('archive.tar.gz', ['tar'])).toBe(false)
  })
})
