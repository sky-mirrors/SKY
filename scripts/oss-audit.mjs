#!/usr/bin/env node
/**
 * 开源前审计（OSS pre-publish audit）—— 2026-10-09
 *
 * 为什么需要它：把仓库切成 public 是**不可逆**的（即便删库，镜像/缓存/克隆已流出）。
 * 而本仓已经真实踩过一次同类问题：考试成绩单正文里带着作者本机的绝对路径与用户名
 * （历史验收成绩单的 `replyExcerpt`，形如 `C:\Users\<作者名>\Desktop\...`），
 * 单测与 typecheck 全绿也照样看不到——没有任何测试会去读报告正文。
 *
 * 用法：
 *   node scripts/oss-audit.mjs              # 审计（只读），有高危命中即退出码 1
 *   node scripts/oss-audit.mjs --fix        # 脱敏「本机用户名」路径
 *   node scripts/oss-audit.mjs --history    # 追加扫描 git 全历史里的可疑文件名
 *
 * 检查项：
 *   A  密钥前缀 / 私钥块 / 已知 token 形态          高危
 *   B  赋值式密钥（api_key = '...' 之类）            高危
 *   C1 含**本机用户名**的绝对路径                    隐私，`--fix` 处理
 *   C2 其它 `C:\Users\<name>` / `/home/<name>` 路径   占位符居多，人工判断
 *   D  凭据 / 数据库类扩展名被跟踪                   高危
 *   E  .gitignore 未覆盖的运行时目录                 如 `.rivet/`
 *   F  产物文件被跟踪                                卫生
 *   G  git 历史中的可疑文件名（--history）           即使已删除也要知道
 *
 * `--fix` 的关键设计（2026-10-09 教训）：
 *   首版用 `[A-Za-z0-9._-]+` 通配「用户名」，把 `C:\Users\Default`（Electron 真实兜底目录）、
 *   `/home/user`、示例里的 `C:\Users\x` 一并换成 `<user>`——误改 58 个文件，还改坏了
 *   `defaultHome()` 的兜底值。现在**只脱敏当前机器的用户名**（`USERNAME` / `os.userInfo()`），
 *   且修复时**从 `git show HEAD:<file>` 基线重建**，不叠加此前被误改的内容。
 *
 * 退出码：0 = 无命中；1 = 有命中；2 = 无法读取 git 文件清单
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = process.argv.includes('--fix')
const HISTORY = process.argv.includes('--history')

let files
try {
  files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
} catch (e) {
  console.error('✗ 无法读取 git 文件清单（不在 git 仓库内？）:', e.message)
  process.exit(2)
}

const MACHINE_USER = process.env.USERNAME || process.env.USER || os.userInfo().username || ''
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 只针对「当前机器的用户名」做脱敏——占位符（Default / user / Test / x）一律不碰 */
const PATH_REDACTIONS = MACHINE_USER
  ? [
      [new RegExp(`([A-Za-z]:[\\\\/]+Users[\\\\/]+)${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])`, 'g'), '$1<user>'],
      [new RegExp(`(\\/Users\\/)${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])`, 'g'), '$1<user>'],
      [new RegExp(`(\\/home\\/)${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])`, 'g'), '$1<user>']
    ]
  : []

