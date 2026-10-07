// 精确编辑（file:edit 的数据路径，抽成模块是为了可测）——2026-10-07 可用性补强 Wave 1
//
// 为什么单独成模块：`file:edit` 的 handler 注册在 setupIpc 闭包里、依赖 electron 的 ipcMain，
// 单测拿不到它；而"唯一性判定与不落盘保证"正是本能力的安全契约，必须对真实磁盘断言
// （同 fileListing.ts / fileSearch.ts 的约定）。handler 只保留路径校验与错误包装。
//
// 不变量：① oldString 出现 0 次或（>1 次且未传 replaceAll）→ **失败且不落盘**；
// ② 编辑不是"重写整个文件"的别名——只在命中处替换，其余字节保持原样（UTF-8 往返）。
import { readFileSync, writeFileSync } from 'fs'

export interface EditOutcome {
  ok: boolean
  /** 实际替换的处数（失败时为 0） */
  replaced: number
  error?: string
  /** 仅在 ok=true 时给出（纯逻辑调用的返回值；落盘版不外传内容） */
  content?: string
}

/** 单文件编辑上限（超过则不读不写，fail-closed） */
export const EDIT_MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * 纯替换逻辑（不碰磁盘）。
 * 唯一子串匹配：0 次 → 失败"未找到"；>1 次且未传 replaceAll → 失败"不唯一"（要求模型补上下文）。
 */
export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  if (!oldString) return { ok: false, replaced: 0, error: 'oldString 不能为空' }
  const count = content.split(oldString).length - 1
  if (count === 0) return { ok: false, replaced: 0, error: '未找到 oldString（内容不匹配）' }
  if (count > 1 && !replaceAll) {
    return { ok: false, replaced: 0, error: `oldString 不唯一（出现 ${count} 次），请补充上下文使其唯一，或显式传 replaceAll` }
  }
  if (replaceAll) {
    return { ok: true, replaced: count, content: content.split(oldString).join(newString) }
  }
  // replace 只在首个命中处替换；已确认唯一，故等价于"那一处"
  return { ok: true, replaced: 1, content: content.replace(oldString, newString) }
}

/**
 * 读 → 替换 → 写回。任何失败（读不到、过大、不唯一、未找到、写回失败）都**不落盘**，
 * 返回 ok=false 与人话原因——调用方据此如实回复，不假装完成。
 */
export function editFileOnDisk(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false
): EditOutcome {
  let content: string
  try {
    const buf = readFileSync(filePath)
    if (buf.byteLength > EDIT_MAX_FILE_BYTES) {
      return { ok: false, replaced: 0, error: `文件过大（上限 ${EDIT_MAX_FILE_BYTES} 字节），拒绝编辑` }
    }
    content = buf.toString('utf-8')
  } catch (e) {
    return { ok: false, replaced: 0, error: `读取失败: ${e instanceof Error ? e.message : String(e)}` }
  }

  const r = applyEdit(content, oldString, newString, replaceAll)
  if (!r.ok) return r

  try {
    writeFileSync(filePath, r.content ?? '', 'utf-8')
  } catch (e) {
    return { ok: false, replaced: 0, error: `写回失败: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, replaced: r.replaced }
}
