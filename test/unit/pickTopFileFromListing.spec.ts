import { describe, it, expect } from 'vitest'
import { pickTopFileFromListing } from '@/services/listingPick'

/**
 * 修①（2026-09-25，离线复现坐实）：`pickTopFileFromListing` 从 list_directory 结果里挑"最相关的文件"，
 * 但 list_directory 的每一行是 **`文件名\t拍摄日期=YYYYMMDD（来源） [iso]`**（见 macroExecutor 的
 * list_directory 实现）。原实现把**整行**当文件名返回——扩展名剥离正则 `/\.\w{1,5}$/` 只认结尾，
 * 而行尾是 `]` ⇒ 不匹配 ⇒ 返回整行 ⇒ 拼出的路径带上 `\t拍摄日期=…` 垃圾
 * ⇒ `read_file` 必被安全策略拒（实测报 `…\快照-九批.doc`）⇒ 计划中断 ⇒ 回退。
 * 任何「列出某目录里的文件再读一份」的计划（文件检索探索计划、l2-weekly-report-draft-v1）都撞这条。
 *
 * 另：本函数的用途是给 read_file 提供路径，故只应挑**文本可读**文件；docx/pdf/zip/图片读不出内容。
 */
const LINE = (name: string, stamp = '20260925') => `${name}\t拍摄日期=${stamp}（取自文件系统时间） [2026-09-25T10:56:13.224Z]`

describe('pickTopFileFromListing —— 必须返回裸文件名（剥掉行内元数据）', () => {
  it('带 \\t 拍摄日期元数据的行 → 只返回文件名，不含 \\t 与元数据', () => {
    const listing = [LINE('00001.txt'), LINE('快照-九批.docx')].join('\n')
    const pick = pickTopFileFromListing(listing, '帮我看一下桌面上有哪些 .docx 文件')
    expect(pick).toBe('00001.txt')
    expect(pick).not.toContain('\t')
    expect(pick).not.toContain('拍摄日期')
  })

  it('只挑文本可读文件：docx/pdf/zip/图片不入选', () => {
    const listing = [
      LINE('快照-九批.docx'),
      LINE('2026.9.24最新快照.pdf'),
      LINE('bysj133.zip'),
      LINE('wechat.jfif')
    ].join('\n')
    expect(pickTopFileFromListing(listing, '帮我看一下桌面上有哪些 .docx 文件')).toBe('')
  })

  it('目录行（结尾 /）与占位行被排除；无可读文件时返回空串（调用方据此跳过该步）', () => {
    const listing = [LINE('HoloExam/'), '(空目录)', LINE('a.png')].join('\n')
    expect(pickTopFileFromListing(listing, 'x')).toBe('')
  })

  it('多个文本文件时按与用户文本的匹配度选（名字命中优先）', () => {
    const listing = [LINE('notes.txt'), LINE('haidian1.txt')].join('\n')
    expect(pickTopFileFromListing(listing, '看一下 haidian1 的内容')).toBe('haidian1.txt')
  })

  it('裸清单（无元数据，如旧格式纯名字）仍工作', () => {
    const listing = ['alpha.txt', 'beta.md'].join('\n')
    expect(pickTopFileFromListing(listing, '读一下 beta 的内容')).toBe('beta.md')
  })
})
