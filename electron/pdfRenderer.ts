// HTML → PDF 渲染器（第一波·文档能力）。
//
// 单独成模块的原因：只有它依赖 Electron 运行时。转换管线的其余部分（读源 →
// docx/md/txt → HTML → 校验 → 落盘）因此在 vitest 里可直测；本文件由
// `npm run verify:pdf`（test/e2e/pdfRender.e2e.ts，真起 Electron 跑生产管线）覆盖。
//
// ⚠️ 关键实现约束（2026-09-24 实测，probe-printtopdf-2/3）：
//   「每次新建窗口 → 渲染 → destroy」这种形态在本环境**不可靠**——销毁最后一个窗口后
//   再创建新窗口，其 loadURL 必定失败（net::ERR_FAILED (-2)，A1 PASS / A2 FAIL 稳定复现）；
//   而**复用同一个隐藏窗口连续渲染**实测 4/4 通过。
//   因此这里用懒建的单例窗口，除非窗口已被外部销毁（isDestroyed）否则绝不主动 destroy。

import { BrowserWindow } from 'electron'

let renderWindow: BrowserWindow | null = null

function getRenderWindow(): BrowserWindow {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow
  renderWindow = new BrowserWindow({
    show: false,
    width: 794,   // A4 宽度 @96dpi
    height: 1123,
    // 待渲染的 HTML 由本仓生成、不含脚本；关掉 JS 并开沙箱，把这一层的面收到最小
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true }
  })
  return renderWindow
}

/**
 * 渲染 HTML 为 PDF（Electron `webContents.printToPDF`）。
 * 用 data: URL 注入，不落任何中间文件。失败抛错——调用方据此如实报告，不产出半成品。
 */
export async function renderHtmlToPdf(html: string, timeoutMs = 30000): Promise<Buffer> {
  const win = getRenderWindow()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return await Promise.race([
      win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`PDF 渲染超时(${timeoutMs}ms)`)), timeoutMs)
      })
    ])
  } catch (e) {
    // 失败后把窗口复位到空白页，下一个请求仍可复用同一个窗口（不销毁——见文件头约束）
    try { await win.loadURL('about:blank') } catch { /* 复位失败不掩盖原始错误 */ }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 应用退出前调用；平时不销毁（复用是正确形态，见文件头） */
export function disposePdfRenderer(): void {
  if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy()
  renderWindow = null
}
