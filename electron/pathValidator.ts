import { resolve, sep, basename, dirname } from 'path'
import { realpathSync } from 'fs'

// P0-4 修复：所有敏感路径正则统一匹配"规范化路径"（反斜杠已替换为 /），
// 使 POSIX 风格模式在 Windows 上同样生效
const FORBIDDEN_READ_PATHS = [
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /\/\.aws\//i,
  /\/\.config\/chromium/i,
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /\/SAM$/i,
  /\/SYSTEM$/i,
  /\/SECURITY$/i,
  /\/private\/etc/i,
  /\/AppData\/Local\/Microsoft\/Credentials/i,
  /\/AppData\/Roaming\/Microsoft\/Credentials/i,
  /\/\.kube\/config/i,
  /\/\.docker\/config\.json/i,
  /\/\.npmrc$/i,
  /\/\.pypirc$/i,
  /\/\.netrc$/i,
]

// P0-6 修复：写专用敏感目标清单（持久化 / 配置投毒位置）
const FORBIDDEN_WRITE_PATHS = [
  /\/start menu\/programs\/startup\//i,
  /\/windowspowerShell\/[^/]*profile\.ps1$/i,
  /\/powershell\/[^/]*profile\.ps1$/i,
  /\/\.bashrc$/i,
  /\/\.bash_profile$/i,
  /\/\.zshrc$/i,
  /\/\.profile$/i,
  /\/\.ssh\//i,
  /\/\.gitconfig$/i,
  /\/\.npmrc$/i,
  /\/\.netrc$/i,
  /\/\.pypirc$/i,
  /\/etc\/hosts$/i,
  /\/etc\/passwd$/i,
  /\/etc\/shadow$/i,
  /\/windows\/system32\//i,
  /\/program files\//i,
]

// E-2 修复：openPath 采用白名单（fail-closed）。validateOpenPath 先过黑名单
// （DANGEROUS_EXTENSIONS 优先），再要求扩展名落在本表内——杜绝"黑名单漏一项即
// 放行 ShellExecute"的结构性缺口。含 .js 之类会被 ShellExecute/WScript 直接执行
// 的扩展名不得进入本表（已在 DANGEROUS_EXTENSIONS 内）。无扩展名文件同样拒绝。
const SAFE_OPEN_EXTENSIONS = [
  // 文本 / 数据
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.json5',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env.example',
  // 网页 / 源码（非 ShellExecute 可执行）
  '.html', '.htm', '.css', '.scss', '.less', '.ts', '.tsx', '.vue', '.jsx',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  // 图像
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico',
  '.tif', '.tiff', '.heic', '.psd', '.ai',
  // 文档
  '.pdf', '.doc', '.docx', '.docm', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub', '.pages', '.numbers', '.key',
  // 压缩包
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  // 音视频
  '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.wav', '.wma',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv',
  // 字幕
  '.srt', '.vtt',
]

// P1-3 收尾：.py/.pyw 与 .mjs/.cjs 是解释器可直接执行的脚本扩展名，
// 允许 file:write 落盘即构成"写文件→MCP 解释器执行"RCE 链（.js 已在列）；
// 同时 validateOpenPath 会拒绝 shell 打开这类文件（双击即执行）
const DANGEROUS_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.mjs', '.cjs', '.py', '.pyw',
  '.wsf', '.wsh', '.msi', '.msp', '.mst', '.dll', '.ocx', '.sys',
  '.scr', '.pif', '.com', '.cpl', '.inf', '.reg', '.hta',
  '.sh', '.bash', '.zsh', '.fish', '.run', '.bin', '.app',
  '.deb', '.rpm', '.dmg', '.pkg',
  // E-2 修复：ShellExecute 可解析执行/跳转的"快捷方式/系统组件"类型。
  // 黑名单此前漏了它们——file:write 落盘 .lnk + shell:openPath 打开 = 渲染层
  // RCE 闭环（快捷方式内部的目标路径与参数完全绕开路径层校验）
  '.lnk', '.url', '.application', '.appref-ms',
  '.msc', '.scf', '.gadget', '.ps1xml', '.psc1', '.ps2',
  '.shb', '.shs', '.jnlp', '.jar', '.website', '.library-ms', '.search-ms',
]

