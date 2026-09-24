import { describe, it, expect } from 'vitest'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import * as XLSX from 'xlsx'
import { extractDocumentText, isExtractableFile } from '@electron/docExtract'

describe('K-1: 文档文本提取（主进程真实解析，不再返回占位符）', () => {
  it('docx → 提取到真实正文', async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun('合同风险审查条款与金额合计')] })] }],
    })
    const buf = await Packer.toBuffer(doc)
    const text = await extractDocumentText('contract.docx', new Uint8Array(buf))
    expect(text).toContain('合同风险审查条款与金额合计')
  })

  it('xlsx → 提取到单元格文本', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['部门', '金额'], ['财务部', 1234]]), 'Sheet1')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    const text = await extractDocumentText('budget.xlsx', new Uint8Array(buf))
    expect(text).toContain('财务部')
    expect(text).toContain('1234')
  })

  it('不支持的扩展名（.pptx）→ 抛错，不返回占位符', async () => {
    await expect(extractDocumentText('deck.pptx', new Uint8Array([1, 2, 3]))).rejects.toThrow(/不支持/)
  })

  it('空内容 → 抛错', async () => {
    await expect(extractDocumentText('a.docx', new Uint8Array(0))).rejects.toThrow()
  })

  it('isExtractableFile 判定可用类型', () => {
    expect(isExtractableFile('a.pdf')).toBe(true)
    expect(isExtractableFile('a.DOCX')).toBe(true)
    expect(isExtractableFile('a.pptx')).toBe(false)
  })
})
