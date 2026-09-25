// 2026-09-25（HANDOFF「下一步 1」做法②）：Q14「列桌面 .docx 清单」的确定性收口。
// 纯函数单测——覆盖「抽取扩展名 / 判定列清单意图 / 按扩展名过滤 / 渲染清单」四件事，
// 以及最容易出错的边界：读内容意图不得被误判为列清单、目录项必须排除、空结果如实说明。
import { describe, it, expect } from 'vitest'
import { extractListingExt, isListingIntent, filterByExt, formatExtListing } from '@/services/fileListing'
import { EXAM_CASES } from '@/exam/examCases'

const q14 = EXAM_CASES.find(c => c.id === 'Q14')!
const q16 = EXAM_CASES.find(c => c.id === 'Q16')!

describe('extractListingExt：从自然语言抽扩展名', () => {
  it('带点的 .docx', () => {
    expect(extractListingExt(q14.prompt)).toBe('docx')
  })
  it('不带点的「docx 文件」', () => {
    expect(extractListingExt('桌面上有哪些 docx 文件')).toBe('docx')
  })
  it('别名 word → docx / xls → xlsx / jpg → jpeg', () => {
    expect(extractListingExt('列出所有 word 文档')).toBe('docx')
    expect(extractListingExt('看看有哪些 xls')).toBe('xlsx')
    expect(extractListingExt('列出 .jpg 图片')).toBe('jpeg')
  })
  it('无扩展名线索返回 null', () => {
    expect(extractListingExt('帮我润色一下这段话')).toBeNull()
    expect(extractListingExt('把这个文件夹里的图片列个清单')).toBeNull()
  })
})

describe('isListingIntent：列清单 vs 读内容', () => {
  it('Q14 是列清单意图', () => {
    expect(isListingIntent(q14.prompt)).toBe(true)
  })
  it('要求读内容的不算列清单（即使含「列出/清单」字样）', () => {
    expect(isListingIntent('把桌面 docx 文件的内容列出来')).toBe(false)
    expect(isListingIntent('列出这些文件里写了什么')).toBe(false)
  })
  it('Q16 找报销金额：含「金额/是多少」——不是列清单', () => {
    expect(isListingIntent(q16.prompt)).toBe(false)
  })
  it('纯「有哪些文件」是列清单', () => {
    expect(isListingIntent('桌面上有哪些文件')).toBe(true)
  })
})

describe('filterByExt：按扩展名过滤目录项', () => {
  const entries = [
    { name: 'a.docx', isDir: false },
    { name: 'b.txt', isDir: false },
    { name: '快照-九批.docx', isDir: false },
    { name: 'HoloExam', isDir: true },
    { name: 'projects', isDir: true },
    { name: 'C.DOCX', isDir: false }
  ]
  it('只保留匹配扩展名的文件、排除子目录、保持原顺序', () => {
    expect(filterByExt(entries, 'docx')).toEqual(['a.docx', '快照-九批.docx', 'C.DOCX'])
  })
  it('扩展名大小写不敏感（含带点写法）', () => {
    expect(filterByExt(entries, '.DOCX')).toEqual(['a.docx', '快照-九批.docx', 'C.DOCX'])
  })
  it('无匹配返回空数组', () => {
    expect(filterByExt(entries, 'pdf')).toEqual([])
  })
  it('未标 isDir 的条目按文件处理（entries 分支没有目录元数据）', () => {
    expect(filterByExt([{ name: 'x.docx' }, { name: 'y.md' }], 'docx')).toEqual(['x.docx'])
  })
})

describe('formatExtListing：渲染确定性清单（纯文本换行，不用 markdown 列表）', () => {
  it('非空：头部给出目录与数量，正文每行一个文件名', () => {
    const out = formatExtListing('C:\\Users\\Administrator\\Desktop', 'docx', ['a.docx', 'b.docx'])
    expect(out).toContain('共 2 个')
    const bodyLines = out.split('\n').slice(1)
    expect(bodyLines).toEqual(['a.docx', 'b.docx'])
    // 绝不能出现 markdown 列表标记——native 快路径经 beautify(html)+stripHtml，<li> 会粘连
    expect(out).not.toMatch(/^\s*[-*+]\s/m)
    expect(out).not.toMatch(/^\s*\d+\.\s/m)
  })
  it('空结果如实说明未找到（不编造）', () => {
    const out = formatExtListing('C:\\x', 'docx', [])
    expect(out).toContain('未找到')
    expect(out).toContain('.docx')
  })
})