// 2026-10-09 删除：`initAllowedDirs(dirs)` 零引用（生产与测试都没人调）——它是"允许目录
// 可注入"的预留口，但没有任何调用方在为它举证。`_allowedBaseDirs` 本身保留：getAllowedBaseDirs
// 首次调用时会自行填充它作缓存（见下），注入路径只是多余的旁路。见 docs/95 §6。
let _allowedBaseDirs: string[] | null = null

export function getAllowedBaseDirs(): string[] {
  if (_allowedBaseDirs) return _allowedBaseDirs
  try {
    const { app } = require('electron') as typeof import('electron')
    _allowedBaseDirs = [
      app.getPath('userData'),
      app.getPath('desktop'),
      app.getPath('documents'),
      app.getPath('downloads'),
      app.getPath('home'),
    ]
  } catch {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
    _allowedBaseDirs = [home]
  }
  return _allowedBaseDirs
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

// P1-8 修复：解析到最深的"已存在祖先"的真实路径，再拼回缺失尾段。
// 防止允许目录内的符号链接 / junction 逃逸到任意位置
function realpathDeepest(p: string): string {
  const missing: string[] = []
  let current = p
  while (true) {
    try {
      const real = realpathSync(current)
      let result = real
      for (const part of missing.reverse()) result = resolve(result, part)
      return result
    } catch {
      const parent = dirname(current)
      if (parent === current) return p
      missing.push(basename(current))
      current = parent
    }
  }
}

// P0-5 修复：Windows 会剥离文件名尾随的点与空格，扩展名判定必须先剥离；
// 剥离后与原名不一致的路径一律视为可疑
export function getSafeExtension(filePath: string): { ext: string; suspicious: boolean } {
  const rawBase = basename(filePath)
  const stripped = rawBase.replace(/[. ]+$/, '')
  const suspicious = stripped !== rawBase
  const dotIdx = stripped.lastIndexOf('.')
  const ext = dotIdx >= 0 ? stripped.slice(dotIdx).toLowerCase() : ''
  return { ext, suspicious }
}

export function hasSuspiciousBasename(filePath: string): boolean {
  const base = basename(filePath)
  // 尾随点/空格（Windows 剥离语义）或 NTFS 备用数据流冒号
  return /[. ]$/.test(base) || base.includes(':')
}

// V2-S04 修复：输入路径中任何 '..' 段一律拒绝。仅校验 resolve() 归一化后的落点会
// 漏判 `out\..\..\Windows\evil.md` 这类「归一化后仍在允许目录内」的穿越（resolve 把
// .. 折叠掉，落点看似合法）。内部构造的已归一化路径（如 join(p,'..') 的结果）不含
// '..' 段，不受影响。口径与 sanitizeKey 的 '..' 拒绝一致。
function hasTraversalSegment(input: string): boolean {
  return input.split(/[\\/]+/).some(seg => seg === '..')
}

export function validatePath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { safe: false, resolved: '', reason: '路径为空' }
  }
  if (hasTraversalSegment(inputPath)) {
    return { safe: false, resolved: '', reason: `路径包含 '..' 穿越段，被安全策略拒绝: ${inputPath}` }
  }
  const resolved = resolve(inputPath)
  const realResolved = realpathDeepest(resolved)

  const isAllowed = getAllowedBaseDirs().some(dir => {
    const realDir = realpathDeepest(dir)
    return realResolved === realDir || realResolved.startsWith(realDir + sep)
  })
  if (!isAllowed) {
    return { safe: false, resolved: realResolved, reason: `路径不在允许目录内: ${realResolved}` }
  }

  const normalized = normalizeSeparators(realResolved)
  for (const pattern of FORBIDDEN_READ_PATHS) {
    if (pattern.test(normalized)) {
      return { safe: false, resolved: realResolved, reason: `路径包含敏感目录: ${realResolved}` }
    }
  }

  return { safe: true, resolved: realResolved }
}

