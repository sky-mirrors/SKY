/**
 * 第一波·文档能力：脱离 vitest 的真端到端验收。
 *
 * 为什么单独放在 test/e2e（vitest 配置已排除该目录）：这条链路必须真起 Electron 运行时
 * 才能验证 `webContents.printToPDF`——vitest 的 node 环境里没有 Chromium。
 * 本脚本跑的是**生产代码**（electron/docConvert.ts + electron/pdfRenderer.ts），
 * 不是复刻一份等价实现。
 *
 * 运行：npm run verify:pdf
 */
import { app } from 'electron'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import { convertDocumentToPdf } from '../../electron/docConvert'
import { renderHtmlToPdf } from '../../electron/pdfRenderer'

const workDir = join(app.getPath('temp'), 'holo-pdf-e2e')

async function makeDocx(target: string): Promise<void> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: '项目周报（端到端验收）', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('本周完成：文档导出 PDF 能力落地。')] }),
        new Paragraph({ children: [new TextRun('下周计划：补齐 L2 清单与图像能力。')] })
      ]
    }]
  })
  writeFileSync(target, await Packer.toBuffer(doc))
}

function checkPdf(file: string): { ok: boolean; bytes: number; magic: string } {
  const buf = readFileSync(file)
  const magic = buf.subarray(0, 5).toString('latin1')
  return { ok: magic === '%PDF-' && buf.length > 1000, bytes: buf.length, magic }
}

async function main(): Promise<void> {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const deps = {
    readSource: async (p: string) => readFileSync(p),
    renderPdf: async ({ html }: { html: string }) => renderHtmlToPdf(html),
    writeTarget: async (p: string, buf: Buffer) => { writeFileSync(p, buf) }
  }

  const docxSrc = join(workDir, '周报.docx')
  const mdSrc = join(workDir, 'memo.md')
  await makeDocx(docxSrc)
  writeFileSync(mdSrc, '# 备忘录\n\n这是一段中文正文，用于验证 md → PDF。\n\n- 条目一\n- 条目二\n', 'utf8')

  const results: string[] = []
  let failed = 0

  for (const [label, src] of [['docx→pdf', docxSrc], ['md→pdf', mdSrc]] as const) {
    const out = src.replace(/\.\w+$/, '.pdf')
    try {
      const r = await convertDocumentToPdf(src, out, deps)
      const chk = checkPdf(out)
      results.push(`${label}: ${chk.ok ? 'PASS' : 'FAIL'} bytes=${chk.bytes} magic=${JSON.stringify(chk.magic)} title=${r.title}`)
      if (!chk.ok) failed++
    } catch (e) {
      results.push(`${label}: FAIL 抛错 ${(e as Error).message}`)
      failed++
    }
  }

  // 负例：不支持的源格式必须抛错、且不得产出文件（"不得假装成功"）
  const badOut = join(workDir, 'bad.pdf')
  try {
    await convertDocumentToPdf(join(workDir, 'nope.xlsx'), badOut, deps)
    results.push('负例（不支持格式）: FAIL 未抛错')
    failed++
  } catch {
    results.push(`负例（不支持格式）: ${existsSync(badOut) ? 'FAIL 竟产出文件' : 'PASS 抛错且无产物'}`)
    if (existsSync(badOut)) failed++
  }

  for (const line of results) console.log(line)
  console.log(`输出目录: ${workDir}`)
  console.log(failed === 0 ? 'E2E_RESULT=PASS' : `E2E_RESULT=FAIL(${failed})`)
}

app.disableHardwareAcceleration()
app.whenReady()
  .then(main)
  .catch((e) => { console.log('E2E_RESULT=FAIL 未捕获异常: ' + (e as Error).message) })
  .finally(() => { app.exit() })
