import { ipcMain, dialog, safeStorage, app, FileFilter, shell } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFile, createWriteStream, rmSync, renameSync } from 'fs'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import type { BrowserWindow } from 'electron'
import { hasMcpProcess, startMcpProcess, stopMcpProcess, getMcpEntry, sendMcpRequest, getAllMcpIds } from './mcp-manager'
import { isShellCommandAllowed, getTimeoutForCommand, HTTP_MAX_BODY_SIZE, HTTP_ALLOWED_METHODS, HTTP_TIMEOUT_TIER, HTTP_ABSOLUTE_CAP, isMcpCommandAllowed } from './shell-security'
import { validatePath, validateReadPath, validateOpenPath, validateWritePath, hasSuspiciousBasename, sanitizeKey } from './pathValidator'
import archiver from 'archiver'
import extract from 'extract-zip'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import * as jschardet from 'jschardet'
import * as iconv from 'iconv-lite'
// R16 修复：原为 CJS require('./vault')——electron-vite 打包不解析相对路径 CJS require，
// 运行时 out/main 仅有单文件 bundle 导致 MODULE_NOT_FOUND；改为静态 ESM import 由 rollup 打入
import { openVault, closeVault, vaultRead, vaultWrite, vaultDelete, vaultList, vaultReadVector, vaultWriteVector, vaultDeleteVector, vaultListVectors, vaultGetStats } from './vault'
import { migrateToVault, isMigrationComplete } from './vault-migration'

let mainWindow: BrowserWindow | null = null
let watchDir: string | null = null
let fsWatcher: ReturnType<typeof import('fs').watch> | null = null

const userDataDir = app.getPath('userData')
const storeDir = join(userDataDir, 'store')
const vectorDir = join(storeDir, 'vectors')
const backupDir = join(userDataDir, 'backups')
const knowledgeDir = join(userDataDir, 'knowledge')

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// P1-1 修复：恢复前对解压产物做条目校验（仅 store 数据、拒符号链接、限数量/大小）
function validateExtractedBackup(rootDir: string): { files: number } {
  const MAX_FILES = 5000
  const MAX_FILE_BYTES = 20 * 1024 * 1024
  const MAX_TOTAL_BYTES = 200 * 1024 * 1024
  let files = 0
  let total = 0
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`备份包含符号链接，拒绝恢复: ${entry.name}`)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile()) throw new Error(`备份包含非常规文件，拒绝恢复: ${entry.name}`)
      const ext = entry.name.toLowerCase().split('.').pop() || ''
      if (!['json', 'bin'].includes(ext)) throw new Error(`备份包含不支持的文件类型(.${ext})，拒绝恢复: ${entry.name}`)
      const size = statSync(full).size
      if (size > MAX_FILE_BYTES) throw new Error(`备份条目过大，拒绝恢复: ${entry.name}`)
      files++
      total += size
      if (files > MAX_FILES) throw new Error('备份条目数超过上限(5000)，拒绝恢复')
      if (total > MAX_TOTAL_BYTES) throw new Error('备份总量超过上限(200MB)，拒绝恢复')
    }
  }
  walk(rootDir)
  return { files }
}

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + chunkSize, text.length)
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('。', end)
      const lastNewline = text.lastIndexOf('\n', end)
      const breakPoint = Math.max(lastPeriod, lastNewline)
      if (breakPoint > i) end = breakPoint + 1
    }
    chunks.push(text.slice(i, end))
    i = end
  }
  return chunks.filter(c => c.trim().length > 0)
}

// P0-3 修复：SSRF 防护覆盖全部私网/保留地址段（IPv4 + IPv6 字面量）
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost') return true
  const version = isIP(host)
  if (version === 4) return isPrivateIPv4(host)
  if (version === 6) return isPrivateIPv6(host)
  return false
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && (b === 0 || b === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51) return true
  if (a === 203 && b === 0) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('100::')) return true
  if (lower.startsWith('2001:db8:')) return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])
  const nat64 = lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/)
  if (nat64) return isPrivateIPv4(nat64[1])
  return false
}

// P0-3 修复：非字面量域名必须 DNS 解析后逐地址判定，堵死 nip.io/localtest.me 等解析绕过
async function isHostAllowed(hostname: string): Promise<{ allowed: boolean; reason?: string }> {
  if (isPrivateHostname(hostname)) {
    return { allowed: false, reason: `不允许访问内网/保留地址: ${hostname}` }
  }
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return { allowed: true }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true })
    for (const { address } of addresses) {
      const v = isIP(address)
      const priv = v === 4 ? isPrivateIPv4(address) : v === 6 ? isPrivateIPv6(address) : true
      if (priv) {
        return { allowed: false, reason: `域名解析到内网/保留地址: ${hostname} -> ${address}` }
      }
    }
    return { allowed: true }
  } catch {
    return { allowed: false, reason: `域名解析失败: ${hostname}` }
  }
}

async function assertUrlAllowed(urlStr: string): Promise<{ ok: boolean; url?: URL; error?: string }> {
  try {
    const url = new URL(urlStr)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { ok: false, error: '仅支持 http/https 协议' }
    }
    const hostCheck = await isHostAllowed(url.hostname)
    if (!hostCheck.allowed) {
      return { ok: false, error: hostCheck.reason || `不允许访问内网地址: ${url.hostname}` }
    }
    return { ok: true, url }
  } catch {
    return { ok: false, error: `URL 格式无效: ${urlStr}` }
  }
}

