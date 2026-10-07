import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  isShellCommandAllowed,
  getTimeoutForCommand,
  HTTP_ALLOWED_METHODS,
  HTTP_TIMEOUT_TIER,
  HTTP_ABSOLUTE_CAP,
  isMcpCommandAllowed
} from '@electron/shell-security'
import { validateWritePath, validateOpenPath } from '@electron/pathValidator'

describe('IPC安全 - shell:exec 白名单机制 (生产代码导入)', () => {
  describe('白名单命令允许', () => {
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

    it('npm run 已移出白名单（package.json scripts 可被伪造实现任意执行）', () => {
      expect(isShellCommandAllowed('npm run build').allowed).toBe(false)
    })

    it('pip install 允许', () => {
      expect(isShellCommandAllowed('pip install requests').allowed).toBe(true)
    })

    it('pwd 允许', () => {
      expect(isShellCommandAllowed('pwd').allowed).toBe(true)
    })

    it('cp 允许', () => {
      expect(isShellCommandAllowed('cp a.txt b.txt').allowed).toBe(true)
    })
  })

  describe('VULN-03: npx 命令已被禁止 (安全修复回归)', () => {
    it('npx 命令现在被拒绝', () => {
      const r = isShellCommandAllowed('npx tsx script.ts')
      expect(r.allowed).toBe(false)
      expect(r.reason).toContain('MCP')
    })
  })

  describe('VULN-04: node script 执行已被禁止 (安全修复回归)', () => {
    it('node script.js 现在被拒绝', () => {
      const r = isShellCommandAllowed('node test.js')
      expect(r.allowed).toBe(false)
      expect(r.reason).toContain('MCP')
    })
  })

  describe('VULN-18: 破坏性命令已被移除 (安全修复回归)', () => {
    it('rm 命令已被移除白名单', () => {
      expect(isShellCommandAllowed('rm oldfile.txt').allowed).toBe(false)
    })

    it('del 命令已被移除白名单', () => {
      expect(isShellCommandAllowed('del file.txt').allowed).toBe(false)
    })

    it('mv 命令已被移除白名单', () => {
      expect(isShellCommandAllowed('mv a.txt b.txt').allowed).toBe(false)
    })

    it('move 命令已被移除白名单', () => {
      expect(isShellCommandAllowed('move a.txt b.txt').allowed).toBe(false)
    })

    it('whoami 命令已被移除白名单', () => {
      expect(isShellCommandAllowed('whoami').allowed).toBe(false)
    })
  })

  describe('node -e 危险模式拦截', () => {
    it('require("child_process") → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "const cp = require(\'child_process\')"')
      expect(r.allowed).toBe(false)
    })

    it('process.exit → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "process.exit(1)"').allowed).toBe(false)
    })

    it('.unlink( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "require(\'fs\').unlink(\'important.txt\')"').allowed).toBe(false)
    })

    it('.rmdir( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "require(\'fs\').rmdir(\'important_dir\')"').allowed).toBe(false)
    })

    it('.chmod( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "require(\'fs\').chmod(\'file.txt\', 0o777)"').allowed).toBe(false)
    })

    it('eval( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "eval(\'malicious code\')"').allowed).toBe(false)
    })

    it('Function( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "new Function(\'return 1\')"').allowed).toBe(false)
    })

    it('.execSync( → 拒绝', () => {
      expect(isShellCommandAllowed('node -e "require(\'child_process\').execSync(\'rm -rf /\')"').allowed).toBe(false)
    })
  })

  describe('node -e 安全命令通过', () => {
    it('writeFileSync(允许) - 但需满足写入路径约束', () => {
      const r = isShellCommandAllowed('node -e "require(\'fs\').writeFileSync(\'test.txt\',\'hello\')"')
      expect(r.allowed).toBe(false)
    })

    it('readFileSync → 拒绝（P0-2：读原语可窃取 token 文件，已入黑名单）', () => {
      expect(isShellCommandAllowed('node -e "require(\'fs\').readFileSync(\'test.txt\',\'utf-8\')"').allowed).toBe(false)
    })

    it('JSON操作 → 允许', () => {
      expect(isShellCommandAllowed('node -e "JSON.stringify({a:1})"').allowed).toBe(true)
    })

    it('docx库 + writeFileSync + Desktop路径 → 允许', () => {
      const r = isShellCommandAllowed('node -e "require(\'docx\');require(\'fs\').writeFileSync(process.env.USERPROFILE+\'/Desktop/test.docx\',\'data\')"')
      expect(r.allowed).toBe(true)
    })

    it('docx库 + writeFileSync + 无安全路径 → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'docx\');require(\'fs\').writeFileSync(\'/etc/evil\',\'data\')"')
      expect(r.allowed).toBe(false)
    })
  })

  describe('VULN-14: node -e trusted template 绕过修复 (安全修复回归)', () => {
    it('含Desktop字符串但实际写入非法路径 → 拒绝', () => {
      const r = isShellCommandAllowed('node -e "require(\'docx\');var p=\'Desktop\';require(\'fs\').writeFileSync(\'/etc/evil\',\'data\')"')
      expect(r.allowed).toBe(false)
    })
  })

  describe('非白名单命令拦截', () => {
    it('python → 拒绝', () => {
      const r = isShellCommandAllowed('python script.py')
      expect(r.allowed).toBe(false)
    })

    it('未知命令 → 拒绝', () => {
      const r = isShellCommandAllowed('randombinary --dangerous-flag')
      expect(r.allowed).toBe(false)
    })
  })

  describe('编码绕过防护', () => {
    it('Buffer.from( → 拦截', () => {
      expect(isShellCommandAllowed('node -e "Buffer.from(\'726d202d7266\',\'hex\')"').allowed).toBe(false)
    })

    it('atob( → 拦截', () => {
      expect(isShellCommandAllowed('node -e "atob(\'cm0gLXJmIC8=\')"').allowed).toBe(false)
    })

    it('十六进制转义 → 拦截', () => {
      expect(isShellCommandAllowed('node -e "console.log(\'\\x68\\x65\\x78\')"').allowed).toBe(false)
    })

    it('unicode转义 → 拦截', () => {
      expect(isShellCommandAllowed('node -e "console.log(\'\\u0072\\u006d\')"').allowed).toBe(false)
    })

    it('模板字符串 ${...} → 拦截', () => {
      expect(isShellCommandAllowed('node -e "const cmd=`rm -rf ${dir}`"').allowed).toBe(false)
    })

    it('setTimeout( → 拦截', () => {
      expect(isShellCommandAllowed('node -e "setTimeout(()=>{},1000)"').allowed).toBe(false)
    })
  })

  describe('npm install 包名校验', () => {
    it('合法包名 → 允许', () => {
      expect(isShellCommandAllowed('npm install docx').allowed).toBe(true)
    })

    it('scoped包名 → 允许', () => {
      expect(isShellCommandAllowed('npm install @modelcontextprotocol/server-filesystem').allowed).toBe(true)
    })

    it('含路径遍历的包名 → 拒绝', () => {
      expect(isShellCommandAllowed('npm install ../evil').allowed).toBe(false)
    })

    it('含特殊字符的包名 → 拒绝', () => {
      expect(isShellCommandAllowed('npm install evil;rm -rf /').allowed).toBe(false)
    })
  })
})

