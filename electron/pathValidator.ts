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

const SAFE_OPEN_EXTENSIONS = [
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.css', '.js', '.ts', '.vue', '.py', '.java', '.c', '.cpp', '.h',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.7z',
  '.mp3', '.mp4', '.wav', '.avi', '.mkv', '.webm',
  '.log', '.ini', '.cfg', '.conf', '.env.example',
]

const DANGEROUS_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.mst', '.dll', '.ocx', '.sys',
  '.scr', '.pif', '.com', '.cpl', '.inf', '.reg', '.hta',
  '.sh', '.bash', '.zsh', '.fish', '.run', '.bin', '.app',
  '.deb', '.rpm', '.dmg', '.pkg',
]

let _allowedBaseDirs: string[] | null = null

export function initAllowedDirs(dirs: string[]): void {
  _allowedBaseDirs = dirs
}

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

export function validatePath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { safe: false, resolved: '', reason: '路径为空' }
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

export function validateOpenPath(filePath: string): { safe: boolean; resolved: string; reason?: string } {
  const pathCheck = validatePath(filePath)
  if (!pathCheck.safe) return pathCheck

  if (hasSuspiciousBasename(pathCheck.resolved)) {
    return { safe: false, resolved: pathCheck.resolved, reason: `文件名以点/空格结尾或包含冒号，被安全策略拒绝: ${pathCheck.resolved}` }
  }

  const { ext } = getSafeExtension(pathCheck.resolved)
  if (ext && DANGEROUS_EXTENSIONS.includes(ext)) {
    return { safe: false, resolved: pathCheck.resolved, reason: `禁止打开可执行文件: ${ext}` }
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
