import { ipcMain, dialog, safeStorage, app, FileFilter, shell } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFile, createWriteStream } from 'fs'
import type { BrowserWindow } from 'electron'
import { hasMcpProcess, startMcpProcess, stopMcpProcess, getMcpEntry, sendMcpRequest, getAllMcpIds } from './mcp-manager'
import { isShellCommandAllowed, getTimeoutForCommand, HTTP_MAX_BODY_SIZE, HTTP_ALLOWED_METHODS, HTTP_TIMEOUT_TIER, HTTP_ABSOLUTE_CAP } from './shell-security'
import archiver from 'archiver'
import extract from 'extract-zip'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import * as jschardet from 'jschardet'
import * as iconv from 'iconv-lite'

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

function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true
  if (hostname.startsWith('192.168.') || hostname.startsWith('10.')) return true
  if (hostname.startsWith('172.')) {
    const parts = hostname.split('.')
    const second = parseInt(parts[1], 10)
    if (second >= 16 && second <= 31) return true
  }
  return false
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
    try {
      const dir = join(opts.filePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(opts.filePath, opts.content || '', opts.encoding || 'utf-8')
      return { success: true, path: opts.filePath }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:createDirectory', (_event, dirPath: string) => {
    try {
      mkdirSync(dirPath, { recursive: true })
      return { success: true, path: dirPath }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:createDocx', async (_event, opts: { filePath: string; content?: string; title?: string }) => {
    try {
      const dir = join(opts.filePath, '..')
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
      writeFileSync(opts.filePath, buffer)
      return { success: true, path: opts.filePath }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('file:read', async (_event, filePath: string, maxBytes?: number) => {
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
        if (!filePath || !existsSync(filePath)) {
          clearTimeout(timer)
          if (!settled) { settled = true; resolve({ success: false, error: '文件不存在' }) }
          return
        }
        const stat = statSync(filePath)
        const limit = maxBytes || 512000
        if (stat.size > limit * 2) {
          clearTimeout(timer)
          if (!settled) { settled = true; resolve({ success: false, error: `文件过大(${Math.round(stat.size/1024)}KB)，超限` }) }
          return
        }

        readFile(filePath, { encoding: null }, (err: Error | null, buf: Buffer) => {
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
            resolve({ success: true, content: `[二进制文件: ${filePath}, 大小: ${stat.size}字节]`, size: stat.size, isBinary: true, encoding: 'binary' })
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
    try {
      const filePath = join(storeDir, `${key}.json`)
      writeFileSync(filePath, JSON.stringify(value), 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('store:delete', (_event, key: string) => {
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
    const check = isShellCommandAllowed(opts.command)
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
        const child = spawn(opts.command, [], {
          cwd: opts.cwd || app.getPath('home'),
          shell: true,
          env: { ...(process.env as Record<string, string>), NODE_PATH: extraNodePath, ...(opts.env || {}) }
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
    try {
      const url = new URL(opts.url)
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { success: false, status: 0, error: `仅支持 http/https 协议` }
      }
      if (isPrivateHostname(url.hostname)) {
        return { success: false, status: 0, error: `不允许访问内网地址: ${url.hostname}` }
      }
    } catch {
      return { success: false, status: 0, error: `URL 格式无效: ${opts.url}` }
    }
    if (opts.body && opts.body.length > HTTP_MAX_BODY_SIZE) {
      return { success: false, status: 0, error: `请求体过大，上限 1MB` }
    }
    const tierTimeout = Math.min(opts.timeout || HTTP_TIMEOUT_TIER[method] || 30000, HTTP_ABSOLUTE_CAP)
    try {
      const controller = new AbortController()
      const tierTimer = setTimeout(() => controller.abort(), tierTimeout)
      let capAborted = false
      const capTimer = setTimeout(() => { capAborted = true; controller.abort() }, HTTP_ABSOLUTE_CAP)
      const fetchOpts: Record<string, unknown> = { method, signal: controller.signal }
      if (opts.headers) fetchOpts.headers = opts.headers
      if (opts.body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = opts.body
      const resp = await fetch(opts.url, fetchOpts)
      clearTimeout(tierTimer)
      clearTimeout(capTimer)
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
    if (!mainWindow) return { success: false, error: 'No window' }
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: '备份文件', extensions: ['zip'] }],
        title: '选择备份文件恢复'
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: '取消选择' }
      await extract(result.filePaths[0], { dir: storeDir })
      return { success: true, message: '备份已恢复，请重启应用生效' }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
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
    watchDir = dirPath
    if (!dirPath || !existsSync(dirPath)) return { success: true }
    try {
      const fs = await import('fs')
      fsWatcher = fs.watch(dirPath, { recursive: true }, (eventType: string, filename: string | Buffer | null) => {
        if (!filename || typeof filename !== 'string') return
        const ext = filename.split('.').pop()?.toLowerCase()
        if (!ext || !['md', 'txt', 'json', 'csv', 'pdf', 'docx'].includes(ext)) return
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('watchfs:changed', { event: eventType, filename, path: join(dirPath, filename) })
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
    const topK = opts.topK || 5
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
    return template
      .replace('%USERPROFILE%', process.env.USERPROFILE || 'C:\\Users\\Default')
      .replace('%HOME%', process.env.HOME || process.env.USERPROFILE || 'C:\\Users\\Default')
  })

  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const result = await shell.openPath(filePath)
      if (result && result !== '') {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function cleanupMcpProcesses() {
  for (const id of getAllMcpIds()) {
    stopMcpProcess(id)
  }
}