describe('IPC安全 - MCP命令校验 (VULN-11回归)', () => {
  it('npx @modelcontextprotocol/xxx → 允许', () => {
    expect(isMcpCommandAllowed('npx @modelcontextprotocol/server-filesystem').allowed).toBe(true)
  })

  it('npx @anthropic/xxx → 允许', () => {
    expect(isMcpCommandAllowed('npx @anthropic/mcp-server').allowed).toBe(true)
  })

  it('npx 其他包 → 拒绝', () => {
    const r = isMcpCommandAllowed('npx evil-package')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('@modelcontextprotocol')
  })

  it('node → 允许', () => {
    expect(isMcpCommandAllowed('node server.js').allowed).toBe(true)
  })

  it('python3 → 允许', () => {
    expect(isMcpCommandAllowed('python3 server.py').allowed).toBe(true)
  })

  it('uvx → 允许', () => {
    expect(isMcpCommandAllowed('uvx mcp-server').allowed).toBe(true)
  })

  it('cmd.exe → 拒绝', () => {
    expect(isMcpCommandAllowed('cmd.exe /c evil').allowed).toBe(false)
  })

  it('powershell → 拒绝', () => {
    expect(isMcpCommandAllowed('powershell -c evil').allowed).toBe(false)
  })
})

describe('IPC安全 - 超时层级', () => {
  it('echo → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('echo hello')).toBe(10000)
  })

  it('ls → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('ls -la')).toBe(10000)
  })

  it('npm install → 重型命令 tier=120s', () => {
    expect(getTimeoutForCommand('npm install')).toBe(120000)
  })

  it('npm run build → 已移出重型清单，默认 tier=60s（P1-7：npm run 整体禁用）', () => {
    expect(getTimeoutForCommand('npm run build')).toBe(60000)
  })

  it('用户指定timeout被绝对上限截断', () => {
    expect(getTimeoutForCommand('echo hi', 999999)).toBe(180000)
  })

  it('mkdir → 快速命令 tier=10s', () => {
    expect(getTimeoutForCommand('mkdir newdir')).toBe(10000)
  })
})

