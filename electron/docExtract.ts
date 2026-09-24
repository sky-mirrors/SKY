import * as XLSX from 'xlsx'
import mammoth from 'mammoth'

// K-1：文档文本提取（主进程）。
// 背景：原实现在渲染层对 .pdf / .docx / .xlsx / .pptx 返回占位符字符串
// （「[PDF文件: …] PDF解析需要pdf.js支持」），并照常切块入库——用户看到「已入库 N 个分块」，
// 实际入库的是一行占位符，hybridSearch 永远命中不了文档内容。这是「功能不存在」而非 bug。
// 本模块用仓内已有依赖（pdf-parse / mammoth / xlsx）做真实提取，由 IPC doc:extractText 暴露。

export const SUPPORTED_EXTRACT_EXTS = ['pdf', 'docx', 'xlsx', 'xls'] as const

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '').trim())
  return m ? m[1].toLowerCase() : ''
}

/** .pptx 暂无可用解析依赖——由调用方如实报「不支持」，不返回占位符假数据 */
export function isExtractableFile(name: string): boolean {
  return (SUPPORTED_EXTRACT_EXTS as readonly string[]).includes(extOf(name))
}

async function extractPdf(data: Uint8Array): Promise<string> {
  // pdf-parse 是 ESM/CJS 双入口包，动态 import 在 CJS bundle 与 vitest 下都稳
  const mod = (await import('pdf-parse')) as unknown as {
    default?: (b: Buffer) => Promise<{ text?: string }>
  } & ((b: Buffer) => Promise<{ text?: string }>)
  const parse = mod.default ?? mod
  const res = await parse(Buffer.from(data))
  return res?.text || ''
}

async function extractDocx(data: Uint8Array): Promise<string> {
  const res = await mammoth.extractRawText({ buffer: Buffer.from(data) })
  return res?.value || ''
}

function extractSheet(data: Uint8Array): string {
  const wb = XLSX.read(Buffer.from(data), { type: 'buffer' })
  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) continue
    parts.push(`# ${sheetName}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`)
  }
  return parts.join('\n\n')
}

/**
 * 按扩展名把文档字节提取为纯文本。不支持的类型**抛错**（fail-closed），
 * 不返回任何占位符——调用方据此如实告知用户，而不是假装入库成功。
 */
export async function extractDocumentText(name: string, data: Uint8Array): Promise<string> {
  if (!data || data.length === 0) throw new Error(`文件内容为空: ${name}`)
  const ext = extOf(name)
  if (ext === 'pdf') return await extractPdf(data)
  if (ext === 'docx') return await extractDocx(data)
  if (ext === 'xlsx' || ext === 'xls') return extractSheet(data)
  throw new Error(`不支持提取文本的文件类型: .${ext || '(无扩展名)'}（支持 ${SUPPORTED_EXTRACT_EXTS.join(' / ')}）`)
}
