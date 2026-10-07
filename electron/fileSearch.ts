// 文件检索（file:search 的数据路径，抽成模块是为了可测）——2026-10-07（Wave 2）
//
// 为什么单独成模块：`file:search` 的 handler 注册在 setupIpc 闭包里、依赖 electron 的 ipcMain，
// 单测拿不到它；而「检索到底扫了哪些目录、跳过了什么、在哪里截断」是需要对真实目录断言的契约
// （同 fileListing.ts 的约定）。handler 只保留路径校验与错误包装。
//
// 不变量：**只读**——不创建/不修改/不删除任何文件；跳过 node_modules/.git 等重目录；
// 递归深度、单文件大小与结果条数都有上限（防超大目录拖住主进程）。
import { readdirSync, statSync, readFileSync } from 'fs'
import { join, extname } from 'path'

export interface SearchHit {
  path: string
  name: string
  /** 内容检索命中时的 1-based 行号 */
  line?: number
  /** 内容检索命中行片段（截断） */
  excerpt?: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** 实际检视过的文件数（不含跳过的目录） */
  scanned: number
  /** 因达到 maxResults 上限而提前停止 */
  truncated: boolean
}

/** 递归深度上限（root 为 0 层） */
export const SEARCH_MAX_DEPTH = 6
/** 结果条数缺省值 */
export const SEARCH_MAX_RESULTS_DEFAULT = 50
/** 结果条数硬上限（上层传更大值也钳到这里） */
export const SEARCH_MAX_RESULTS_CAP = 200
/** 内容检索只读不超过此大小的文本文件 */
export const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 不做内容检索的目录（重且通常无意义） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'out', 'dist', 'coverage', '.cache', '.idea'])

/** 可做内容检索的文本扩展名白名单（内容检索只对文本有意义） */
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.json5', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue',
  '.css', '.scss', '.less', '.html', '.htm', '.csv', '.tsv', '.log', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh'
])

/**
 * 在 root 下递归检索：`mode==='name'` 按文件名子串，`mode==='content'` 按文件内容子串（每文件只报首个命中行）。
 * query 为空时直接返回空结果（不遍历）。任何读盘失败都跳过该条目，不抛。
 */
export function searchFiles(
  root: string,
  query: string,
  mode: 'name' | 'content',
  maxResults: number = SEARCH_MAX_RESULTS_DEFAULT
): SearchResult {
  const q = String(query ?? '')
  const cap = Math.min(Math.max(1, Math.floor(Number(maxResults) || SEARCH_MAX_RESULTS_DEFAULT)), SEARCH_MAX_RESULTS_CAP)
  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false
  if (!q) return { hits, scanned, truncated }

  const qLower = q.toLowerCase()

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > SEARCH_MAX_DEPTH) return
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of dirents) {
      if (truncated) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      scanned++
      if (mode === 'name') {
        if (e.name.toLowerCase().includes(qLower)) {
          hits.push({ path: full, name: e.name })
          if (hits.length >= cap) { truncated = true; return }
        }
        continue
      }
      // 内容检索：只对文本扩展名，且单文件不超上限
      if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue
      try {
        if (statSync(full).size > SEARCH_MAX_FILE_BYTES) continue
        const lines = readFileSync(full, 'utf-8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(q)) {
            hits.push({ path: full, name: e.name, line: i + 1, excerpt: lines[i].trim().slice(0, 200) })
            if (hits.length >= cap) { truncated = true; return }
            break
          }
        }
      } catch {
        /* 读失败：跳过该文件，不影响整次检索 */
      }
    }
  }

  walk(root, 0)
  return { hits, scanned, truncated }
}