export function validateReadPath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  const result = validatePath(inputPath)
  if (!result.safe) return result
  // A-20：读路径与写路径校验对称——NTFS ADS 冒号与尾随点/空格同样拒绝，
  // 否则可读取允许目录内文件的备用数据流（如 file.txt:stream）绕过扩展名管控
  if (hasSuspiciousBasename(result.resolved)) {
    return { safe: false, resolved: result.resolved, reason: `文件名以点/空格结尾或包含冒号，被安全策略拒绝: ${result.resolved}` }
  }
  return result
}

// P0-6 修复：写专用校验——敏感写入目标 + 可执行/脚本扩展名 + Windows 尾随点/空格 + ADS
export function validateWritePath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  const result = validatePath(inputPath)
  if (!result.safe) return result

  const normalized = normalizeSeparators(result.resolved)
  for (const pattern of FORBIDDEN_WRITE_PATHS) {
    if (pattern.test(normalized)) {
      return { safe: false, resolved: result.resolved, reason: `敏感写入目标，被安全策略拒绝: ${result.resolved}` }
    }
  }

  if (hasSuspiciousBasename(result.resolved)) {
    return { safe: false, resolved: result.resolved, reason: `文件名以点/空格结尾或包含冒号，被安全策略拒绝: ${result.resolved}` }
  }

  const { ext } = getSafeExtension(result.resolved)
  if (ext && DANGEROUS_EXTENSIONS.includes(ext)) {
    return { safe: false, resolved: result.resolved, reason: `禁止写入可执行/脚本文件: ${ext}` }
  }

  return result
}

// E-2 修复：openPath 由"黑名单"升级为"黑名单优先 + 白名单兜底"（fail-closed）。
// 旧实现只挡 DANGEROUS_EXTENSIONS 命中项，漏了 .lnk/.url 等 ShellExecute 可解析
// 类型即可整链绕过；现改为：① 命中可执行/脚本/快捷方式黑名单 → 拒绝；② 其余
// 扩展名必须落在 SAFE_OPEN_EXTENSIONS 白名单内，否则拒绝（未知/无扩展名一并拒绝）。
export function validateOpenPath(filePath: string): { safe: boolean; resolved: string; reason?: string } {
  const pathCheck = validatePath(filePath)
  if (!pathCheck.safe) return pathCheck

  if (hasSuspiciousBasename(pathCheck.resolved)) {
    return { safe: false, resolved: pathCheck.resolved, reason: `文件名以点/空格结尾或包含冒号，被安全策略拒绝: ${pathCheck.resolved}` }
  }

  const { ext } = getSafeExtension(pathCheck.resolved)
  if (ext && DANGEROUS_EXTENSIONS.includes(ext)) {
    return { safe: false, resolved: pathCheck.resolved, reason: `禁止打开可执行/脚本文件: ${ext}` }
  }
  if (!ext || !SAFE_OPEN_EXTENSIONS.includes(ext)) {
    return { safe: false, resolved: pathCheck.resolved, reason: `文件类型不在可打开白名单内: ${ext || '(无扩展名)'}` }
  }

  return pathCheck
}

export function sanitizeKey(key: string): { safe: boolean; reason?: string } {
  if (!key || key.length === 0) {
    return { safe: false, reason: '键名不能为空' }
  }
  if (key.length > 128) {
    return { safe: false, reason: '键名过长(上限128字符)' }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return { safe: false, reason: '键名只允许字母、数字、下划线和连字符' }
  }
  if (key.startsWith('.') || key.includes('..')) {
    return { safe: false, reason: '键名不能以点开头或包含路径遍历' }
  }
  return { safe: true }
}

export { FORBIDDEN_READ_PATHS, FORBIDDEN_WRITE_PATHS, DANGEROUS_EXTENSIONS, SAFE_OPEN_EXTENSIONS }
