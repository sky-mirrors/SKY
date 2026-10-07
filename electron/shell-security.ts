import { resolve, join, sep } from 'path'
import { validateReadPath, validateWritePath, getSafeExtension, DANGEROUS_EXTENSIONS } from './pathValidator'

const SHELL_ALLOWED_COMMANDS = [
  'npm install',
  'dir ',
  'ls',
  'cat ',
  'echo ',
  'type ',
  'mkdir ',
  'copy ',
  'cp ',
  'cd ',
  'pwd',
  'pip install'
]

// P0-1 修复：cmd.exe 元字符黑名单。% 与**内嵌**换行拒绝（%VAR% 展开后的 &
// 仍是命令分隔符；`ls\nrm` 会被拆成两条命令）；& | < > ^ 仅在双引号外拒绝
// （引号内为字面量）。V2-R15：首尾空白（含换行）不算元字符。
export function findShellMetacharacter(command: string): string | null {
  // V2-R15 修复：先剥掉首尾空白再扫描——只有**内嵌**换行才构成命令注入面；
  // 首尾换行（模型输出常带尾随 \n）不改变执行语义，此前在 trim 之前扫描
  // 原始串，把兜尾的 `ls\n` 误判为元字符而整体拒绝（V2-R15 回归）。
  let inQuote = false
  for (const ch of command.trim()) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (ch === '%') return '%'
    if (ch === '\n') return '\\n'
    if (ch === '\r') return '\\r'
    if (!inQuote && (ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '^')) return ch
  }
  if (inQuote) return '"'
  return null
}

