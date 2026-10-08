/**
 * 「批量转 PDF」的**纯计划核心**（2026-10-08）—— CI-03 缺口的算子所需的判定层。
 *
 * 背景：「把桌面上所有的 md 文件转成 pdf，然后都放进一个新建的文件夹里」。file_convert 是**单文件**算子
 * （source/target 都必填），静态计划表达不了「对目录下每个文件都转一次」，故此前只能如实说"没有批量转换算子"。
 * 本模块补计划层；真正的转换在 electron/ipc-handlers.ts 的 doc:convertBatchToPdf 里逐个调用
 * convertDocumentToPdf（注入式 I/O + `%PDF-` 魔数校验：渲染无效则不写任何文件）。
 *
 * 与 fileSortByType / fileUnzip / fileRenameExt 同款约定：跨层共享的零依赖叶子逻辑放 electron/。
 * 扩展名筛选复用 fileMoveBatch 的规格解析（`ext` 支持逗号分隔的集合）；可转换源名单复用 docConvert 的
 * CONVERT_SOURCE_EXTS（**单一来源**，不在此另抄一份，避免口径漂移）。
 *
 * 分工：计划层不碰磁盘；「目标已存在则跳过」「建目标目录」都在主进程做（与 file:move 批量形态一致）。
 */

import { join } from 'path'
import { parseExtSpec, matchesExtSpec } from './fileMoveBatch'
import { isConvertibleSource } from './docConvert'

export interface ConvertTask {
  /** 源文件名（不含目录） */
  source: string
  /** 目标 PDF 绝对路径 */
  target: string
}

/**
 * 批量转 PDF 计划。
 * @param names 目录下的文件名（不含目录）
 * @param extSpec 扩展名规格（''=不限；支持 'md' / 'md,txt'，见 fileMoveBatch.parseExtSpec）
 * @param targetDir 目标目录绝对路径
 */
export function planConvertBatch(names: string[], extSpec: string, targetDir: string): ConvertTask[] {
  const exts = parseExtSpec(extSpec)
  const out: ConvertTask[] = []
  for (const raw of names || []) {
    const name = String(raw || '')
    if (!name) continue
    if (!matchesExtSpec(name, exts)) continue
    if (!isConvertibleSource(name)) continue      // 非可转换源不入计划（主进程另行如实上报）
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const target = join(String(targetDir), `${stem}.pdf`)
    if (target.toLowerCase() === join(String(targetDir), name).toLowerCase()) continue  // 源即 pdf ⇒ 自比，剔除
    out.push({ source: name, target })
  }
  return out
}