export function setupIpc(win: BrowserWindow | null) {
  mainWindow = win

  ensureDir(storeDir)
  ensureDir(vectorDir)
  ensureDir(backupDir)
  ensureDir(knowledgeDir)

  ipcMain.on('window:minimize', () => { mainWindow?.minimize() })
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('window:close', () => { mainWindow?.close() })

  ipcMain.handle('dialog:openFile', async (_event, options?: {
    filters?: FileFilter[]
    title?: string
  }) => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters,
      title: options?.title || '选择文件'
    })
    return result
  })

  ipcMain.handle('dialog:openDirectory', async (_event, options?: {
    title?: string
  }) => {
    if (!mainWindow) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: options?.title || '选择文件夹'
    })
    return result
  })

  ipcMain.handle('app:getPlatform', () => process.platform)
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('safeStorage:encrypt', (_event, text: string) => {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(text).toString('base64')
  })

  ipcMain.handle('safeStorage:decrypt', (_event, encrypted: string) => {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const buffer = Buffer.from(encrypted, 'base64')
      return safeStorage.decryptString(buffer)
    } catch {
      return null
    }
  })

  ipcMain.handle('safeStorage:isAvailable', () => {
    return safeStorage.isEncryptionAvailable()
  })

  ipcMain.handle('vector:readBin', (_event, key: string) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return null
    try {
      const filePath = join(vectorDir, `${key}.bin`)
      if (!existsSync(filePath)) return null
      const buf = readFileSync(filePath)
      const copy = new Uint8Array(buf.byteLength)
      copy.set(buf)
      return copy
    } catch {
      return null
    }
  })

  ipcMain.handle('vector:writeBin', (_event, key: string, base64Data: string) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return false
    try {
      const filePath = join(vectorDir, `${key}.bin`)
      const buf = Buffer.from(base64Data, 'base64')
      writeFileSync(filePath, buf)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('vector:listKeys', () => {
    try {
      const files = readdirSync(vectorDir)
      return files.filter((f: string) => f.endsWith('.bin')).map((f: string) => f.replace(/\.bin$/, ''))
    } catch {
      return []
    }
  })

  ipcMain.handle('file:write', (_event, opts: { filePath: string; content: string; encoding?: BufferEncoding }) => {
    // P0-6 修复：写路径走 validateWritePath（敏感目标 + 扩展名黑名单 + 尾随点/空格），
    // 并施加内容大小上限
    const pathCheck = validateWritePath(opts.filePath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    const MAX_WRITE_SIZE = 10 * 1024 * 1024
    if ((opts.content || '').length > MAX_WRITE_SIZE) {
      return { success: false, error: `写入内容过大，上限 10MB` }
    }
    try {
      const dir = join(pathCheck.resolved, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(pathCheck.resolved, opts.content || '', opts.encoding || 'utf-8')
      return { success: true, path: pathCheck.resolved }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:createDirectory', (_event, dirPath: string) => {
    const pathCheck = validatePath(dirPath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    if (hasSuspiciousBasename(pathCheck.resolved)) {
      return { success: false, error: `目录名以点/空格结尾或包含冒号，被安全策略拒绝: ${pathCheck.resolved}` }
    }
    try {
      mkdirSync(pathCheck.resolved, { recursive: true })
      return { success: true, path: pathCheck.resolved }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:createDocx', async (_event, opts: { filePath: string; content?: string; title?: string }) => {
    const pathCheck = validateWritePath(opts.filePath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    try {
      const dir = join(pathCheck.resolved, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const children: InstanceType<typeof Paragraph>[] = []
      if (opts.title) {
        children.push(new Paragraph({ text: opts.title, heading: HeadingLevel.HEADING_1 }))
      }
      const content = opts.content || ''
      if (content) {
        for (const line of content.split('\n')) {
          children.push(new Paragraph({ children: [new TextRun(line)] }))
        }
      } else {
        children.push(new Paragraph({ children: [new TextRun('')] }))
      }
      const doc = new Document({ sections: [{ children }] })
      const buffer = await Packer.toBuffer(doc)
      writeFileSync(pathCheck.resolved, buffer)
      return { success: true, path: pathCheck.resolved }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:read', async (_event, filePath: string, maxBytes?: number) => {
    const pathCheck = validateReadPath(filePath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    const validatedPath = pathCheck.resolved
    const fileTimeout = 15000
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          resolve({ success: false, error: `文件读取超时(${fileTimeout}ms)` })
        }
      }, fileTimeout)

      try {
        if (!validatedPath || !existsSync(validatedPath)) {
          clearTimeout(timer)
          if (!settled) { settled = true; resolve({ success: false, error: '文件不存在' }) }
          return
        }
        const stat = statSync(validatedPath)
        const limit = maxBytes || 512000
        if (stat.size > limit * 2) {
          clearTimeout(timer)
          if (!settled) { settled = true; resolve({ success: false, error: `文件过大(${Math.round(stat.size/1024)}KB)，超限` }) }
          return
        }

        readFile(validatedPath, { encoding: null }, (err: Error | null, buf: Buffer) => {
          if (settled) return
          clearTimeout(timer)
          settled = true
          if (err) {
            resolve({ success: false, error: err.message })
            return
          }
          const truncated = buf.subarray(0, limit)
          const isBinary = truncated.some((b: number, i: number) => i < 8192 && (b === 0 || (b < 8 && b > 0)))
          if (isBinary) {
            resolve({ success: true, content: `[二进制文件: ${validatedPath}, 大小: ${stat.size}字节]`, size: stat.size, isBinary: true, encoding: 'binary' })
            return
          }
          let detectedEncoding = 'utf-8'
          let text: string
          try {
            const detected = jschardet.detect(truncated.subarray(0, 8192))
            if (detected && detected.encoding && detected.encoding.toLowerCase() !== 'utf-8' && detected.confidence > 0.7) {
              detectedEncoding = detected.encoding
              if (iconv.encodingExists(detectedEncoding)) {
                text = iconv.decode(truncated, detectedEncoding)
              } else {
                text = truncated.toString('utf-8')
                detectedEncoding = 'utf-8(fallback)'
              }
            } else {
              text = truncated.toString('utf-8')
            }
          } catch {
            text = truncated.toString('utf-8')
          }
          resolve({ success: true, content: text, size: stat.size, isBinary: false, encoding: detectedEncoding })
        })
      } catch (e: unknown) {
        clearTimeout(timer)
        if (!settled) { settled = true; resolve({ success: false, error: e instanceof Error ? e.message : String(e) }) }
      }
    })
  })

  ipcMain.handle('store:read', (_event, key: string) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return null
    try {
      const filePath = join(storeDir, `${key}.json`)
      if (!existsSync(filePath)) return null
      const data = readFileSync(filePath, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  })

  ipcMain.handle('store:write', (_event, key: string, value: unknown) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return false
    try {
      const filePath = join(storeDir, `${key}.json`)
      writeFileSync(filePath, JSON.stringify(value), 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('store:delete', (_event, key: string) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return false
    try {
      const filePath = join(storeDir, `${key}.json`)
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('mcp:spawn', async (_event, opts: { id: string; command: string; args: string[]; env: Record<string, string> }) => {
    const cmdCheck = isMcpCommandAllowed(opts.command, opts.args)
    if (!cmdCheck.allowed) {
      return { success: false, error: cmdCheck.reason || 'MCP命令被安全策略拒绝' }
    }
    if (hasMcpProcess(opts.id)) {
      stopMcpProcess(opts.id)
    }

    const result = startMcpProcess(opts.id, opts.command, opts.args, opts.env, mainWindow)
    if (!result.success) return { success: false, error: result.error }

    const entry = getMcpEntry(opts.id)
    if (!entry) return { success: false, error: 'MCP entry not found after start' }

    await new Promise(resolve => setTimeout(resolve, 500))

    if (entry.status === 'stopped' || entry.status === 'error') {
      const stderrTail = entry.stderrBuffer.slice(-500)
      return { success: false, error: `Process exited immediately. ${stderrTail || 'No stderr output.'}` }
    }

    try {
      const initResult = await sendMcpRequest(entry, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'HoloStarmap', version: '0.1.0' }
      }, 60000)

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:status', { id: opts.id, status: 'running', initResult })
      }

      try {
        if (entry.process.stdin) {
          entry.process.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          }) + '\n')
        }
      } catch { /* ignore notification write error */ }

      await new Promise(resolve => setTimeout(resolve, 500))

      try {
        const toolsResult = await sendMcpRequest(entry, 'tools/list', {}, 15000) as { tools?: Record<string, unknown>[] }
        const tools = (toolsResult?.tools || []).map((t: Record<string, unknown>) => ({
          name: (t.name || '') as string,
          description: (t.description || '') as string,
          inputSchema: (t.inputSchema || {}) as Record<string, unknown>
        }))
        entry.tools = tools
        entry.status = 'running'
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mcp:tools', { id: opts.id, tools })
        }
      } catch (toolsErr) {
        const toolsMessage = toolsErr instanceof Error ? toolsErr.message : String(toolsErr)
        console.error(`[MCP ${opts.id} tools/list failed]`, toolsMessage)
        entry.tools = []
        entry.status = 'running'
      }

      return { success: true, tools: entry.tools }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[MCP ${opts.id} initialize failed]`, message)
      stopMcpProcess(opts.id)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:status', { id: opts.id, status: 'error', error: message })
      }
      return { success: false, error: `MCP initialize failed: ${message}` }
    }
  })

  ipcMain.handle('mcp:callTool', async (_event, opts: { id: string; toolName: string; args: Record<string, unknown> }) => {
    const entry = getMcpEntry(opts.id)
    if (!entry) return { success: false, error: 'MCP process not found' }
    if (entry.status !== 'running') return { success: false, error: `MCP process status: ${entry.status}` }

    try {
      const result = await sendMcpRequest(entry, 'tools/call', {
        name: opts.toolName,
        arguments: opts.args
      }, 30000)
      return { success: true, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('mcp:listTools', async (_event, opts: { id: string }) => {
    const entry = getMcpEntry(opts.id)
    if (!entry) return { success: false, error: 'MCP process not found' }

    try {
      const result = await sendMcpRequest(entry, 'tools/list', {}, 8000) as { tools?: Record<string, unknown>[] }
      const tools = (result?.tools || []).map((t: Record<string, unknown>) => ({
        name: (t.name || '') as string,
        description: (t.description || '') as string,
        inputSchema: (t.inputSchema || {}) as Record<string, unknown>
      }))
      entry.tools = tools
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp:tools', { id: opts.id, tools })
      }
      return { success: true, tools }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('mcp:stop', async (_event, opts: { id: string }) => {
    return stopMcpProcess(opts.id)
  })

  ipcMain.handle('mcp:getStatus', async (_event, opts: { id: string }) => {
    const entry = getMcpEntry(opts.id)
    if (!entry) return { status: 'stopped' }
    return { status: entry.status, tools: entry.tools }
  })

  ipcMain.handle('shell:exec', async (_event, opts: { command: string; cwd?: string; timeout?: number; env?: Record<string, string> }) => {
    // P1-7 修复：cwd 必须通过路径校验且真实存在
    let cwd = app.getPath('home')
    if (opts.cwd) {
      const cwdCheck = validatePath(opts.cwd)
      if (!cwdCheck.safe) {
        return { success: false, code: -1, stdout: '', stderr: `工作目录被安全策略拒绝: ${cwdCheck.reason}` }
      }
      if (!existsSync(cwdCheck.resolved) || !statSync(cwdCheck.resolved).isDirectory()) {
        return { success: false, code: -1, stdout: '', stderr: `工作目录不存在: ${cwdCheck.resolved}` }
      }
      cwd = cwdCheck.resolved
    }

    const check = isShellCommandAllowed(opts.command, opts.cwd ? cwd : undefined)
    if (!check.allowed) {
      return { success: false, code: -1, stdout: '', stderr: check.reason || '命令被安全策略拒绝' }
    }

    return new Promise((resolve) => {
      const tierTimeout = getTimeoutForCommand(opts.command, opts.timeout)
      let stdout = ''
      let stderr = ''
      let settled = false
      let tierTimer: ReturnType<typeof setTimeout> | undefined
      let capTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const extraNodePath = join(process.resourcesPath, 'node_modules')
        // NODE_PATH 强制为主进程指定值，防止渲染层 env 覆盖后 node -e 加载恶意模块
        const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), NODE_PATH: extraNodePath, ...(opts.env || {}) }
        childEnv.NODE_PATH = extraNodePath
        const child = spawn(opts.command, [], {
          cwd,
          shell: true,
          env: childEnv
        })
        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
        child.on('close', (code: number | null) => {
          if (!settled) {
            settled = true
            if (tierTimer) clearTimeout(tierTimer)
            if (capTimer) clearTimeout(capTimer)
            resolve({ success: code === 0, code: code ?? -1, stdout, stderr })
          }
        })
        child.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            if (tierTimer) clearTimeout(tierTimer)
            if (capTimer) clearTimeout(capTimer)
            resolve({ success: false, code: -1, stdout, stderr: err.message })
          }
        })
        tierTimer = setTimeout(() => {
          if (!settled) {
            settled = true
            try { child.kill('SIGTERM') } catch { /* already exited */ }
            setTimeout(() => {
              try { child.kill('SIGKILL') } catch { /* ignore */ }
            }, 3000)
            resolve({ success: false, code: -1, stdout, stderr: `命令超时(${tierTimeout}ms)，已发送终止信号` })
          }
        }, tierTimeout)
        capTimer = setTimeout(() => {
          if (!settled) {
            settled = true
            try { child.kill('SIGKILL') } catch { /* ignore */ }
            resolve({ success: false, code: -1, stdout, stderr: `绝对超时(${180000}ms)，强制终止` })
          }
        }, 180000)
      } catch (e: unknown) {
        if (!settled) resolve({ success: false, code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) })
      }
    })
  })

  ipcMain.handle('http:fetch', async (_event, opts: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number }) => {
    const method = (opts.method || 'GET').toUpperCase()
    if (!HTTP_ALLOWED_METHODS.includes(method)) {
      return { success: false, status: 0, error: `方法不允许: ${method}，仅支持 ${HTTP_ALLOWED_METHODS.join('/')}` }
    }
    if (opts.body && opts.body.length > HTTP_MAX_BODY_SIZE) {
      return { success: false, status: 0, error: `请求体过大，上限 1MB` }
    }
    const tierTimeout = Math.min(opts.timeout || HTTP_TIMEOUT_TIER[method] || 30000, HTTP_ABSOLUTE_CAP)
    const MAX_REDIRECTS = 3
    try {
      let currentUrl = opts.url
      let currentMethod = method
      let currentBody = opts.body
      let resp: Response | null = null

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // P0-3 修复：每一跳都重新做协议 + DNS 解析 + 私网判定，堵死 302 重定向绕过
        const urlCheck = await assertUrlAllowed(currentUrl)
        if (!urlCheck.ok) {
          return { success: false, status: 0, error: urlCheck.error || 'URL 校验失败' }
        }
        const controller = new AbortController()
        const tierTimer = setTimeout(() => controller.abort(), tierTimeout)
        const capTimer = setTimeout(() => controller.abort(), HTTP_ABSOLUTE_CAP)
        try {
          const fetchOpts: Record<string, unknown> = { method: currentMethod, signal: controller.signal, redirect: 'manual' }
          if (opts.headers) fetchOpts.headers = opts.headers
          if (currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD') fetchOpts.body = currentBody
          resp = await fetch(currentUrl, fetchOpts)
        } finally {
          clearTimeout(tierTimer)
          clearTimeout(capTimer)
        }

        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const location = resp.headers.get('location')
          if (!location) break
          if (hop === MAX_REDIRECTS) {
            return { success: false, status: 0, error: `重定向次数超过上限(${MAX_REDIRECTS})` }
          }
          currentUrl = new URL(location, currentUrl).toString()
          if ([301, 302, 303].includes(resp.status)) {
            currentMethod = 'GET'
            currentBody = undefined
          }
          continue
        }
        break
      }

      if (!resp) {
        return { success: false, status: 0, error: '请求未产生响应' }
      }
      const text = await resp.text()
      return { success: true, status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text.substring(0, 512000) }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('abort') || msg.includes('AbortError')) {
        return { success: false, status: 0, error: `HTTP请求超时(${tierTimeout}ms)` }
      }
      return { success: false, status: 0, error: msg }
    }
  })

  ipcMain.handle('backup:create', async () => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const output = createWriteStream(join(backupDir, `holo-backup-${ts}.zip`))
      const archive = archiver('zip', { zlib: { level: 6 } })
      archive.pipe(output)
      archive.directory(storeDir, 'store')
      archive.finalize()
      await new Promise<void>((resolve, reject) => { output.on('close', resolve); output.on('error', reject) })
      return { success: true, path: join(backupDir, `holo-backup-${ts}.zip`) }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('backup:restore', async () => {
    // P1-1 修复：解压到临时目录 → 条目校验 → 快照现网 → 原子交换，失败可回滚
    if (!mainWindow) return { success: false, error: 'No window' }
    let tmpDir = ''
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: '备份文件', extensions: ['zip'] }],
        title: '选择备份文件恢复'
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: '取消选择' }

      tmpDir = join(userDataDir, `restore-tmp-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      await extract(result.filePaths[0], { dir: tmpDir })

      const extractedStore = join(tmpDir, 'store')
      if (!existsSync(extractedStore)) {
        throw new Error('备份内不含 store 目录，不是有效的 HoloStarmap 备份')
      }
      const validated = validateExtractedBackup(extractedStore)

      const snapshotDir = join(userDataDir, `store-pre-restore-${Date.now()}`)
      renameSync(storeDir, snapshotDir)
      try {
        renameSync(extractedStore, storeDir)
      } catch (e: unknown) {
        renameSync(snapshotDir, storeDir)
        throw e
      }
      return { success: true, message: `备份已恢复（${validated.files} 个文件）。恢复前数据已快照至 ${snapshotDir}，请重启应用生效` }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  })

  ipcMain.handle('backup:list', async () => {
    try {
      const files = readdirSync(backupDir).filter((f: string) => f.endsWith('.zip'))
      return files.map((f: string) => ({
        name: f,
        path: join(backupDir, f),
        size: statSync(join(backupDir, f)).size,
        createdAt: statSync(join(backupDir, f)).mtimeMs
      })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
    } catch {
      return []
    }
  })

  ipcMain.handle('watchfs:setDir', async (_event, dirPath: string | null) => {
    if (fsWatcher) { fsWatcher.close(); fsWatcher = null }
    watchDir = null
    if (!dirPath) return { success: true }
    const pathCheck = validatePath(dirPath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    if (!existsSync(pathCheck.resolved)) return { success: true }
    try {
      const fs = await import('fs')
      fsWatcher = fs.watch(pathCheck.resolved, { recursive: true }, (eventType: string, filename: string | Buffer | null) => {
        if (!filename || typeof filename !== 'string') return
        const ext = filename.split('.').pop()?.toLowerCase()
        if (!ext || !['md', 'txt', 'json', 'csv', 'pdf', 'docx'].includes(ext)) return
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('watchfs:changed', { event: eventType, filename, path: join(pathCheck.resolved, filename) })
        }
      })
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('watchfs:getDir', () => watchDir)

  ipcMain.handle('app:health', () => {
    return { status: 'ok', timestamp: Date.now() }
  })

  ipcMain.handle('llm:chatCompletion', async (_event, opts: {
    providerId: string
    model: string
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    maxTokens?: number
  }) => {
    const { providerId, model, messages, tools, maxTokens } = opts
    if (!providerId || !model || !messages) {
      return { success: false, error: 'Missing providerId, model, or messages' }
    }
    try {
      const configPath = join(storeDir, 'api-config.json')
      if (!existsSync(configPath)) {
        return { success: false, error: 'No API configuration found' }
      }
      const raw = readFileSync(configPath, 'utf-8')
      const stored = JSON.parse(raw) as {
        baseUrl?: string
        providers?: Array<{
          id: string; name: string; baseUrl: string; authType: string; apiKey: string
          modelsEndpoint?: string; chatFormat?: string; models?: Array<{ id: string; name: string }>
          isReachable?: boolean; lastCheckedAt?: number
        }>
      }
      const provider = (stored.providers || []).find(p => p.id === providerId)
      if (!provider) {
        return { success: false, error: `Provider '${providerId}' not found` }
      }
      let apiKey = provider.apiKey || ''
      if (apiKey.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(apiKey.substring(4), 'base64')
          apiKey = safeStorage.decryptString(buffer)
        } catch {
          return { success: false, error: 'Failed to decrypt API key' }
        }
      }
      const baseUrl = (provider.baseUrl || stored.baseUrl || '').replace(/\/+$/, '')
      if (!baseUrl) {
        return { success: false, error: 'No base URL configured for provider' }
      }
      try {
        const baseUrlObj = new URL(baseUrl)
        const hostCheck = await isHostAllowed(baseUrlObj.hostname)
        if (!hostCheck.allowed) {
          return { success: false, error: `LLM API不允许访问内网地址: ${baseUrlObj.hostname}（${hostCheck.reason || ''}）` }
        }
      } catch {
        return { success: false, error: 'LLM API base URL格式无效' }
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (provider.authType === 'bearer' && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      } else if (provider.authType === 'api-key' && apiKey) {
        headers['x-api-key'] = apiKey
      }
      const chatFormat = provider.chatFormat || 'openai'
      let body: Record<string, unknown>
      let endpoint = '/v1/chat/completions'
      if (chatFormat === 'anthropic') {
        endpoint = '/v1/messages'
        body = {
          model,
          messages: messages.filter(m => m.role !== 'system'),
          system: messages.find(m => m.role === 'system')?.content,
          max_tokens: maxTokens || 4096
        }
      } else {
        body = {
          model,
          messages,
          stream: false,
          max_tokens: maxTokens || 16384
        }
        if (tools && tools.length > 0) {
          body.tools = tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
          }))
        }
      }
      const maxTok = maxTokens || 16384
      const tierTimeout = maxTok <= 512 ? 15000 : maxTok <= 4096 ? 45000 : maxTok <= 8192 ? 75000 : 120000
      const absoluteCap = 180000
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(tierTimeout, absoluteCap))
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        return { success: false, error: `API error ${resp.status}: ${errBody.slice(0, 200)}` }
      }
      const data = await resp.json() as Record<string, unknown>
      if (chatFormat === 'anthropic') {
        const contentArr = data.content as Array<Record<string, unknown>> | undefined
        const text = contentArr?.[0]?.text
        const usageData = data.usage as Record<string, number> | undefined
        return {
          success: true,
          content: text ? String(text) : '',
          toolCalls: [],
          usage: {
            promptTokens: usageData?.input_tokens || 0,
            completionTokens: usageData?.output_tokens || 0,
            totalTokens: (usageData?.input_tokens || 0) + (usageData?.output_tokens || 0)
          },
          chatFormat: 'anthropic'
        }
      }
      const choices = data.choices as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      const message = choice?.message as Record<string, unknown> | undefined
      const content = (message?.content as string) || ''
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
      if (Array.isArray(message?.tool_calls)) {
        for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown> | undefined
          toolCalls.push({
            id: String(tc.id || ''),
            name: String(fn?.name || ''),
            arguments: String(fn?.arguments || '{}')
          })
        }
      }
      const usage = data.usage as Record<string, number> | undefined
      return {
        success: true,
        content,
        toolCalls,
        usage: {
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
          cacheHitTokens: usage?.prompt_cache_hit_tokens || 0,
          cacheMissTokens: usage?.prompt_cache_miss_tokens || 0
        },
        chatFormat: 'openai'
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle('llm:listModels', async (_event, opts: { providerId: string }) => {
    if (!opts.providerId) {
      return { success: false, error: 'Missing providerId' }
    }
    try {
      const configPath = join(storeDir, 'api-config.json')
      if (!existsSync(configPath)) {
        return { success: false, error: 'No API configuration found' }
      }
      const raw = readFileSync(configPath, 'utf-8')
      const stored = JSON.parse(raw) as {
        baseUrl?: string
        providers?: Array<{
          id: string; name: string; baseUrl: string; authType: string; apiKey: string
          modelsEndpoint?: string; chatFormat?: string; models?: Array<{ id: string; name: string }>
          isReachable?: boolean; lastCheckedAt?: number
        }>
      }
      const provider = (stored.providers || []).find(p => p.id === opts.providerId)
      if (!provider) {
        return { success: false, error: `Provider '${opts.providerId}' not found` }
      }
      let apiKey = provider.apiKey || ''
      if (apiKey.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(apiKey.substring(4), 'base64')
          apiKey = safeStorage.decryptString(buffer)
        } catch {
          return { success: false, error: 'Failed to decrypt API key' }
        }
      }
      const baseUrl = provider.baseUrl.replace(/\/+$/, '')
      try {
        const baseUrlObj = new URL(baseUrl)
        const hostCheck = await isHostAllowed(baseUrlObj.hostname)
        if (!hostCheck.allowed) {
          return { success: false, error: `LLM API不允许访问内网地址: ${baseUrlObj.hostname}（${hostCheck.reason || ''}）` }
        }
      } catch {
        return { success: false, error: 'LLM API base URL格式无效' }
      }
      const endpoint = provider.modelsEndpoint || '/v1/models'
      const headers: Record<string, string> = {}
      if (provider.authType === 'bearer' && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      } else if (provider.authType === 'api-key' && apiKey) {
        headers['x-api-key'] = apiKey
      }
      const resp = await fetch(`${baseUrl}${endpoint}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      })
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '')
        return { success: false, error: `API error ${resp.status}: ${errBody.slice(0, 200)}` }
      }
      const data = await resp.json() as { data?: Array<{ id: string }> }
      const models = (data.data || []).map(m => ({ id: m.id, name: m.id, providerId: opts.providerId }))
      return { success: true, models }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { success: false, error: message }
    }
  })

  ipcMain.handle('knowledge:ingest', async (_event, opts: { filename: string; content: string; fileType?: string }) => {
    const { filename, content, fileType } = opts
    if (!filename || !content) {
      return { success: false, error: 'Missing filename or content' }
    }
    const MAX_CONTENT_SIZE = 10 * 1024 * 1024
    if (content.length > MAX_CONTENT_SIZE) {
      return { success: false, error: `内容过大(${Math.round(content.length / 1024)}KB)，上限10MB` }
    }
    try {
      const id = `kb-${Date.now()}`
      const entryPath = join(knowledgeDir, `${id}.json`)
      const chunks = chunkText(content, 512)
      const entry = {
        id,
        filename,
        fileType: fileType || 'unknown',
        chunks: chunks.length,
        createdAt: Date.now()
      }
      writeFileSync(entryPath, JSON.stringify({ entry, chunks }, null, 2))
      return { success: true, entry }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('knowledge:search', async (_event, opts: { query: string; topK?: number }) => {
    const query = (opts.query || '').toLowerCase()
    const topK = Math.min(opts.topK || 5, 100)
    if (!query) {
      return { success: false, error: 'Missing query' }
    }
    try {
      const queryWords = query.split(/\s+/)
      const results: { text: string; score: number }[] = []
      const files = readdirSync(knowledgeDir).filter((f: string) => f.endsWith('.json'))
      for (const file of files) {
        try {
          const raw = readFileSync(join(knowledgeDir, file), 'utf-8')
          const data = JSON.parse(raw)
          for (const chunk of data.chunks || []) {
            const lower = chunk.toLowerCase()
            let score = 0
            for (const word of queryWords) {
              if (lower.includes(word)) score += 1
            }
            if (score > 0) results.push({ text: chunk, score })
          }
        } catch { /* skip */ }
      }
      results.sort((a, b) => b.score - a.score)
      return { success: true, results: results.slice(0, topK) }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('knowledge:listEntries', async () => {
    try {
      const entries: Record<string, unknown>[] = []
      const files = readdirSync(knowledgeDir).filter((f: string) => f.endsWith('.json'))
      for (const file of files) {
        try {
          const raw = readFileSync(join(knowledgeDir, file), 'utf-8')
          const data = JSON.parse(raw)
          entries.push(data.entry)
        } catch { /* skip */ }
      }
      return { success: true, entries }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('env:resolvePath', (_event, template: string) => {
    const resolved = template
      .replace('%USERPROFILE%', app.getPath('home'))
      .replace('%HOME%', app.getPath('home'))
    const pathCheck = validatePath(resolved)
    if (!pathCheck.safe) return ''
    return pathCheck.resolved
  })

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    const pathCheck = validateOpenPath(filePath)
    if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
    try {
      const result = await shell.openPath(pathCheck.resolved)
      if (result && result !== '') {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('data:exportZip', async (_event, opts: { data: string; defaultName: string }) => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出数据',
        defaultPath: opts.defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (canceled || !filePath) return { success: false, error: 'Cancelled' }
      writeFileSync(filePath, opts.data, 'utf-8')
      return { success: true, filePath }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('data:importZip', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return { success: false, error: 'Cancelled' }
      const content = readFileSync(filePaths[0], 'utf-8')
      return { success: true, content, filePath: filePaths[0] }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('app:getUserDataPath', () => {
    return app.getPath('userData')
  })

  openVault()

  ipcMain.handle('vault:read', (_event, namespace: string, key: string) => {
    return vaultRead(namespace, key)
  })

  ipcMain.handle('vault:write', (_event, namespace: string, key: string, value: string, encrypted?: boolean) => {
    vaultWrite(namespace, key, value, encrypted)
  })

  ipcMain.handle('vault:delete', (_event, namespace: string, key: string) => {
    vaultDelete(namespace, key)
  })

  ipcMain.handle('vault:list', (_event, namespace?: string) => {
    return vaultList(namespace)
  })

  ipcMain.handle('vault:readVector', (_event, namespace: string, key: string) => {
    const result = vaultReadVector(namespace, key)
    if (!result) return null
    return {
      metadata: result.metadata,
      embedding: result.embedding.toString('base64'),
    }
  })

  ipcMain.handle('vault:writeVector', (_event, namespace: string, key: string, metadata: string, embeddingBase64: string) => {
    const buf = Buffer.from(embeddingBase64, 'base64')
    vaultWriteVector(namespace, key, metadata, buf)
    return true
  })

  ipcMain.handle('vault:deleteVector', (_event, namespace: string, key: string) => {
    vaultDeleteVector(namespace, key)
  })

  ipcMain.handle('vault:listVectors', (_event, namespace?: string) => {
    return vaultListVectors(namespace)
  })

  ipcMain.handle('vault:migrate', async (_event, localStorageData: Record<string, string>) => {
    return migrateToVault(localStorageData, storeDir, vectorDir)
  })

  ipcMain.handle('vault:getStats', () => {
    return vaultGetStats()
  })
}

export function cleanupMcpProcesses() {
  for (const id of getAllMcpIds()) {
    stopMcpProcess(id)
  }
}

const activeStreamControllers = new Map<string, AbortController>()

ipcMain.on('llm:stream:start', async (event, opts: {
  streamId: string
  providerId: string
  model: string
  messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
}) => {
  const { streamId, providerId, model, messages, tools, maxTokens } = opts
  const abortCtrl = new AbortController()
  activeStreamControllers.set(streamId, abortCtrl)

  const chunkChannel = `llm:stream:chunk:${streamId}`
  const endChannel = `llm:stream:end:${streamId}`
  const errorChannel = `llm:stream:error:${streamId}`

  try {
    if (!providerId || !model || !messages) {
      event.sender.send(errorChannel, 'Missing providerId, model, or messages')
      activeStreamControllers.delete(streamId)
      return
    }
    const configPath = join(storeDir, 'api-config.json')
    if (!existsSync(configPath)) {
      event.sender.send(errorChannel, 'No API configuration found')
      activeStreamControllers.delete(streamId)
      return
    }
    const raw = readFileSync(configPath, 'utf-8')
    const stored = JSON.parse(raw) as {
      baseUrl?: string
      providers?: Array<{
        id: string; name: string; baseUrl: string; authType: string; apiKey: string
        modelsEndpoint?: string; chatFormat?: string; models?: Array<{ id: string; name: string }>
      }>
    }
    const provider = (stored.providers || []).find(p => p.id === providerId)
    if (!provider) {
      event.sender.send(errorChannel, `Provider '${providerId}' not found`)
      activeStreamControllers.delete(streamId)
      return
    }
    let apiKey = provider.apiKey || ''
    if (apiKey.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
      try {
        const buffer = Buffer.from(apiKey.substring(4), 'base64')
        apiKey = safeStorage.decryptString(buffer)
      } catch {
        event.sender.send(errorChannel, 'Failed to decrypt API key')
        activeStreamControllers.delete(streamId)
        return
      }
    }
    const baseUrl = (provider.baseUrl || stored.baseUrl || '').replace(/\/+$/, '')
    if (!baseUrl) {
      event.sender.send(errorChannel, 'No base URL configured')
      activeStreamControllers.delete(streamId)
      return
    }
    try {
      const baseUrlObj = new URL(baseUrl)
      const hostCheck = await isHostAllowed(baseUrlObj.hostname)
      if (!hostCheck.allowed) {
        event.sender.send(errorChannel, `LLM API不允许访问内网地址: ${baseUrlObj.hostname}（${hostCheck.reason || ''}）`)
        activeStreamControllers.delete(streamId)
        return
      }
    } catch {
      event.sender.send(errorChannel, 'LLM API base URL格式无效')
      activeStreamControllers.delete(streamId)
      return
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (provider.authType === 'bearer' && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else if (provider.authType === 'api-key' && apiKey) {
      headers['x-api-key'] = apiKey
    }

    const chatFormat = provider.chatFormat || 'openai'
    let body: Record<string, unknown>
    let endpoint = '/v1/chat/completions'
    if (chatFormat === 'anthropic') {
      endpoint = '/v1/messages'
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        max_tokens: maxTokens || 4096,
        stream: true
      }
    } else {
      body = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens || 16384
      }
      if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      }
    }

    const maxTok = maxTokens || 16384
    const tierTimeout = maxTok <= 512 ? 15000 : maxTok <= 4096 ? 45000 : maxTok <= 8192 ? 75000 : 120000
    const absoluteCap = 180000
    const fetchSignal = AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(Math.min(tierTimeout, absoluteCap))])

    const resp = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal
    })
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      event.sender.send(errorChannel, `API error ${resp.status}: ${errBody.slice(0, 200)}`)
      activeStreamControllers.delete(streamId)
      return
    }
    if (!resp.body) {
      event.sender.send(errorChannel, 'Response body is null')
      activeStreamControllers.delete(streamId)
      return
    }

    let accumulatedContent = ''
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
    let promptTokens = 0
    let completionTokens = 0

    const reader = (resp.body as unknown as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      if (abortCtrl.signal.aborted) { reader.cancel(); break }
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const lines = (buffer + chunk).split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ') && !line.startsWith('event: ')) continue
        if (line.startsWith('data: ')) {
          const d = line.slice(6)
          if (chatFormat === 'openai') {
            if (d.trim() === '[DONE]') {
              const toolCalls = Array.from(toolCallMap.values())
              event.sender.send(endChannel, { content: accumulatedContent, toolCalls, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens: 0, cacheMissTokens: 0 } })
              activeStreamControllers.delete(streamId)
              return
            }
            try {
              const p = JSON.parse(d)
              if (p.choices?.[0]?.delta?.content) {
                accumulatedContent += p.choices[0].delta.content
                event.sender.send(chunkChannel, { content: accumulatedContent, delta: p.choices[0].delta.content, toolCalls: undefined, usage: undefined, done: false })
              }
              if (p.choices?.[0]?.delta?.tool_calls) {
                for (const tc of p.choices[0].delta.tool_calls) {
                  const idx = tc.index ?? 0
                  const existing = toolCallMap.get(idx)
                  if (existing) {
                    if (tc.id) existing.id = tc.id
                    if (tc.function?.name) existing.name = tc.function.name
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments
                  } else {
                    toolCallMap.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '' })
                  }
                }
              }
              if (p.usage) {
                promptTokens = p.usage.prompt_tokens || promptTokens
                completionTokens = p.usage.completion_tokens || completionTokens
              }
            } catch { /* skip */ }
          } else {
            try {
              const p = JSON.parse(d)
              if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta?.text) {
                accumulatedContent += p.delta.text
                event.sender.send(chunkChannel, { content: accumulatedContent, delta: p.delta.text, toolCalls: undefined, usage: undefined, done: false })
              }
              if (p.type === 'content_block_start' && p.content_block?.type === 'tool_use') {
                toolCallMap.set(p.content_block.index ?? 0, { id: p.content_block.id, name: p.content_block.name, arguments: '' })
              }
              if (p.type === 'content_block_delta' && p.delta?.type === 'input_json_delta' && p.delta?.partial_json) {
                const idx = p.index ?? 0
                const existing = toolCallMap.get(idx)
                if (existing) existing.arguments += p.delta.partial_json
              }
              if (p.type === 'message_start' && p.message?.usage) {
                promptTokens = p.message.usage.input_tokens || 0
              }
              if (p.type === 'message_delta' && p.usage) {
                completionTokens = p.usage.output_tokens || 0
              }
              if (p.type === 'message_stop') {
                const toolCalls = Array.from(toolCallMap.values())
                event.sender.send(endChannel, { content: accumulatedContent, toolCalls, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens: 0, cacheMissTokens: 0 } })
                activeStreamControllers.delete(streamId)
                return
              }
            } catch { /* skip */ }
          }
        }
      }
    }

    if (!abortCtrl.signal.aborted) {
      const toolCalls = Array.from(toolCallMap.values())
      event.sender.send(endChannel, { content: accumulatedContent, toolCalls, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens: 0, cacheMissTokens: 0 } })
    }
    activeStreamControllers.delete(streamId)
  } catch (err) {
    if (!abortCtrl.signal.aborted) {
      event.sender.send(errorChannel, err instanceof Error ? err.message : String(err))
    }
    activeStreamControllers.delete(streamId)
  }
})

ipcMain.on('llm:stream:cancel', (_event, opts: { streamId: string }) => {
  const ctrl = activeStreamControllers.get(opts.streamId)
  if (ctrl) {
    ctrl.abort()
    activeStreamControllers.delete(opts.streamId)
  }
})
