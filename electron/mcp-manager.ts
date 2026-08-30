const DEBUG = process.env.HOLO_DEBUG === '1'
import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { appendFileSync, existsSync } from 'fs'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpProcessEntry {
  id: string
  process: ChildProcess
  command: string
  args: string[]
  env: Record<string, string>
  status: 'starting' | 'running' | 'stopped' | 'error'
  tools: McpTool[]
  requestId: number
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>
  buffer: string
  stderrBuffer: string
}

const mcpProcesses = new Map<string, McpProcessEntry>()

export function getMcpEntry(id: string): McpProcessEntry | undefined {
  return mcpProcesses.get(id)
}

export function hasMcpProcess(id: string): boolean {
  return mcpProcesses.has(id)
}

export function getAllMcpIds(): string[] {
  return [...mcpProcesses.keys()]
}

function notifyRenderer(win: BrowserWindow | null, channel: string, data: unknown) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

export function startMcpProcess(
  id: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  mainWindow: BrowserWindow | null
): { success: boolean; error?: string } {
  if (mcpProcesses.has(id)) {
    return { success: true }
  }

  try {
    const isWindows = process.platform === 'win32'
    const procEnv: Record<string, string> = { ...process.env as Record<string, string>, ...env }

    const finalCommand = command
    let finalArgs = [...args]

    const isFilesystem = args.some(a => typeof a === 'string' && a.includes('server-filesystem'))
    if (isFilesystem) {
      const hasDir = finalArgs.some(a => {
        if (typeof a !== 'string') return false
        return (a.match(/^[A-Za-z]:/) || a.startsWith('/') || a.startsWith('\\')) && !a.startsWith('@')
      })
      if (!hasDir) {
        const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default'
        const dirs = [join(home, 'Desktop'), join(home, 'Documents'), home]
        for (const drive of ['D:\\', 'E:\\']) {
          try {
            if (existsSync(drive)) dirs.push(drive)
          } catch { /* ignore */ }
        }
        finalArgs.push(...dirs)
      }
    }

    DEBUG && console.log(`[MCP spawn] id=${id} cmd=${finalCommand} args=${JSON.stringify(finalArgs)} isFs=${isFilesystem}`)

    try {
      const logPath = join(app.getPath('home'), 'Desktop', 'mcp-spawn-debug.log')
      appendFileSync(logPath, `[${new Date().toISOString()}] id=${id} cmd=${finalCommand} args=${JSON.stringify(finalArgs)} isFs=${isFilesystem}\n`)
    } catch { /* ignore */ }

    const child = spawn(finalCommand, finalArgs, {
      env: procEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows
    })

    const entry: McpProcessEntry = {
      id,
      process: child,
      command,
      args,
      env,
      status: 'starting',
      tools: [],
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
      stderrBuffer: ''
    }

    child.stdout?.on('data', (data: Buffer) => {
      entry.buffer += data.toString()
      while (true) {
        const nlIdx = entry.buffer.indexOf('\n')
        if (nlIdx === -1) break
        const line = entry.buffer.substring(0, nlIdx).trim()
        entry.buffer = entry.buffer.substring(nlIdx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          DEBUG && console.log(`[MCP ${id} <-]`, line.substring(0, 200))
          handleMcpMessage(entry, msg)
        } catch {
          if (line.includes('{') || line.includes('"jsonrpc"')) {
            DEBUG && console.log(`[MCP ${id} parse-err]`, line.substring(0, 200))
          }
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      entry.stderrBuffer += text
      const trimmed = text.trim()
      if (trimmed) DEBUG && console.log(`[MCP ${id} stderr]`, trimmed)
    })

    child.on('error', (err) => {
      console.error(`[MCP ${id} error]`, err.message)
      entry.status = 'error'
      for (const [, pending] of entry.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`MCP process error: ${err.message}`))
      }
      entry.pendingRequests.clear()
      notifyRenderer(mainWindow, 'mcp:status', { id, status: 'error', error: err.message })
    })

    child.on('exit', (code) => {
      DEBUG && console.log(`[MCP ${id} exited] code=${code}`)
      entry.status = 'stopped'
      const stderrTail = entry.stderrBuffer.slice(-500)
      for (const [, pending] of entry.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`MCP process exited with code ${code}: ${stderrTail}`))
      }
      entry.pendingRequests.clear()
      mcpProcesses.delete(id)
      notifyRenderer(mainWindow, 'mcp:status', { id, status: 'stopped', stderr: stderrTail })
    })

    mcpProcesses.set(id, entry)
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown spawn error'
    return { success: false, error: message }
  }
}

function handleMcpMessage(entry: McpProcessEntry, msg: Record<string, unknown>) {
  if (msg.id && typeof msg.id === 'number') {
    const pending = entry.pendingRequests.get(msg.id)
    if (pending) {
      clearTimeout(pending.timer)
      entry.pendingRequests.delete(msg.id)
      if (msg.error) {
        pending.reject(msg.error)
      } else {
        pending.resolve(msg.result || msg)
      }
    }
  }
}

export function sendMcpRequest(
  entry: McpProcessEntry,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = 15000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++entry.requestId
    const request = { jsonrpc: '2.0', id, method, params: params || {} }

    const timer = setTimeout(() => {
      entry.pendingRequests.delete(id)
      reject(new Error(`MCP request timeout: ${method}`))
    }, timeoutMs)

    entry.pendingRequests.set(id, { resolve, reject, timer })

    try {
      entry.process.stdin?.write(JSON.stringify(request) + '\n')
    } catch (err) {
      clearTimeout(timer)
      entry.pendingRequests.delete(id)
      reject(new Error(`MCP write error: ${err instanceof Error ? err.message : String(err)}`))
    }
  })
}

export function stopMcpProcess(id: string): boolean {
  const entry = mcpProcesses.get(id)
  if (!entry) return false

  entry.status = 'stopped'
  try {
    entry.process.kill('SIGTERM')
    setTimeout(() => {
      try { entry.process.kill('SIGKILL') } catch { /* already dead */ }
    }, 3000)
  } catch { /* already dead */ }

  for (const [, pending] of entry.pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('MCP process stopped'))
  }
  entry.pendingRequests.clear()

  mcpProcesses.delete(id)
  return true
}