const NODE_E_DANGEROUS_PATTERNS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /require\s*\(\s*['"]http['"]\s*\)/,
  /require\s*\(\s*['"]https['"]\s*\)/,
  /require\s*\(\s*['"]dgram['"]\s*\)/,
  /require\s*\(\s*['"]vm['"]\s*\)/,
  /require\s*\(\s*['"]worker_threads['"]\s*\)/,
  /require\s*\(\s*['"]dns['"]\s*\)/,
  /require\s*\(\s*['"]repl['"]\s*\)/,
  /require\s*\(\s*['"]module['"]\s*\)/,
  /process\.exit/,
  /process\.kill/,
  /process\.binding/,
  /process\.mainModule/,
  /import\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/i,
  /child_process/,
  /\.exec\s*\(/,
  /\.spawn\s*\(/,
  /\.execFile\s*\(/,
  /\.execSync\s*\(/,
  /\.spawnSync\s*\(/,
  /\.unlink\s*\(/,
  /\.unlinkSync\s*\(/,
  /\.rmdir\s*\(/,
  /\.rmdirSync\s*\(/,
  /\.rm\s*\(/,
  /\.rmSync\s*\(/,
  /\.rename\s*\(/,
  /\.renameSync\s*\(/,
  /\.chmod\s*\(/,
  /\.chmodSync\s*\(/,
  /\.chown\s*\(/,
  /\.chownSync\s*\(/,
  /\.truncate\s*\(/,
  /\.truncateSync\s*\(/,
  /\.writefile\s*\(/i,
  /\.writefilesync\s*\(/i,
  /\.createwritestream\s*\(/i,
  /\.readfilesync\s*\(/i,
  /\.readfile\s*\(/i,
  /\.createreadstream\s*\(/i,
  /rm\s+-rf/,
  /del\s+\/[sS]/,
  /format\s+[a-zA-Z]:/,
  /reg\s+/,
  /netsh\s+/,
  /powershell/,
  /cmd\.exe/,
  /wscript/,
  /cscript/,
  /certutil/,
  /bitsadmin/,
  /curl\s+/,
  /wget\s+/,
  /new\s+buffer\s*\(/i,
  /buffer\.from\s*\(/i,
  /atob\s*\(/,
  /string\.fromcharcode/i,
  /\\x[0-9a-f]{2}/,
  /\\u[0-9a-f]{4}/,
  /`[^`]*\$\{/i,
  /settimeout\s*\(/i,
  /setinterval\s*\(/i,
  // P0-2 收尾：句柄式写原语（open/openSync/write/writeSync/appendFile 等）此前
  // 不在黑名单，可完全绕过 writeFile 族的写入路径约束——writeFileSync 被拦时
  // 改用 fs.openSync(path,'w')+fs.writeSync(fd,data) 即可写任意路径
  /\.open\s*\(/i,
  /\.opensync\s*\(/i,
  /\.write\s*\(/i,
  /\.writesync\s*\(/i,
  /\.appendfile\s*\(/i,
  /\.appendfilesync\s*\(/i,
  /\.copyfile\s*\(/i,
  /\.copyfilesync\s*\(/i,
  /\.ftruncate\s*\(/i,
  /\.ftruncatesync\s*\(/i,
  // A-05：字符串字面量拼接（'child'+'_process'、c['ex'+'ec']）是黑名单最常用的
  // 规避手法——受限模板通道没有正当理由在代码里拼接字符串常量，一律拒绝
  /['"]\s*\+\s*['"]/,
  /\+\s*['"][A-Za-z_$]/,
]

const NODE_E_TRUSTED_SIGNATURES = [
  /require\s*\(\s*['"]docx['"]\s*\)/,
  /require\s*\(\s*['"]xlsx['"]\s*\)/,
  /require\s*\(\s*['"]pdf-parse['"]\s*\)/,
  /require\s*\(\s*['"]mammoth['"]\s*\)/,
  /require\s*\(\s*['"]archiver['"]\s*\)/,
  /require\s*\(\s*['"]marked['"]\s*\)/,
]

// E-3 修复：node -e 里写文件的调用，其目标路径必须被解析出来、规范化为绝对路径后
// 落在 Desktop/Documents/Downloads 内，且产物扩展名不得是可执行/脚本类型。
// 原实现 NODE_E_ALLOWED_WRITE_PATTERNS 只对源码文本做正则匹配——
//   writeFileSync('C:\\Users\\x\\Desktop\\..\\..\\..\\Windows\\evil.dll')  （.. 穿越）
//   writeFileSync('C:\\Users\\x\\Desktop\\x.js')                          （危险扩展名）
// 两者都能匹配通过，配合 mcp:spawn node 执行构成"写盘→执行"RCE 链。

// 还原 JS 字符串字面量里的反斜杠转义（够用：\\ \' \"）
function unescapeJsStringLiteral(lit: string): string {
  return lit.replace(/\\(['"\\])/g, '$1')
}

// 从写调用的首个实参源码文本解析出绝对目标路径；非受支持形态返回 null（fail-closed）
function resolveNodeWriteTarget(rawArg: string): string | null {
  const arg = rawArg.trim()
  // 形态一：纯字符串字面量
  const lit = /^(['"])([\s\S]*)\1$/.exec(arg)
  if (lit) return resolve(unescapeJsStringLiteral(lit[2]))
  // 形态二：process.env.USERPROFILE|HOME 与字面量拼接
  const concat = /^process\.env\.(?:USERPROFILE|HOME|userprofile|home)\s*\+\s*(['"])([\s\S]*)\1$/.exec(arg)
  if (concat) return resolve(defaultHome() + unescapeJsStringLiteral(concat[2]))
  return null
}

// 提取代码中每个 writeFile/writeFileSync/createWriteStream 调用的首个实参源码文本
function extractWriteArgs(code: string): string[] {
  const args: string[] = []
  const re = /\.(?:writeFile(?:Sync)?|createWriteStream)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].length
    let depth = 0
    let i = start
    let inStr: string | null = null
    for (; i < code.length; i++) {
      const ch = code[i]
      if (inStr) {
        if (ch === '\\') { i++; continue }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
      if (ch === '(') depth++
      else if (ch === ')') { if (depth === 0) break; depth-- }
      else if (ch === ',' && depth === 0) break
    }
    args.push(code.slice(start, i))
  }
  return args
}

// 写目标是否落在允许目录内且扩展名安全
function isAllowedNodeWriteTarget(rawArg: string): boolean {
  const target = resolveNodeWriteTarget(rawArg)
  if (!target) return false
  const home = defaultHome()
  const allowedDirs = ['Desktop', 'Documents', 'Downloads'].map(d => resolve(join(home, d)))
  const normalized = resolve(target)
  if (!allowedDirs.some(d => normalized === d || normalized.startsWith(d + sep))) return false
  const { ext } = getSafeExtension(normalized)
  if (ext && DANGEROUS_EXTENSIONS.includes(ext)) return false
  return true
}

// P0-2 收尾：require 实参必须是与白名单完全一致的字符串字面量。
// 原黑名单仅枚举危险模块的字面量写法，require(process.env.M) 这类动态
// require 不匹配任何危险模式即可放行，等于任意模块加载
const NODE_E_ALLOWED_REQUIRE_MODULES: Set<string> = new Set([
  'fs', 'path', 'os', 'node:fs', 'node:path', 'node:os',
  'docx', 'xlsx', 'pdf-parse', 'mammoth', 'archiver', 'marked',
])

function findIllegalRequire(codeContent: string): string | null {
  const re = /require\s*\(\s*([^()]*?)\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(codeContent)) !== null) {
    const arg = m[1].trim()
    const lit = /^(['"])([\s\S]*)\1$/.exec(arg)
    if (!lit || !NODE_E_ALLOWED_REQUIRE_MODULES.has(lit[2])) return m[0]
  }
  return null
}

function isNodeTrustedTemplate(codeContent: string): boolean {
  let trustedCount = 0
  for (const sig of NODE_E_TRUSTED_SIGNATURES) {
    if (sig.test(codeContent)) trustedCount++
  }
  if (trustedCount === 0) return false

  const dangerHits: RegExp[] = []
  for (const pattern of NODE_E_DANGEROUS_PATTERNS) {
    if (pattern.test(codeContent)) dangerHits.push(pattern)
  }
  if (dangerHits.length === 0) return true

  for (const hit of dangerHits) {
    const isWriteFile = hit.source.startsWith('\\.writefile') || hit.source.startsWith('\\.createwritestream')
    if (isWriteFile) {
      // E-3 修复：写目标必须能解析、规范化后落在 Desktop/Documents/Downloads 内、
      // 且产物扩展名不是可执行/脚本类型（原正则匹配可被 `..` 穿越与任意扩展名绕过）
      const writeArgs = extractWriteArgs(codeContent)
      if (writeArgs.length === 0) return false
      if (!writeArgs.every(isAllowedNodeWriteTarget)) return false
      continue
    }
    const isProcessEnv = hit.source.includes('process\\.env')
    const isBufferFrom = hit.source.includes('buffer\\.from')
    if (!isProcessEnv && !isBufferFrom) return false
  }

  return true
}

const MCP_ALLOWED_COMMANDS = [
  'npx',
  'node',
  'python3',
  'python',
  'uvx',
]

function defaultHome(): string {
  return process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
}

// P1-3 修复：MCP 解释器参数约束。内联代码/任意模块执行一律禁止；
// 脚本路径参数必须通过 validateReadPath
export function isMcpCommandAllowed(command: string, args?: string[]): { allowed: boolean; reason?: string } {
  const parts = command.trim().split(/\s+/)
  const firstWord = (parts[0] || '').toLowerCase()
  if (!MCP_ALLOWED_COMMANDS.includes(firstWord)) {
    return { allowed: false, reason: `MCP命令不在白名单中: ${firstWord}` }
  }
  const argList = [...parts.slice(1), ...(args || []).map(a => String(a))]
  if (argList.some(a => /[\n\r]/.test(a))) {
    return { allowed: false, reason: 'MCP参数包含换行符，被安全策略拒绝' }
  }
  if (argList.some(a => /^https?:\/\//i.test(a))) {
    return { allowed: false, reason: 'MCP参数不允许URL，被安全策略拒绝' }
  }

  if (firstWord === 'npx') {
    const rest = command.trim().substring(4).trim()
    if (rest && !rest.startsWith('@modelcontextprotocol/') && !rest.startsWith('@anthropic/')) {
      return { allowed: false, reason: `npx仅允许@modelcontextprotocol/或@anthropic/包: ${rest.substring(0, 50)}` }
    }
    if (!rest) {
      const pkg = argList.find(a => !a.startsWith('-'))
      if (pkg && !pkg.startsWith('@modelcontextprotocol/') && !pkg.startsWith('@anthropic/')) {
        return { allowed: false, reason: `npx仅允许@modelcontextprotocol/或@anthropic/包: ${pkg.substring(0, 50)}` }
      }
    }
    return { allowed: true }
  }

  if (firstWord === 'uvx') {
    const pkg = argList.find(a => !a.startsWith('-'))
    const pkgRe = /^(@[a-z0-9][-a-z0-9]*[a-z0-9]\/)?[a-z0-9][-a-z0-9._]*[a-z0-9]$/
    if (pkg && !pkgRe.test(pkg)) {
      return { allowed: false, reason: `uvx包名不合法，被安全策略拒绝: ${pkg.substring(0, 50)}` }
    }
    return { allowed: true }
  }

  // node / python / python3
  // P1-3 收尾：file:write 允许落盘 .txt 等任意扩展名文本，若解释器肯执行
  // 任意扩展名文件（node foo.txt / python bar.txt 均照跑），即构成
  // "写文件→执行文件" RCE 链。首个非 flag 参数视为脚本入口，
  // 必须带解释器对应的白名单扩展名且通过读路径校验
  const scriptExtRe = firstWord === 'node' ? /\.(js|mjs|cjs)$/i : /\.(py|pyw)$/i
  let sawScriptArg = false
  for (const arg of argList) {
    if (/^-{1,2}(e|eval|p|print|c|command|m|module|stdin)(=|["']|$)/i.test(arg)) {
      return { allowed: false, reason: `MCP解释器参数被禁止: ${arg}` }
    }
    if (!arg.startsWith('-') && !sawScriptArg) {
      sawScriptArg = true
      if (!scriptExtRe.test(arg)) {
        return { allowed: false, reason: `MCP脚本扩展名不在允许范围（${firstWord === 'node' ? '.js/.mjs/.cjs' : '.py'}）: ${arg.substring(0, 60)}` }
      }
    }
    const isPathLike = /^[A-Za-z]:[\\/]/.test(arg) || arg.includes('/') || arg.includes('\\') || /\.(js|mjs|cjs|py|pyw)$/i.test(arg)
    if (isPathLike) {
      const target = /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('/') || arg.startsWith('\\') ? arg : resolve(defaultHome(), arg)
      const check = validateReadPath(target)
      if (!check.safe) {
        return { allowed: false, reason: `MCP脚本路径被拒绝: ${check.reason}` }
      }
    }
  }
  return { allowed: true }
}

// A-04：dir/ls 同样是读类命令，路径参数必须走 validateReadPath，
// 否则 `dir C:\Users\x\.ssh` 可绕过 pathValidator 枚举敏感目录
const READ_SHELL_COMMANDS = ['type', 'cat', 'head', 'tail', 'find', 'grep', 'wc', 'dir', 'ls']
const WRITE_SHELL_COMMANDS = ['mkdir', 'copy', 'cp']

function tokenizeArgs(command: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of command) {
    if (ch === '"') { inQuote = !inQuote; continue }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) tokens.push(cur)
  return tokens
}

function resolveAgainstCwd(token: string, cwd?: string): string {
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith('/') || token.startsWith('\\')) return token
  return resolve(cwd || defaultHome(), token)
}

// P0-1 修复：读类白名单命令的路径参数必须通过 validateReadPath，
// 堵死 `type C:\Users\x\.ssh\id_rsa` 这类绕过 pathValidator 的读取
function validateShellPathArgs(command: string, cwd?: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
  // A-04：只过滤 '-' 开头选项和 Windows 单斜杠短 flag（/b /s /a:d 等 1-3 字符），
  // 不能把所有 '/' 开头 token 当 flag——那会把 POSIX 绝对路径 /etc/passwd 一并放过
  const tokens = tokenizeArgs(trimmed).filter(t => !t.startsWith('-') && !/^\/[a-zA-Z]:?[a-zA-Z]?[a-zA-Z]?$/.test(t))

  if (READ_SHELL_COMMANDS.includes(firstWord)) {
    for (const token of tokens) {
      const check = validateReadPath(resolveAgainstCwd(token, cwd))
      if (!check.safe) return { allowed: false, reason: `读取路径被安全策略拒绝: ${check.reason}` }
    }
  }
  if (WRITE_SHELL_COMMANDS.includes(firstWord)) {
    for (let i = 0; i < tokens.length; i++) {
      const target = resolveAgainstCwd(tokens[i], cwd)
      // copy/cp 首个参数为源（读），其余为目标（写）；mkdir 直接按写目标校验
      const check = (firstWord === 'mkdir' || (firstWord !== 'mkdir' && i > 0))
        ? validateWritePath(target)
        : validateReadPath(target)
      if (!check.safe) return { allowed: false, reason: `路径参数被安全策略拒绝: ${check.reason}` }
    }
  }
  return { allowed: true }
}

// ===== 2026-10-07（Wave 2）：git 只读子命令白名单 =====
// 原先 SHELL_ALLOWED_COMMANDS 不含 git，一切 git 命令落兜底拒绝——这是"比一般 agent 弱"
// 最直接的缺口。此处只开放**查询类**子命令；写类子命令不在表内即拒。
/** 只读子命令（查询语义，不改变仓库状态） */
const GIT_READONLY_SUBCOMMANDS = [
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'tag',
  'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'reflog'
] as const
/** 这几个子命令本身只读，但带上写 flag 就变写操作（branch -D / tag -d / remote add…） */
const GIT_SUBCOMMANDS_WITH_WRITE_FLAGS = ['branch', 'tag', 'remote']
/** 写 / 输出类 flag 名（只比 name，不含 = 后的值） */
const GIT_WRITE_FLAG = /^-{1,2}(d|D|m|M|f|u|delete|move|force|output|set-upstream|add|remove|edit|amend|create-reflog|no-verify)$/

/** git **只读**命令判定：git <只读子命令> [flags...]，且不含全局前置参数与写/输出类 flag */
function isGitReadonlyCommand(tokens: string[]): boolean {
  const sub = tokens[1]
  // 拒全局前置参数：git -C / --git-dir / --work-tree / -c / --exec-path …
  if (!sub || sub.startsWith('-')) return false
  if (!(GIT_READONLY_SUBCOMMANDS as readonly string[]).includes(sub)) return false
  const withWriteFlags = GIT_SUBCOMMANDS_WITH_WRITE_FLAGS.includes(sub)
  for (const t of tokens.slice(2)) {
    if (!t.startsWith('-')) continue
    const name = t.split('=')[0]
    // 任何子命令都不许把输出写进文件
    if (name === '--output') return false
    if (withWriteFlags && GIT_WRITE_FLAG.test(name)) return false
  }
  return true
}

export function isShellCommandAllowed(command: string, cwd?: string): { allowed: boolean; reason?: string } {
  const raw = typeof command === 'string' ? command : ''
  const metachar = findShellMetacharacter(raw)
  if (metachar) {
    return { allowed: false, reason: `命令包含shell元字符 '${metachar}'，被安全策略拒绝` }
  }

  const trimmed = raw.trim().toLowerCase()

  if (trimmed.startsWith('node -e ') || trimmed.startsWith('node -e"')) {
    // A-05：必须从原始串（raw）提取代码内容做校验，而不是 lowercase 副本——
    // 执行的是原始串，校验 lowercase 副本会造成校验输入与执行输入不一致；
    // 同时对原始串与小写串双重匹配危险模式，堵死 Process.Exit 这类大小写规避
    const codeContent = raw.trim().replace(/^node\s+-e\s*/i, '').replace(/^node\s+-e"/i, '').replace(/"$/, '')
    // P0-2 收尾：require 白名单校验先于 trusted 模板判定，两条路径统一收敛
    const illegalRequire = findIllegalRequire(codeContent)
    if (illegalRequire) {
      return { allowed: false, reason: `node -e 存在白名单外的 require 调用，被安全策略拒绝: ${illegalRequire.substring(0, 60)}` }
    }
    if (isNodeTrustedTemplate(codeContent)) {
      return { allowed: true }
    }
    const loweredCode = codeContent.toLowerCase()
    for (const pattern of NODE_E_DANGEROUS_PATTERNS) {
      if (pattern.test(codeContent) || pattern.test(loweredCode)) {
        return { allowed: false, reason: `node -e 代码包含危险模式，被安全策略拒绝` }
      }
    }
    return { allowed: true }
  }

  if (trimmed.startsWith('npm install ') || trimmed.startsWith('npm i ')) {
    const pkgPart = trimmed.replace(/^npm\s+(install|i)\s+/, '').trim()
    const pkgs = pkgPart.split(/\s+/)
    const validPkgRe = /^(@[a-z0-9][-a-z0-9]*[a-z0-9]\/)?[a-z0-9][-a-z0-9._]*[a-z0-9]$/
    for (const pkg of pkgs) {
      if (pkg.startsWith('--')) continue
      if (!validPkgRe.test(pkg)) {
        return { allowed: false, reason: `npm install 包名不合法，被安全策略拒绝: ${pkg}` }
      }
    }
    return { allowed: true }
  }

  if (trimmed.startsWith('npx ')) {
    return { allowed: false, reason: 'npx命令仅允许通过MCP spawn执行，被安全策略拒绝' }
  }

  if (trimmed.startsWith('node ') && !trimmed.startsWith('node -e')) {
    return { allowed: false, reason: 'node脚本执行仅允许通过MCP spawn或node -e受限模式，被安全策略拒绝' }
  }

  if (trimmed.startsWith('npm run')) {
    // P1-7 修复：npm run 读取 cwd 下的 package.json scripts，
    // 渲染层可用 file:write 伪造 package.json 实现任意执行，移出白名单
    return { allowed: false, reason: 'npm run 已移出白名单（package.json scripts 可被伪造实现任意执行），被安全策略拒绝' }
  }

  // 2026-10-07（Wave 2）：git 只读子命令放行（写类 / 全局前置参数 / 写 flag 一律拒，见 isGitReadonlyCommand）
  if (trimmed === 'git' || trimmed.startsWith('git ')) {
    if (isGitReadonlyCommand(trimmed.split(/\s+/))) return { allowed: true }
    return {
      allowed: false,
      reason: `git 仅允许只读子命令（${GIT_READONLY_SUBCOMMANDS.join('/')}），写类子命令、全局前置参数与写/输出类 flag 被安全策略拒绝: ${trimmed.substring(0, 50)}`
    }
  }

  // A-16：白名单前缀必须词边界匹配——'ls' 不能放行 'lsfoo'，
  // 'npm install' 不能放行 'npm install-evil'
  for (const allowed of SHELL_ALLOWED_COMMANDS) {
    const base = allowed.toLowerCase().trimEnd()
    if (trimmed === base || trimmed.startsWith(base + ' ')) {
      const pathArgCheck = validateShellPathArgs(raw, cwd)
      if (!pathArgCheck.allowed) return pathArgCheck
      return { allowed: true }
    }
  }

  return { allowed: false, reason: `命令不在白名单中: ${trimmed.substring(0, 50)}` }
}

const QUICK_COMMANDS = ['ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'cd', 'hostname', 'date', 'wc', 'head', 'tail', 'find', 'where', 'which', 'grep', 'sort', 'uniq', 'mkdir']
const HEAVY_COMMANDS = ['npm install', 'npm ci', 'pip install', 'yarn install', 'pnpm install']
const QUICK_TIMEOUT = 10000
const STANDARD_TIMEOUT = 60000
const HEAVY_TIMEOUT = 120000
const ABSOLUTE_CAP = 180000

export function getTimeoutForCommand(command: string, userTimeout?: number): number {
  const trimmed = command.trim().toLowerCase()
  const firstWord = trimmed.split(/\s+/)[0]
  let tier: number
  if (QUICK_COMMANDS.includes(firstWord)) {
    tier = QUICK_TIMEOUT
  } else if (HEAVY_COMMANDS.some(h => trimmed.startsWith(h))) {
    tier = HEAVY_TIMEOUT
  } else {
    tier = STANDARD_TIMEOUT
  }
  if (userTimeout && userTimeout > 0) {
    tier = Math.min(userTimeout, ABSOLUTE_CAP)
  }
  return Math.min(tier, ABSOLUTE_CAP)
}

export const HTTP_MAX_BODY_SIZE = 1024 * 1024
export const HTTP_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
export const HTTP_TIMEOUT_TIER: Record<string, number> = { GET: 15000, HEAD: 10000, POST: 30000, PUT: 30000, PATCH: 30000, DELETE: 15000 }
export const HTTP_ABSOLUTE_CAP = 60000
