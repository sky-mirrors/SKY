import { describe, it, expect, beforeEach } from 'vitest'
import { getFileContext, setActiveFile, getFileBoostForItem, initFileContextWatch, destroyFileContextWatch } from '@/services/fileContext'

describe('fileContext', () => {
  beforeEach(() => {
    setActiveFile(null)
    destroyFileContextWatch()
  })

  it('无文件上下文时boost为0', () => {
    setActiveFile(null)
    const boost = getFileBoostForItem(['合同', '审查'], '合同风险审查工具')
    expect(boost).toBe(0)
  })

  it('pdf文件激活合同相关boost', () => {
    setActiveFile('contract.pdf')
    const ctx = getFileContext()
    expect(ctx.activeFileExt).toBe('.pdf')
    expect(ctx.boostKeywords.length).toBeGreaterThan(0)

    const boost = getFileBoostForItem(['合同', '审查'], '合同风险审查工具')
    expect(boost).toBeGreaterThan(0)
  })

  it('xlsx文件激活数据相关boost', () => {
    setActiveFile('财务报表.xlsx')
    const ctx = getFileContext()
    expect(ctx.activeFileExt).toBe('.xlsx')

    const boost = getFileBoostForItem(['数据', '汇总'], '财务数据汇总工具')
    expect(boost).toBeGreaterThan(0)
  })

  it('不相关文件类型无boost', () => {
    setActiveFile('photo.xyz')
    const ctx = getFileContext()
    expect(ctx.activeFileExt).toBe('.xyz')
    expect(ctx.boostKeywords.length).toBe(0)

    const boost = getFileBoostForItem(['合同', '审查'], '合同风险审查工具')
    expect(boost).toBe(0)
  })

  it('匹配关键词数量影响boost强度', () => {
    setActiveFile('report.docx')
    const highBoost = getFileBoostForItem(['文档', '报告', '合同'], '文档报告合同生成')
    const lowBoost = getFileBoostForItem(['邮件'], '邮件发送')
    expect(highBoost).toBeGreaterThan(lowBoost)
  })

  it('setActiveFile(null)重置上下文', () => {
    setActiveFile('contract.pdf')
    expect(getFileContext().activeFileExt).toBe('.pdf')
    setActiveFile(null)
    expect(getFileContext().activeFileExt).toBeNull()
    expect(getFileContext().boostKeywords.length).toBe(0)
  })

  it('initFileContextWatch无electronAPI不报错', async () => {
    await expect(initFileContextWatch()).resolves.toBeUndefined()
  })
})
