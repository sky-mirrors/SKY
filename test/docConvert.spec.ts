import { describe, it, expect, vi } from 'vitest'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import {
  extOf,
  baseName,
  isConvertibleSource,
  escapeHtml,
  textToHtmlParagraphs,
  wrapHtmlDocument,
  sourceToBodyHtml,
  convertDocumentToPdf,
  type PdfConvertDeps
} from '@electron/docConvert'

// 真端到端（真起 Electron 跑 printToPDF）在 test/e2e/pdfRender.e2e.ts，用 `npm run verify:pdf` 跑。
// 这里覆盖除"Chromium 渲染"以外的全链：源文件 → HTML（真 mammoth / 真 marked）→ 校验 → 落盘。

describe('docConvert - 扩展名与外壳', () => {
  it('extOf / isConvertibleSource 只认支持的源格式', () => {
    expect(extOf('C:\\a\\b\\报告.DOCX')).toBe('docx')
    expect(extOf('无扩展名')).toBe('')
    for (const ok of ['a.docx', 'a.MD', 'a.markdown', 'a.html', 'a.htm', 'a.txt']) {
      expect(isConvertibleSource(ok), ok).toBe(true)
    }
    for (const no of ['a.xlsx', 'a.pptx', 'a.pdf', 'a', 'a.exe']) {
      expect(isConvertibleSource(no), no).toBe(false)
    }
  })

  it('baseName 取路径末段（Windows 与 POSIX 分隔符都认）', () => {
    expect(baseName('C:\\Users\\me\\周报.docx')).toBe('周报.docx')
    expect(baseName('/home/me/memo.md')).toBe('memo.md')
    expect(baseName('plain.txt')).toBe('plain.txt')
  })

  it('escapeHtml 堵住 HTML 注入（txt 内容不得变成标签）', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escapeHtml('a & "b"')).toBe('a &amp; &quot;b&quot;')
  })

  it('textToHtmlParagraphs：空行分段、段内换行转 <br>、内容转义', () => {
    const html = textToHtmlParagraphs('第一段\n换行\n\n第二段 <b>不是标签</b>')
    expect(html).toBe('<p>第一段<br>换行</p>\n<p>第二段 &lt;b&gt;不是标签&lt;/b&gt;</p>')
  })

  it('wrapHtmlDocument 声明 UTF-8 并转义标题', () => {
    const html = wrapHtmlDocument('<p>x</p>', '标 <题>')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('标 &lt;题&gt;')
    expect(html).toContain('<p>x</p>')
  })
})

describe('docConvert - 源文件 → HTML（真 mammoth / 真 marked）', () => {
  it('docx 经 mammoth 抽出正文（不是把二进制当文本）', async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun('合同风险审查：第一条 付款条件')] })] }]
    })
    const buf = await Packer.toBuffer(doc)
    const html = await sourceToBodyHtml('x.docx', buf)
    expect(html).toContain('合同风险审查')
    expect(html).toContain('付款条件')
  })

  it('markdown 经 marked 转成标签', async () => {
    const html = await sourceToBodyHtml('x.md', Buffer.from('# 标题\n\n- 条目一\n- 条目二\n', 'utf8'))
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<li>条目一</li>')
  })

  it('html 原样透传，txt 段落化', async () => {
    const raw = '<h2>自带标签</h2>'
    expect(await sourceToBodyHtml('x.html', Buffer.from(raw, 'utf8'))).toBe(raw)
    expect(await sourceToBodyHtml('x.txt', Buffer.from('纯文本\n\n第二段', 'utf8')))
      .toBe('<p>纯文本</p>\n<p>第二段</p>')
  })
})

describe('docConvert - 转换全链（注入 I/O 与渲染）', () => {
  function makeDeps(over: Partial<PdfConvertDeps> = {}): PdfConvertDeps & {
    written: Array<{ path: string; bytes: number }>
    rendered: string[]
  } {
    const written: Array<{ path: string; bytes: number }> = []
    const rendered: string[] = []
    const deps: PdfConvertDeps = {
      readSource: async () => Buffer.from('# 标题\n\n正文内容\n', 'utf8'),
      renderPdf: async ({ html }) => {
        rendered.push(html)
        return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(2048, 0x20)])
      },
      writeTarget: async (p, buf) => { written.push({ path: p, bytes: buf.length }) },
      ...over
    }
    return Object.assign(deps, { written, rendered })
  }

  it('happy path：渲染 HTML 后把 PDF 写到目标路径，标题取自源文件名', async () => {
    const deps = makeDeps()
    const r = await convertDocumentToPdf('C:\\Users\\me\\周报.md', 'C:\\Users\\me\\周报.pdf', deps)
    expect(r.title).toBe('周报')
    expect(r.bytes).toBeGreaterThan(2000)
    expect(deps.written).toEqual([{ path: 'C:\\Users\\me\\周报.pdf', bytes: r.bytes }])
    // 渲染器收到的是完整文档（含 UTF-8 声明与源正文）
    expect(deps.rendered[0]).toContain('<meta charset="utf-8">')
    expect(deps.rendered[0]).toContain('<h1>标题</h1>')
  })

  it('不支持的源格式：抛错且不产出任何文件', async () => {
    const deps = makeDeps()
    await expect(convertDocumentToPdf('a.xlsx', 'a.pdf', deps)).rejects.toThrow('不支持的源格式')
    expect(deps.written).toHaveLength(0)
  })

  it('目标不是 .pdf：抛错且不产出任何文件', async () => {
    const deps = makeDeps()
    await expect(convertDocumentToPdf('a.md', 'a.doc', deps)).rejects.toThrow('必须是 .pdf')
    expect(deps.written).toHaveLength(0)
  })

  it('源文件为空：抛错且不进入渲染', async () => {
    const deps = makeDeps({ readSource: async () => Buffer.alloc(0) })
    await expect(convertDocumentToPdf('a.md', 'a.pdf', deps)).rejects.toThrow('源文件为空')
    expect(deps.rendered).toHaveLength(0)
    expect(deps.written).toHaveLength(0)
  })

  it('解析后无内容（空 md）：抛错且不产出文件', async () => {
    const deps = makeDeps({ readSource: async () => Buffer.from('   \n\n', 'utf8') })
    await expect(convertDocumentToPdf('a.md', 'a.pdf', deps)).rejects.toThrow('没有可渲染内容')
    expect(deps.written).toHaveLength(0)
  })

  // 「不得假装成功」：渲染器返回的不是 PDF 时，必须抛错而不是把垃圾写进 .pdf
  it('渲染结果非 PDF（无 %PDF- 魔数）：抛错且不落盘', async () => {
    const deps = makeDeps({ renderPdf: async () => Buffer.from('<html>不是 pdf</html>', 'utf8') })
    await expect(convertDocumentToPdf('a.md', 'a.pdf', deps)).rejects.toThrow('%PDF-')
    expect(deps.written).toHaveLength(0)
  })

  it('渲染器抛错时异常向上传播，不写文件', async () => {
    const deps = makeDeps({ renderPdf: vi.fn(async () => { throw new Error('Chromium 崩了') }) })
    await expect(convertDocumentToPdf('a.md', 'a.pdf', deps)).rejects.toThrow('Chromium 崩了')
    expect(deps.written).toHaveLength(0)
  })
})
