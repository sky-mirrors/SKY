const SHELL_ALLOWED_COMMANDS = [
  'npm install',
  'npm run',
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

const NODE_E_DANGEROUS_PATTERNS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]net['"]\s*\)/,
  /require\s*\(\s*['"]http['"]\s*\)/,
  /require\s*\(\s*['"]https['"]\s*\)/,
  /require\s*\(\s*['"]dgram['"]\s*\)/,
  /process\.exit/,
  /process\.kill/,
  /process\.binding/,
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
]

const NODE_E_TRUSTED_SIGNATURES = [
  /require\s*\(\s*['"]docx['"]\s*\)/,
  /require\s*\(\s*['"]xlsx['"]\s*\)/,
  /require\s*\(\s*['"]pdf-parse['"]\s*\)/,
  /require\s*\(\s*['"]mammoth['"]\s*\)/,
  /require\s*\(\s*['"]archiver['"]\s*\)/,
  /require\s*\(\s*['"]marked['"]\s*\)/,
]

const NODE_E_ALLOWED_WRITE_PATTERNS = [
  /writeFileSync\s*\(\s*['"](?:[^'"]*[/\\])?(Desktop|Documents|Downloads)[/\\]/i,
  /writeFileSync\s*\(\s*process\.env\.(?:USERPROFILE|HOME|userprofile|home)/i,
]

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
      if (!NODE_E_ALLOWED_WRITE_PATTERNS.some(p => p.test(codeContent))) return false
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

export function isMcpCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const firstWord = command.trim().split(/\s+/)[0].toLowerCase()
  if (!MCP_ALLOWED_COMMANDS.includes(firstWord)) {
    return { allowed: false, reason: `MCP命令不在白名单中: ${firstWord}` }
  }
  if (firstWord === 'npx') {
    const rest = command.trim().substring(4).trim()
    if (!rest.startsWith('@modelcontextprotocol/') && !rest.startsWith('@anthropic/')) {
      return { allowed: false, reason: `npx仅允许@modelcontextprotocol/或@anthropic/包: ${rest.substring(0, 50)}` }
    }
  }
  return { allowed: true }
}

export function isShellCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim().toLowerCase()

  if (trimmed.startsWith('node -e ') || trimmed.startsWith('node -e"')) {
    const codeContent = trimmed.replace(/^node\s+-e\s*/, '').replace(/^node\s+-e"/, '').replace(/"$/, '')
    if (isNodeTrustedTemplate(codeContent)) {
      return { allowed: true }
    }
    for (const pattern of NODE_E_DANGEROUS_PATTERNS) {
      if (pattern.test(codeContent)) {
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

  const firstCmd = trimmed.split(/\s+/)[0] + ' '
  for (const allowed of SHELL_ALLOWED_COMMANDS) {
    if (trimmed.startsWith(allowed.toLowerCase()) || firstCmd === allowed.toLowerCase()) {
      return { allowed: true }
    }
  }

  return { allowed: false, reason: `命令不在白名单中: ${trimmed.substring(0, 50)}` }
}

const QUICK_COMMANDS = ['ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'cd', 'hostname', 'date', 'wc', 'head', 'tail', 'find', 'where', 'which', 'grep', 'sort', 'uniq', 'mkdir']
const HEAVY_COMMANDS = ['npm run build', 'npm install', 'npm ci', 'pip install', 'yarn install', 'pnpm install']
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