const ANY_USER_PATH = /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9_-]*\/|\/Users\/[A-Za-z][A-Za-z0-9._-]*\//
const MACHINE_PATH = MACHINE_USER
  ? new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])|\\/home\\/${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])|\\/Users\\/${escapeRe(MACHINE_USER)}(?![A-Za-z0-9._-])`)
  : /$^/

const RULES = [
  { id: 'A', label: '密钥前缀 / 私钥块 / 已知 token 形态', re: /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{12}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{30}|xox[baprs]-/ },
  { id: 'B', label: '赋值式密钥', re: /(api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_/+-]{12,}/i, ignore: /example|placeholder|your[_-]|\*\*\*|xxx|<.*>|secret-key-123|dummy|fake|test-key/i },
  { id: 'C1', label: `本机用户名路径（USERNAME=${MACHINE_USER || '?'}）`, fixable: true, re: MACHINE_PATH },
  { id: 'C2', label: '其它用户目录路径（占位符居多，人工判断）', re: ANY_USER_PATH }
]

const CREDENTIAL_EXT = /\.(db|sqlite3?|pem|key|p12|pfx|jks|keystore)$/i
const PRODUCT_ARTIFACT = /^(exam-report|benchmark-result|quality-report|test-edge-results|test-multi-model-results)\.json$/

const hits = new Map(RULES.map((r) => [r.id, []]))
const problems = { D: [], E: [], F: [] }
const abs = (f) => join(ROOT, f)
const isBinary = (f) => {
  try { return readFileSync(abs(f)).includes(0) } catch { return true }
}

for (const f of files) {
  // 审计脚本自身必然逐字包含全部密钥模式（规则就是那些字面量），扫它只会自我命中——跳过
  if (f === 'scripts/oss-audit.mjs') continue
  if (!/[\\/]/.test(f) && PRODUCT_ARTIFACT.test(f)) problems.F.push(f)
  if (f.startsWith('.rivet/') || f.startsWith('coverage/') || f.startsWith('dist/') || f.startsWith('.idea/')) {
    problems.E.push(`${f}（运行时目录被跟踪）`)
  }
  if (CREDENTIAL_EXT.test(f)) problems.D.push(f)
  if (isBinary(f)) continue

  let text
  try { text = readFileSync(abs(f), 'utf8') } catch { continue }
  text.split(/\r?\n/).forEach((ln, i) => {
    for (const r of RULES) {
      if (!r.re.test(ln)) continue
      if (r.ignore && r.ignore.test(ln)) continue
      // C2 不重复计数 C1 已覆盖的行
      if (r.id === 'C2' && MACHINE_PATH.test(ln)) continue
      hits.get(r.id).push({ file: f, line: i + 1, excerpt: ln.trim().slice(0, 130) })
    }
  })
}

let gitignore = ''
try { gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8') } catch { /* 无 */ }
const gitignoreLines = gitignore.split(/\r?\n/).map((s) => s.trim())
for (const dir of ['.rivet/']) {
  if (!gitignoreLines.some((l) => l === dir || l === dir.replace(/\/$/, ''))) {
    problems.E.push(`.gitignore 未忽略 ${dir}（该目录装的是会话记录 / artifact / 临时探针）`)
  }
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
let blocking = 0
for (const r of RULES) {
  const list = hits.get(r.id)
  if (r.id !== 'C2') blocking += list.length
  console.log(`\n[${r.id}] ${r.label} —— ${list.length} 处`)
  if (list.length === 0) { console.log('    (无命中)'); continue }
  const byFile = new Map()
  for (const h of list) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h.line])
  for (const [file, lines] of byFile) {
    console.log(`    ${file} ×${lines.length}（行 ${lines.slice(0, 6).join(',')}${lines.length > 6 ? '…' : ''}）`)
  }
}

for (const [id, label] of [['D', '凭据 / 数据库类文件被跟踪'], ['E', '运行时目录 / 忽略规则'], ['F', '产物文件被跟踪']]) {
  const list = problems[id]
  blocking += list.length
  console.log(`\n[${id}] ${label} —— ${list.length} 处`)
  console.log(list.length ? list.map((x) => `    ${x}`).join('\n') : '    (无命中)')
}

if (HISTORY) {
  console.log('\n[G] git 全历史中出现过的可疑文件名')
  let out = ''
  try { out = execFileSync('git', ['log', '--all', '--diff-filter=A', '--name-only', '--pretty=format:'], { cwd: ROOT, encoding: 'utf8' }) } catch { /* ignore */ }
  const suspicious = [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
    .filter((f) => /\.env|\.pem$|\.key$|id_rsa|secret|credential|\.db$|\.sqlite/i.test(f))
  console.log(suspicious.length ? suspicious.map((f) => `    ${f}`).join('\n') : '    (无命中)')
  blocking += suspicious.length
}

// ── --fix：从 git HEAD 基线重建，只脱敏本机用户名 ─────────────────────────────
if (FIX) {
  // 目标 = 工作区里含 `<user>` 占位（即上一轮宽正则留下的痕迹）**或**仍含本机用户名的文件。
  // 必须从 `git show HEAD:<file>` 基线重建：工作区内容可能已被上一轮宽正则改坏（把
  // `C:\Users\Default`、`/home/user`、`C:\Users\x` 一并换成 `<user>`），在坏内容上继续替换
  // 只会累积误差，无法还原那些中性占位。
  const targets = files.filter((f) => {
    if (isBinary(f)) return false
    try {
      const t = readFileSync(abs(f), 'utf8')
      return t.includes('<user>') || MACHINE_PATH.test(t)
    } catch { return false }
  })
  console.log(`\n[--fix] 目标 ${targets.length} 个文件 —— 一律从 git HEAD 基线重建后再脱敏`)
  console.log('        （若这些文件另有你尚未提交的改动，请先自行备份）')
  let changed = 0
  for (const f of targets) {
    let base
    let fromHead = true
    try {
      base = execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch {
      fromHead = false
      base = readFileSync(abs(f), 'utf8') // 尚未提交的新文件
    }
    let after = base
    for (const [re, rep] of PATH_REDACTIONS) after = after.replace(re, rep)
    if (after !== readFileSync(abs(f), 'utf8')) {
      writeFileSync(abs(f), after)
      changed++
      console.log(`    ✓ ${f}${fromHead ? '' : '（新文件，未从 HEAD 取）'}`)
    }
  }
  console.log(`    已修正 ${changed} 个文件。重新运行不带 --fix 的本脚本确认 C1 为 0。`)
}

console.log(`\n===== 审计合计（不含 C2 提示项）：${blocking} 处命中 =====`)
if (MACHINE_USER) console.log(`（本机用户名 = ${MACHINE_USER}；C1 是 --fix 的处理目标，C2 仅提示）`)
process.exit(blocking === 0 ? 0 : 1)
