import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { planConvertBatch } from '@electron/fileConvertBatch'

// ─────────────────────────────────────────────────────────────────────────────
// 「批量转 PDF」的**纯计划核心**（2026-10-08）—— CI-03 缺口
//（「把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里」）。
//
// 缺口原由：file_convert 是**单文件**算子（source/target 都必填），静态计划表达不了「对目录下每个文件都转一次」。
// 本模块补批量形态的计划层；真正的转换在 electron/ipc-handlers.ts 的 doc:convertBatchToPdf 里逐个调用
// convertDocumentToPdf（注入式 I/O + `%PDF-` 魔数校验，失败不写半成品）。
//
// 三条约束（与前三个算子同款）：
//   · 只挑**可转换的源**（docx / md / markdown / html / htm / txt —— 单一来源是 docConvert.CONVERT_SOURCE_EXTS，
//     不在此另抄一份名单，避免口径漂移）；
//   · 目标名 = `<目标目录>\<主名>.pdf`；源本身就是 .pdf ⇒ 计划里剔除（否则等于把文件换个位置自比）；
//   · 计划层不碰磁盘：目标已存在的跳过逻辑在主进程做（与 file:move 批量形态同一分工）。
// ─────────────────────────────────────────────────────────────────────────────

describe('planConvertBatch：批量转 PDF 计划', () => {
  it('按扩展名规格筛选，目标名 = 主名 + .pdf', () => {
    const plan = planConvertBatch(['a.md', 'b.txt', 'c.docx', 'pic.png', 'd.pdf'], 'md,txt', 'D:\\out')
    expect(plan).toEqual([
      { source: 'a.md', target: 'D:\\out\\a.pdf' },
      { source: 'b.txt', target: 'D:\\out\\b.pdf' }
    ])
  })

  it('不带扩展名规格 ⇒ 目录下所有**可转换**源（不可转换的静默不入计划，由主进程如实上报）', () => {
    const plan = planConvertBatch(['a.md', 'pic.png', 'x.exe', 'noext', 'table.xlsx'], '', 'D:\\out')
    expect(plan.map(p => p.source)).toEqual(['a.md'])
  })

  it('多点文件名：只在最后一段扩展名上换（主名整体保留）', () => {
    expect(planConvertBatch(['2026.09.report.md'], 'md', 'D:\\out')).toEqual([
      { source: '2026.09.report.md', target: 'D:\\out\\2026.09.report.pdf' }
    ])
  })

  it('源本身是 .pdf ⇒ 不入计划（自比转换）', () => {
    expect(planConvertBatch(['already.pdf'], '', 'D:\\out')).toEqual([])
  })

  it('空输入 ⇒ 空计划（不建目录、不产出任何任务）', () => {
    expect(planConvertBatch([], 'md', 'D:\\out')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 接线契约：一个新形态要跨 4 处登记才可达（IPC + preload + 两条 dispatch）。
// dispatch 是闭包不可 import ⇒ 沿用本项目约定（见 fileMoveDispatch.spec.ts）做源码文本断言。
// ─────────────────────────────────────────────────────────────────────────────
describe('file_convert 批量形态：登记与分发一致', () => {
  it('主进程注册了 doc:convertBatchToPdf，且逐个转换、失败逐个记录（不因一个坏源中断整批）', () => {
    const ipc = readFileSync(join(process.cwd(), 'electron/ipc-handlers.ts'), 'utf-8')
    expect(ipc).toContain("ipcMain.handle('doc:convertBatchToPdf'")
    expect(ipc).toMatch(/目标已存在，跳过/)
    expect(ipc).toMatch(/不支持转换/)
  })

  it('preload 暴露 docConvertBatchToPdf', () => {
    const pre = readFileSync(join(process.cwd(), 'electron/preload.ts'), 'utf-8')
    expect(pre).toContain("ipcRenderer.invoke('doc:convertBatchToPdf'")
  })

  it('两条 dispatch 都支持批量形态（macros + mcp-direct），且都在单文件形态**之前**判定', () => {
    const macro = readFileSync(join(process.cwd(), 'src/services/macroExecutor.ts'), 'utf-8')
    expect(macro).toContain('docConvertBatchToPdf')
    expect(macro).toMatch(/file_convert: missing fromDir/)
    const dlg = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
    expect(dlg).toContain('docConvertBatchToPdf')
    expect(dlg).toMatch(/file_convert.*批量|批量.*file_convert/)
  })
})
