/**
 * 规格书第 2 节（M18）内核纯度检查。
 * 扫描 src/kernel/**、src/kernels/**、src/host/** 与 scripts/pure-services.list
 * 登记的框架级纯服务中的域字符串字面量（'legal'/'finance'/'hr'，含双引号形态）；
 * 命中且未在 scripts/purity-whitelist.json 登记（{file, line, literal, reason, approvedBy}）则退出码 1。
 * 注释（// 与块注释）与测试文件（*.spec.ts / *.test.ts）不违规；脚本自身崩溃按失败处理。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const DOMAIN_LITERALS: ReadonlySet<string> = new Set(['legal', 'finance', 'hr'])
const SCAN_DIRS: readonly string[] = ['src/kernel', 'src/kernels', 'src/host']
const PURE_SERVICES_DIR = 'src/services'
const PURE_SERVICES_LIST = 'scripts/pure-services.list'
const WHITELIST_FILE = 'scripts/purity-whitelist.json'

interface WhitelistEntry {
  file: string
  line: number
  literal: string
  reason: string
  approvedBy: string
}

interface Violation {
  file: string
  line: number
  literal: string
}

interface StringHit {
  line: number
  text: string
}

function extractStringLiterals(source: string): StringHit[] {
  const hits: StringHit[] = []
  let line = 1
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const startLine = line
      i++
      let text = ''
      let closed = false
      while (i < n) {
        const c = source[i]
        if (c === '\\' && i + 1 < n) {
          text += c + source[i + 1]
          i += 2
          continue
        }
        if (c === '\n') {
          line++
          break
        }
        if (c === quote) {
          i++
          closed = true
          break
        }
        text += c
        i++
      }
      if (closed) hits.push({ line: startLine, text })
      continue
    }
    i++
  }
  return hits
}

function collectTsFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      collectTsFiles(full, out)
    } else if (name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(full)
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function loadWhitelist(): WhitelistEntry[] {
  if (!existsSync(WHITELIST_FILE)) return []
  const parsed = JSON.parse(readFileSync(WHITELIST_FILE, 'utf-8')) as WhitelistEntry[]
  if (!Array.isArray(parsed)) {
    throw new Error(`${WHITELIST_FILE}: expected a JSON array`)
  }
  for (const e of parsed) {
    if (typeof e.file !== 'string' || typeof e.line !== 'number' ||
        typeof e.literal !== 'string' || typeof e.reason !== 'string' || typeof e.approvedBy !== 'string') {
      throw new Error(`${WHITELIST_FILE}: entry missing required fields {file, line, literal, reason, approvedBy}`)
    }
  }
  return parsed
}

function main(): number {
  const files: string[] = []
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) throw new Error(`scan directory not found: ${dir}`)
    collectTsFiles(dir, files)
  }
  const listRaw = readFileSync(PURE_SERVICES_LIST, 'utf-8')
  for (const entry of listRaw.split(/\r?\n/)) {
    const name = entry.trim()
    if (name === '' || name.startsWith('#')) continue
    const full = join(PURE_SERVICES_DIR, name)
    if (!existsSync(full)) throw new Error(`${PURE_SERVICES_LIST}: service file not found: ${full}`)
    files.push(full)
  }

  const whitelist = loadWhitelist()
  const whitelistKeys = new Set(whitelist.map(e => `${e.file}:${e.line}`))

  const violations: Violation[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    for (const hit of extractStringLiterals(source)) {
      if (DOMAIN_LITERALS.has(hit.text)) {
        violations.push({ file: toPosix(relative('.', file)), line: hit.line, literal: hit.text })
      }
    }
  }

  const approved = violations.filter(v => whitelistKeys.has(`${v.file}:${v.line}`))
  const unapproved = violations.filter(v => !whitelistKeys.has(`${v.file}:${v.line}`))
  const hitKeys = new Set(violations.map(v => `${v.file}:${v.line}`))
  const stale = whitelist.filter(e => !hitKeys.has(`${e.file}:${e.line}`))

  for (const v of approved) {
    console.log(`  whitelist ${v.file}:${v.line} '${v.literal}'`)
  }
  for (const v of unapproved) {
    console.error(`  VIOLATION ${v.file}:${v.line} '${v.literal}'`)
  }
  for (const e of stale) {
    console.warn(`  WARN stale whitelist entry ${e.file}:${e.line} (no literal hit; remove it)`)
  }

  console.log(`purity-check: scanned ${files.length} files, ${violations.length} literal hits, ` +
    `${approved.length} whitelisted, ${unapproved.length} unapproved`)
  return unapproved.length > 0 ? 1 : 0
}

try {
  process.exit(main())
} catch (e) {
  console.error(`purity-check crashed: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
}
