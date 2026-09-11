import { resolve, sep } from 'path'

const FORBIDDEN_READ_PATHS = [
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /\/\.aws\//i,
  /\/\.config\/chromium/i,
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /\\SAM$/i,
  /\\SYSTEM$/i,
  /\\SECURITY$/i,
  /\/private\/etc/i,
  /\\AppData\\Local\\Microsoft\\Credentials/i,
  /\\AppData\\Roaming\\Microsoft\\Credentials/i,
  /\/\.kube\/config/i,
  /\/\.docker\/config\.json/i,
  /\/\.npmrc$/i,
  /\/\.pypirc$/i,
  /\/\.netrc$/i,
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

export function validatePath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  const resolved = resolve(inputPath)
  const allowedDirs = getAllowedBaseDirs()

  const isAllowed = allowedDirs.some(dir => resolved.startsWith(dir + sep) || resolved === dir)
  if (!isAllowed) {
    return { safe: false, resolved, reason: `路径不在允许目录内: ${resolved}` }
  }

  for (const pattern of FORBIDDEN_READ_PATHS) {
    if (pattern.test(resolved)) {
      return { safe: false, resolved, reason: `路径包含敏感目录: ${resolved}` }
    }
  }

  return { safe: true, resolved }
}

export function validateReadPath(inputPath: string): { safe: boolean; resolved: string; reason?: string } {
  const result = validatePath(inputPath)
  if (!result.safe) return result

  for (const pattern of FORBIDDEN_READ_PATHS) {
    if (pattern.test(result.resolved)) {
      return { safe: false, resolved: result.resolved, reason: `禁止读取敏感路径: ${result.resolved}` }
    }
  }

  return result
}

export function validateOpenPath(filePath: string): { safe: boolean; resolved: string; reason?: string } {
  const pathCheck = validatePath(filePath)
  if (!pathCheck.safe) return pathCheck

  const ext = filePath.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
  if (DANGEROUS_EXTENSIONS.includes(ext)) {
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

export { FORBIDDEN_READ_PATHS, DANGEROUS_EXTENSIONS, SAFE_OPEN_EXTENSIONS }