describe('IPC安全 - http:fetch 安全策略', () => {
  it('GET 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('GET'))
  it('POST 允许', () => expect(HTTP_ALLOWED_METHODS).toContain('POST'))
  it('CONNECT 禁止', () => expect(HTTP_ALLOWED_METHODS).not.toContain('CONNECT'))
  it('TRACE 禁止', () => expect(HTTP_ALLOWED_METHODS).not.toContain('TRACE'))

  it('GET超时15s', () => expect(HTTP_TIMEOUT_TIER.GET).toBe(15000))
  it('POST超时30s', () => expect(HTTP_TIMEOUT_TIER.POST).toBe(30000))
  it('绝对上限60s', () => expect(HTTP_ABSOLUTE_CAP).toBe(60000))
})

describe('IPC安全 - 路径校验 (VULN-05~10回归)', () => {
  it('sanitizeKey: 合法key → 通过', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('api-config').safe).toBe(true)
    expect(sanitizeKey('vector_index_01').safe).toBe(true)
    expect(sanitizeKey('my-store-key').safe).toBe(true)
  })

  it('sanitizeKey: 含路径遍历 → 拒绝', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('../../etc/passwd').safe).toBe(false)
    expect(sanitizeKey('..\\windows\\system32').safe).toBe(false)
  })

  it('sanitizeKey: 含特殊字符 → 拒绝', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('key with spaces').safe).toBe(false)
    expect(sanitizeKey('key;rm -rf /').safe).toBe(false)
    expect(sanitizeKey('key$(evil)').safe).toBe(false)
  })

  it('sanitizeKey: 以点开头 → 拒绝', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('.hidden').safe).toBe(false)
  })

  it('sanitizeKey: 空key → 拒绝', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('').safe).toBe(false)
  })

  it('sanitizeKey: 超长key → 拒绝', async () => {
    const { sanitizeKey } = await import('@electron/pathValidator')
    expect(sanitizeKey('a'.repeat(129)).safe).toBe(false)
  })
})

describe('IPC安全 - XSS防护 (VULN-13回归)', () => {
  it('inlineFormat过滤javascript:链接', async () => {
    const { renderToHtml, parseMarkdownAstWithRanges } = await import('@/services/resultBeautifier')
    const md = '[click](javascript:alert(1))'
    const ast = parseMarkdownAstWithRanges(md)
    const html = renderToHtml({ type: 'document', children: ast.children })
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('unsafe-link')
  })

  it('inlineFormat过滤data:链接', async () => {
    const { renderToHtml, parseMarkdownAstWithRanges } = await import('@/services/resultBeautifier')
    const md = '[click](data:text/html,<script>alert(1)</script>)'
    const ast = parseMarkdownAstWithRanges(md)
    const html = renderToHtml({ type: 'document', children: ast.children })
    expect(html).not.toContain('data:')
    expect(html).toContain('unsafe-link')
  })

  it('inlineFormat允许http/https链接', async () => {
    const { renderToHtml, parseMarkdownAstWithRanges } = await import('@/services/resultBeautifier')
    const md = '[safe](https://example.com)'
    const ast = parseMarkdownAstWithRanges(md)
    const html = renderToHtml({ type: 'document', children: ast.children })
    expect(html).toContain('href=')
    expect(html).toContain('https://example.com')
    expect(html).not.toContain('unsafe-link')
  })
})

describe('IPC安全 - P0-2 收尾：node -e 动态 require 与句柄式写原语', () => {
  it('require(process.env.M) 动态 require → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "const m=require(process.env.M);m.run()"')
    expect(r.allowed).toBe(false)
  })

  it('require(变量) → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "const x=\'fs\';const m=require(x)"')
    expect(r.allowed).toBe(false)
  })

  it('require(白名单外字面量模块) → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "const z=require(\'zlib\')"')
    expect(r.allowed).toBe(false)
  })

  it('trusted 模板路径同样受 require 白名单约束 → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "require(\'docx\');const m=require(process.env.M)"')
    expect(r.allowed).toBe(false)
  })

  it('fs.openSync+fs.writeSync 绕过写路径约束 → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "const fs=require(\'fs\');const fd=fs.openSync(\'C:\\\\evil.txt\',\'w\');fs.writeSync(fd,\'data\');fs.closeSync(fd)"')
    expect(r.allowed).toBe(false)
  })

  it('fs.appendFileSync → 拒绝', () => {
    const r = isShellCommandAllowed('node -e "const fs=require(\'fs\');fs.appendFileSync(\'C:\\\\evil.txt\',\'data\')"')
    expect(r.allowed).toBe(false)
  })

  it('合法模板 require(docx/fs/path) → 仍允许', () => {
    const r = isShellCommandAllowed('node -e "const {Document}=require(\'docx\');const fs=require(\'fs\');fs.writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\a.docx\',\'x\')"')
    expect(r.allowed).toBe(true)
  })
})

