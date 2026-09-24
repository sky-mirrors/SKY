// 第一波·文档能力：文档 → PDF 转换管线（主进程，纯逻辑）。
//
// 为什么放在应用内、而不是下载外部工具：
//   - docx 解析：mammoth 已是本仓依赖（依赖里同时有 docx/xlsx/pdf-parse/marked）；
//   - HTML → PDF：Electron 自带 Chromium（`webContents.printToPDF`，本机实测 83ms 出 1 页、
//     中文经 pypdf 独立提取正常）；
//   - 而 LibreOffice / pandoc / Word 本机均不存在（l0SkillRouter 决策 A3 的实测结论），
//     下载它们既撞 GitHub 封锁，也要 300MB+ 体积与额外运行时。
//
// 本模块只决定「读什么 → 生成什么 HTML → 写到哪」，三个 I/O 与 PDF 渲染全部注入，
// 因此除渲染器外全链可在 vitest 里直测（渲染器见 ./pdfRenderer）。

import { marked } from 'marked'
import mammoth from 'mammoth'

/** 可作为转换源的扩展名（无扩展名或其它类型一律拒绝，不猜） */
export const CONVERT_SOURCE_EXTS = ['docx', 'md', 'markdown', 'html', 'htm', 'txt'] as const

export function extOf(filePathOrName: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePathOrName || '').trim())
  return m ? m[1].toLowerCase() : ''
}

export function isConvertibleSource(filePathOrName: string): boolean {
  return (CONVERT_SOURCE_EXTS as readonly string[]).includes(extOf(filePathOrName))
}

export function baseName(filePath: string): string {
  const p = String(filePath || '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 纯文本 → 段落 HTML（空行分段，段内换行保留为 <br>） */
export function textToHtmlParagraphs(text: string): string {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/)
  return paras
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/**
 * 统一 HTML 外壳：声明 UTF-8 + 中文字体栈。
 * printToPDF 走 Chromium 排版 + 系统字体，中文不会像 pandoc+LaTeX 那样缺字库。
 */
export function wrapHtmlDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif;font-size:12pt;line-height:1.7;color:#111;margin:0}
  h1{font-size:18pt;margin:0 0 12pt}h2{font-size:15pt;margin:14pt 0 8pt}h3{font-size:13pt}
  p{margin:0 0 8pt}ul,ol{margin:0 0 8pt 18pt}
  table{border-collapse:collapse;width:100%;margin:0 0 8pt}td,th{border:1px solid #999;padding:4pt 6pt;text-align:left}
  pre{white-space:pre-wrap;font-family:Consolas,monospace;background:#f6f6f6;padding:8pt;border-radius:3pt}
  code{font-family:Consolas,monospace}img{max-width:100%}
</style></head><body>${bodyHtml}</body></html>`
}

/** 源文件字节 → HTML 正文。docx 走 mammoth，md 走 marked，html 原样，txt 段落化。 */
export async function sourceToBodyHtml(filePath: string, buf: Buffer): Promise<string> {
  const ext = extOf(filePath)
  if (ext === 'docx') {
    const result = await mammoth.convertToHtml({ buffer: buf })
    return result.value || ''
  }
  const text = buf.toString('utf8')
  if (ext === 'md' || ext === 'markdown') return await marked.parse(text)
  if (ext === 'html' || ext === 'htm') return text
  return textToHtmlParagraphs(text)
}

/** 注入的三条 I/O 与 PDF 渲染——生产实现见 ipc-handlers；测试注入桩 */
export interface PdfConvertDeps {
  readSource(absPath: string): Promise<Buffer>
  renderPdf(input: { html: string; title: string }): Promise<Buffer>
  writeTarget(absPath: string, buf: Buffer): Promise<void>
}

export interface ConvertResult {
  bytes: number
  title: string
}

/**
 * 文档 → PDF。失败一律抛错（由调用方如实上报），不产出半成品文件：
 * 渲染结果必须先过 `%PDF-` 魔数校验才落盘——「不得假装成功」在本项目的硬要求。
 */
export async function convertDocumentToPdf(
  source: string,
  target: string,
  deps: PdfConvertDeps
): Promise<ConvertResult> {
  if (!isConvertibleSource(source)) {
    const ext = extOf(source)
    throw new Error(`不支持的源格式: ${ext || '(无扩展名)'}（支持 ${CONVERT_SOURCE_EXTS.join(' / ')}）`)
  }
  if (extOf(target) !== 'pdf') {
    throw new Error(`目标文件必须是 .pdf: ${target}`)
  }
  const buf = await deps.readSource(source)
  if (!buf || buf.length === 0) {
    throw new Error(`源文件为空或读取失败: ${source}`)
  }
  const bodyHtml = await sourceToBodyHtml(source, buf)
  if (!bodyHtml.trim()) {
    throw new Error(`源文件解析后没有可渲染内容: ${source}`)
  }
  const title = baseName(source).replace(/\.[^.]+$/, '') || 'document'
  const pdf = await deps.renderPdf({ html: wrapHtmlDocument(bodyHtml, title), title })
  if (!pdf || pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('PDF 渲染结果无效（未得到 %PDF- 文件头），未写入任何文件')
  }
  await deps.writeTarget(target, pdf)
  return { bytes: pdf.length, title }
}