describe('IPC安全 - P1-3 收尾：解释器脚本扩展名约束', () => {
  it('node 执行 .txt 脚本 → 拒绝', () => {
    const r = isMcpCommandAllowed('node', ['C:\\Users\\Default\\evil.txt'])
    expect(r.allowed).toBe(false)
  })

  it('python 执行 .txt 脚本 → 拒绝', () => {
    const r = isMcpCommandAllowed('python', ['C:\\Users\\Default\\evil.txt'])
    expect(r.allowed).toBe(false)
  })

  it('node 执行无扩展名文件（Node 会尝试按模块解析）→ 拒绝', () => {
    const r = isMcpCommandAllowed('node', ['C:\\Users\\Default\\evil'])
    expect(r.allowed).toBe(false)
  })

  it('node --eval= 内联代码 → 拒绝', () => {
    const r = isMcpCommandAllowed('node', ['--eval=process.exit(1)'])
    expect(r.allowed).toBe(false)
  })

  it('node 执行 .js 脚本（允许目录内）→ 允许', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = isMcpCommandAllowed('node', [join(home, 'mcp-server', 'index.js')])
    expect(r.allowed).toBe(true)
  })

  it('python 执行 .py 脚本（允许目录内）→ 允许', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = isMcpCommandAllowed('python', [join(home, 'mcp-server', 'server.py')])
    expect(r.allowed).toBe(true)
  })

  it('node 脚本 + 普通参数 → 允许', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = isMcpCommandAllowed('node', [join(home, 'mcp-server', 'index.js'), '--port', '3000'])
    expect(r.allowed).toBe(true)
  })
})

describe('IPC安全 - P1-3 收尾：脚本类扩展名写入/打开封禁', () => {
  it('file:write 写入 .py → 拒绝', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = validateWritePath(join(home, 'evil.py'))
    expect(r.safe).toBe(false)
  })

  it('file:write 写入 .pyw/.mjs/.cjs → 拒绝', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    expect(validateWritePath(join(home, 'evil.pyw')).safe).toBe(false)
    expect(validateWritePath(join(home, 'evil.mjs')).safe).toBe(false)
    expect(validateWritePath(join(home, 'evil.cjs')).safe).toBe(false)
  })

  it('file:open 打开 .py（双击即执行）→ 拒绝', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = validateOpenPath(join(home, 'evil.py'))
    expect(r.safe).toBe(false)
  })

  it('file:write 写入普通文本 → 仍允许', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    const r = validateWritePath(join(home, 'Desktop', 'note.txt'))
    expect(r.safe).toBe(true)
  })
})

describe('IPC安全 - P1-30 回归：l2-file-creator-v1 的 node -e 命令可执行', () => {
  it('脚本不含未定义 debugLog / String.fromCharCode，且通过 shell 安全校验', async () => {
    const manifests = (await import('@/data/l2Manifests')).default
    const m = manifests.find(x => x.identity.id === 'l2-file-creator-v1')
    expect(m).toBeDefined()
    const cmd = String(m?.execution.dagPlan?.steps?.[0]?.params?.command || '')
    expect(cmd).not.toContain('debugLog')
    expect(cmd).not.toContain('String.fromCharCode')
    const check = isShellCommandAllowed(cmd)
    expect(check.allowed).toBe(true)
  })
})


describe('IPC安全 - E-2 修复：快捷方式类扩展名封禁 + openPath 白名单', () => {
  const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
  const onDesktop = (name: string) => join(home, 'Desktop', name)

  it('file:write 写入 .lnk 快捷方式 → 拒绝', () => {
    expect(validateWritePath(onDesktop('x.lnk')).safe).toBe(false)
  })

  it('file:write 写入 .url → 拒绝', () => {
    expect(validateWritePath(onDesktop('x.url')).safe).toBe(false)
  })

  it('file:open 打开 .lnk 快捷方式 → 拒绝', () => {
    expect(validateOpenPath(onDesktop('x.lnk')).safe).toBe(false)
  })

  it('file:open 打开 .url → 拒绝', () => {
    expect(validateOpenPath(onDesktop('x.url')).safe).toBe(false)
  })

  it('file:open 打开 .application/.appref-ms → 拒绝', () => {
    expect(validateOpenPath(onDesktop('x.application')).safe).toBe(false)
    expect(validateOpenPath(onDesktop('x.appref-ms')).safe).toBe(false)
  })

  it('file:open 打开未知扩展名（不在白名单）→ 拒绝（fail-closed）', () => {
    expect(validateOpenPath(onDesktop('payload.xyz')).safe).toBe(false)
  })

  it('file:open 打开常见文档/图片/媒体 → 仍允许', () => {
    for (const f of ['report.docx', 'report.pdf', 'note.txt', 'pic.png', 'pic.jpg', 'clip.mp4', 'bundle.zip', 'doc.md', 'page.html', 'data.csv']) {
      expect(validateOpenPath(onDesktop(f)).safe).toBe(true)
    }
  })
})


describe('IPC安全 - E-3 修复：node -e 写路径规范化 + 扩展名校验', () => {
  const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
  const posixHome = home.replace(/\\/g, '/')

  it('字面量路径 + .. 穿越到 Windows\\evil.dll → 拒绝', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync('${posixHome}/Desktop/../../../Windows/evil.dll','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(false)
  })

  it('字面量路径写到 Desktop\\x.js（危险扩展名）→ 拒绝', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync('${posixHome}/Desktop/x.js','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(false)
  })

  it('process.env.USERPROFILE 拼接 + .. 穿越 → 拒绝', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync(process.env.USERPROFILE+'/Desktop/../../../Windows/evil.dll','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(false)
  })

  it('process.env.USERPROFILE 拼接写到 Desktop\\x.js → 拒绝', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync(process.env.USERPROFILE+'/Desktop/x.js','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(false)
  })

  it('无法解析的写目标表达式 → 拒绝（fail-closed）', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync(getPath(),'data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(false)
  })

  it('字面量路径写到 Desktop\\x.docx（安全）→ 仍允许', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync('${posixHome}/Desktop/x.docx','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(true)
  })

  it('env 拼接写到 Desktop\\x.docx（安全，manifest 形态）→ 仍允许', () => {
    const cmd = `node -e "require('docx');require('fs').writeFileSync(process.env.USERPROFILE+'\\\\Desktop\\\\x.docx','data')"`
    expect(isShellCommandAllowed(cmd).allowed).toBe(true)
  })
})


describe('IPC安全 - V2 考试回归：白名单命令尾随换行 + 路径 .. 穿越', () => {
  const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'

  // —— V2-R15：模型输出的白名单命令常带尾随换行，不得因此被整体拒绝 ——
  it('尾随换行的白名单命令应放行（V2-R15：此前 `ls\\n` 被判元字符 \\n 拒绝）', () => {
    expect(isShellCommandAllowed('ls\n').allowed).toBe(true)
    expect(isShellCommandAllowed('ls -la\r\n').allowed).toBe(true)
    expect(isShellCommandAllowed('  pwd  ').allowed).toBe(true)
  })

  it('内嵌换行的命令注入仍拒绝（回归护栏，不得为放行尾随换行而洞开注入面）', () => {
    expect(isShellCommandAllowed('ls\nrm -rf /').allowed).toBe(false)
    expect(isShellCommandAllowed('ls\n whoami').allowed).toBe(false)
    expect(isShellCommandAllowed('ls -la && whoami').allowed).toBe(false)
  })

  // —— V2-S04：含 .. 段的路径应被拒，即便 resolve() 归一化后仍落在允许目录内 ——
  it('写路径含 .. 穿越段 → 拒绝（V2-S04：此前归一化后落 Desktop 内被放行）', () => {
    const raw = `${home}\\Desktop\\HoloExam\\out\\..\\..\\Windows\\evil.md`
    const r = validateWritePath(raw)
    expect(r.safe).toBe(false)
    expect(r.reason).toContain('..')
  })

  it('读路径含 .. 穿越段（归一化后仍在允许目录内）→ 拒绝', async () => {
    const { validateReadPath } = await import('@electron/pathValidator')
    expect(validateReadPath(`${home}/Desktop/../Documents/x.txt`).safe).toBe(false)
  })

  it('合法绝对路径（无 .. 段）→ 仍允许（回归护栏）', () => {
    expect(validateWritePath(`${home}\\Desktop\\HoloExam\\out\\ok.md`).safe).toBe(true)
  })
})
