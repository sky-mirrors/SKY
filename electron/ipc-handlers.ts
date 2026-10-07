import { ipcMain, dialog, safeStorage, app, FileFilter, shell } from 'electron'
import { spawn } from 'child_process'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { Readable } from 'stream'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFile, createWriteStream, rmSync, renameSync, copyFileSync } from 'fs'
import { listDirectoryWithMeta } from './fileListing'
import { searchFiles } from './fileSearch'
import { editFileOnDisk } from './fileEdit'
import { convertDocumentToPdf } from './docConvert'
import { extractDocumentText } from './docExtract'
import { renderHtmlToPdf } from './pdfRenderer'
import { processImages, type ImageOp } from './imageOps'
import { processMedia, createFfmpegRunner, resolveFfmpegPath, type MediaOp } from './mediaOps'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import type { BrowserWindow } from 'electron'
// 2026-10-01：vault 写后广播需要运行时值（getAllWindows），故同时引入值导入
import { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { hasMcpProcess, startMcpProcess, stopMcpProcess, getMcpEntry, sendMcpRequest, getAllMcpIds, sanitizeMcpEnv } from './mcp-manager'
import { getMainWindow } from './window-manager'
import { isShellCommandAllowed, getTimeoutForCommand, HTTP_MAX_BODY_SIZE, HTTP_ALLOWED_METHODS, HTTP_TIMEOUT_TIER, HTTP_ABSOLUTE_CAP, isMcpCommandAllowed } from './shell-security'
import { validatePath as _validatePath, validateReadPath as _validateReadPath, validateOpenPath as _validateOpenPath, validateWritePath as _validateWritePath, hasSuspiciousBasename, sanitizeKey } from './pathValidator'
import { expandPathTemplate } from './pathExpansion'
import archiver from 'archiver'
import extract from 'extract-zip'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import * as jschardet from 'jschardet'
import * as iconv from 'iconv-lite'
// R16 修复：原为 CJS require('./vault')——electron-vite 打包不解析相对路径 CJS require，
// 运行时 out/main 仅有单文件 bundle 导致 MODULE_NOT_FOUND；改为静态 ESM import 由 rollup 打入
// B-6：vault vector/migrate/stats 六通道渲染层零调用，端到端删除
// A-19：closeVault 移至 main.ts 的 before-quit 调用，此处不再导入
import { openVault, closeVault, checkpointVault, vaultRead, vaultWrite, vaultDelete, vaultList } from './vault'
import { planRestoreTargets, applyRestore, validateBackupDir, BACKUP_EXTS } from './backupRestore'
import { decodeShellOutput } from './shellOutput'
// S-3：流式 usage 解析（含缓存命中字段）——与渲染层 sseParser 同口径
import { parseStreamUsage } from './streamUsage'
// E-5/E-6/E-7（主进程有界性）：限量读取与发送存活判定抽到叶子模块，可单测
import { readBodyCapped, readJsonCapped, safeSendTo, LLM_JSON_MAX_BYTES } from './ipcBounds'
import { pickApiConfig, type StoredApiConfig } from './apiConfigStore'
// P0-B1：统一超时阶梯（相对导入——主进程构建无 @ alias；模块零依赖可安全打入 bundle）
import { tierTimeoutFor, LLM_TIMEOUT_ABSOLUTE_CAP_MS } from '../src/services/llmTimeouts'
// LLM-ABORT：非流式 LLM IPC 请求的取消注册表（渲染侧 requestId → 主进程 AbortController）
import { registerLlmRequest, abortLlmRequest, releaseLlmRequest } from './llmAbortRegistry'
// D-1：私网/保留地址判定抽到 src/services/privateHost.ts（零 node 依赖），
// 与本进程原定义逐字一致——抽出的目的是让渲染层导入校验共用同一口径
import { isPrivateHostname, isPrivateIPv4, isPrivateIPv6 } from '../src/services/privateHost'

// F-8 修复：主进程侧路径模板展开的**单一入口**。
// 亲验结论（2026-09-27 快照 §十二）：展开此前只在渲染层 macroExecutor.resolveFilePath
// （宏路径专用，全仓 10 处调用全在该文件），主对话路径把 %USERPROFILE%\... 字面量直接
// 透传给 file:read ⇒ 主进程按字面量 resolve，落在名为 %USERPROFILE% 的目录上 ⇒ 整组
// 原生文件工具在含模板路径上失败（Q16 实测失败即此因），不止 read_file。
// 这里在四个校验入口前置展开，而非逐个 handler 改写——一处覆盖全部调用方（read/write/
// move/list/createDirectory/createDocx/doc:convertToPdf/image:process/media:process/
// shell:openPath），且以后新增任何拿路径的 handler 都自动获得展开，杜绝「单侧修复」复发。
// 展开只替换变量、不做放行判定：校验与安全边界完全不变（模板拼路径遍历照样被拒）。
const homeDir = () => app.getPath('home')
const validatePath = (p: string) => _validatePath(expandPathTemplate(p, homeDir()))
const validateReadPath = (p: string) => _validateReadPath(expandPathTemplate(p, homeDir()))
const validateWritePath = (p: string) => _validateWritePath(expandPathTemplate(p, homeDir()))
const validateOpenPath = (p: string) => _validateOpenPath(expandPathTemplate(p, homeDir()))

// A-06/A-01：不再持有 setupIpc 时的固定引用（macOS activate 重建窗口后变野指针、
// 关闭后 isDestroyed 判不住），统一经 window-manager 动态获取（内含 isDestroyed 校验）
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

/**
 * 统一读取 api-config（vault 优先、文件回退）。
 *
 * 2026-09-23 事故（见 electron/apiConfigStore.ts 顶部与 .rivet/HANDOFF.md 追加二十三/二十四）：
 * 三处 LLM 通道此前只读 `store/api-config.json` 文件，而渲染进程写入的是 vault ⇒ 主进程
 * 永远查不到 provider ⇒ 云端调用与判卷全失败、考试 0%。改为与渲染层同一真相源：
 *   ① vault `secure:holo-api-config`（storeSet 立即落盘，与渲染层 storeGet 同源）
 *   ② vault `api:holo-api-config`（saveToStorage 的 writeThrough 备份）
 *   ③ 文件 `store/api-config.json`（store:write 通道，兼容旧数据/旧安装）
 */
function readStoredApiConfig(): StoredApiConfig | null {
  return pickApiConfig([
    { label: 'vault:secure:holo-api-config', read: () => vaultRead('secure', 'holo-api-config') },
    { label: 'vault:api:holo-api-config', read: () => vaultRead('api', 'holo-api-config') },
    {
      label: 'file:store/api-config.json',
      read: () => {
        const configPath = join(storeDir, 'api-config.json')
        return existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
      }
    }
  ])
}

// A-15 / E-5 / E-6 / E-7：响应体限量读取、JSON 体积上限、发送存活判定
// 已抽到 ./ipcBounds（无 Electron 依赖、可单测），此处只保留调用。

// P1-1/E-4 修复：备份目录校验（拒符号链接/非常规文件/未列出扩展名，限数量与体积）
// 已抽到 ./backupRestore（无 Electron 依赖、可单测），并按 kind 区分扩展名白名单——
// store 只认 .json/.bin，vaults 另需接受 default.db 及其 -wal/-shm。

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

// P0-3/D-1：私网/保留地址判定已移至共享叶子模块 src/services/privateHost.ts
// （零 node 依赖，渲染层导入校验与主进程 isHostAllowed/safeFetch 共用同一口径）。
// 原实现逐字搬迁，行为不变；这里的 `isIP` 仅供下方"非字面量域名"分支与 safeFetch 使用。

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

// A-12（DNS Rebinding TOCTOU）：dns.lookup 校验与 fetch 内部解析是两次独立查询，
// 短 TTL 重绑定可先回公网 IP 过校验、再回内网 IP 供 fetch 实际连接，
// safeFetch 在校验通过后把连接固定到已校验的 IP（Host 头与 TLS SNI 仍用原域名），
// 从根本上消除二次解析窗口。
async function safeFetch(
  urlStr: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
): Promise<Response> {
  const url = new URL(urlStr)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('仅支持 http/https 协议')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let pinned: { address: string; family: number }
  if (isIP(host)) {
    const v = isIP(host)
    const priv = v === 4 ? isPrivateIPv4(host) : v === 6 ? isPrivateIPv6(host) : true
    if (priv) throw new Error(`不允许访问内网保留地址: ${host}`)
    pinned = { address: host, family: v }
  } else {
    if (isPrivateHostname(host)) throw new Error(`不允许访问内网保留地址: ${host}`)
    const addresses = await lookup(host, { all: true, verbatim: true })
    if (addresses.length === 0) throw new Error(`域名解析失败: ${host}`)
    for (const { address } of addresses) {
      const v = isIP(address)
      const priv = v === 4 ? isPrivateIPv4(address) : v === 6 ? isPrivateIPv6(address) : true
      if (priv) throw new Error(`域名解析到内网保留地址: ${host} -> ${address}`)
    }
    pinned = { address: addresses[0].address, family: addresses[0].family }
  }
  return new Promise<Response>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest
    const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname
    const reqOpts: Record<string, unknown> = {
      host: pinned.address,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method,
      family: pinned.family,
      headers: { ...(init.headers || {}), host: hostHeader },
      signal: init.signal
    }
    if (url.protocol === 'https:') reqOpts.servername = url.hostname
    const req = lib(reqOpts, (res) => {
      // ★ 根因修复（2026-09-23，插桩实测）：此处**不能**等 `res.on('end')`。
      // `res` 是 IncomingMessage（可读流），在无人 read/resume/data 消费时**不会流动**，
      // 'end' 永不触发 ⇒ Promise 永久 pending ⇒ 只能等 signal 超时 abort
      // （实测：云端 `https://api.deepseek.com/v1/models` 在 173ms 就返回 200，
      //   却被挂满 5s/60s 后报 "The operation was aborted"；探针脚本因写了 res.resume() 而 187ms 通过）。
      // 正确语义是**立即**把原始流交给下游（SSE 需实时可读，更不能整体缓冲）。
      try {
        const status = res.statusCode || 0
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
        }
        const nullBody = status === 204 || status === 205 || status === 304
        resolve(new Response(nullBody ? null : Readable.toWeb(res), { status, headers }))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
    if (init.body != null) req.write(init.body)
    req.end()
  })
}

export function setupIpc(_win: BrowserWindow | null) {
  ensureDir(storeDir)
  ensureDir(vectorDir)
  ensureDir(backupDir)
  ensureDir(knowledgeDir)

  ipcMain.on('window:minimize', () => { getMainWindow()?.minimize() })
  ipcMain.on('window:maximize', () => {
    const mw = getMainWindow()
    if (!mw) return
    mw.isMaximized() ? mw.unmaximize() : mw.maximize()
  })
  ipcMain.on('window:close', () => { getMainWindow()?.close() })

  ipcMain.handle('dialog:openFile', async (_event, options?: {
    filters?: FileFilter[]
    title?: string
  }) => {
    const mw = getMainWindow()
    if (!mw) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mw, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters,
      title: options?.title || '选择文件'
    })
    return result
  })

  ipcMain.handle('dialog:openDirectory', async (_event, options?: {
    title?: string
  }) => {
    const mw = getMainWindow()
    if (!mw) return { canceled: true, filePaths: [] }
    const result = await dialog.showOpenDialog(mw, {
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

  // C-16：删除知识条目时清理二进制向量文件（此前只增不减，删除后成隐私残留孤儿）
  ipcMain.handle('vector:deleteBin', (_event, key: string) => {
    const keyCheck = sanitizeKey(key)
    if (!keyCheck.safe) return false
    try {
      const filePath = join(vectorDir, `${key}.bin`)
      if (existsSync(filePath)) unlinkSync(filePath)
      return true
    } catch {
      return false
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

  // 2026-09-24 新增「重命名/移动」原生工具。原因（实测）：electron\shell-security.ts:4 的
  // SHELL_ALLOWED_COMMANDS 不含 ren / move / Move-Item / del，所以 Q15「图片按日期重命名」
  // 即使生成 shell_exec 命令也会被白名单拒绝。走 IPC 直连 fs 可绕开 shell 白名单；
  // 源路径用 validatePath、目标路径用 validateWritePath（与 file:write 同一写类口径）。
  ipcMain.handle('file:move', (_event, opts: { from?: string; to?: string; fromDir?: string; ext?: string; toDir?: string }) => {
    // 2026-10-07 新增**批量形态**：{ fromDir, ext?, toDir } —— 把 fromDir 下（可选按扩展名过滤）的文件
    // 全部移入 toDir。动机（真实用户对话实测）：用户说「将桌面上的docx文档全都放在一个新建的文件夹中」，
    // 而 file_move 只有单文件形态 ⇒ 静态两步计划（create_directory + file_move）**表达不了"全部"**，
    // 于是请求落到 L2 候选消歧并被错配成 create_docx（详见 l0SkillRouter 的『建文件夹并归类文件』规则注释）。
    // 校验口径与单文件一致：源目录用 validatePath（读）、目标用 validateWritePath（写）。
    if (opts?.fromDir && opts?.toDir) {
      const srcDirCheck = validatePath(opts.fromDir)
      if (!srcDirCheck.safe) return { success: false, error: srcDirCheck.reason }
      const dstDirCheck = validateWritePath(opts.toDir)
      if (!dstDirCheck.safe) return { success: false, error: dstDirCheck.reason }
      try {
        if (!existsSync(srcDirCheck.resolved)) return { success: false, error: `源目录不存在: ${srcDirCheck.resolved}` }
        if (!existsSync(dstDirCheck.resolved)) mkdirSync(dstDirCheck.resolved, { recursive: true })
        const wantExt = String(opts.ext || '').replace(/^\./, '').toLowerCase()
        const names = readdirSync(srcDirCheck.resolved, { withFileTypes: true })
          .filter(d => d.isFile())
          .map(d => d.name)
          .filter(n => !wantExt || n.toLowerCase().endsWith('.' + wantExt))
        const moved: string[] = []
        const failed: string[] = []
        for (const n of names) {
          const from = join(srcDirCheck.resolved, n)
          const to = join(dstDirCheck.resolved, n)
          try { renameSync(from, to); moved.push(n) } catch (e: unknown) { failed.push(`${n}: ${e instanceof Error ? e.message : String(e)}`) }
        }
        return { success: true, moved: moved.length, files: moved, failed, toDir: dstDirCheck.resolved }
      } catch (e: unknown) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    const srcCheck = validatePath(String(opts?.from || ''))
    if (!srcCheck.safe) return { success: false, error: srcCheck.reason }
    const dstCheck = validateWritePath(String(opts?.to || ''))
    if (!dstCheck.safe) return { success: false, error: dstCheck.reason }
    if (srcCheck.resolved === dstCheck.resolved) return { success: false, error: '源与目标路径相同' }
    try {
      if (!existsSync(srcCheck.resolved)) return { success: false, error: `源不存在: ${srcCheck.resolved}` }
      const dir = join(dstCheck.resolved, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      renameSync(srcCheck.resolved, dstCheck.resolved)
      return { success: true, from: srcCheck.resolved, to: dstCheck.resolved }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 2026-09-30 新增「复制」原生工具。与 file:move 同一校验口径（源 validatePath、
  // 目标 validateWritePath）；复制前若目标目录不存在则递归建，行为对齐 file:move。
  ipcMain.handle('file:copy', (_event, opts: { from: string; to: string }) => {
    const srcCheck = validatePath(opts.from)
    if (!srcCheck.safe) return { success: false, error: srcCheck.reason }
    const dstCheck = validateWritePath(opts.to)
    if (!dstCheck.safe) return { success: false, error: dstCheck.reason }
    if (srcCheck.resolved === dstCheck.resolved) return { success: false, error: '源与目标路径相同' }
    try {
      if (!existsSync(srcCheck.resolved)) return { success: false, error: `源不存在: ${srcCheck.resolved}` }
      const dir = join(dstCheck.resolved, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      copyFileSync(srcCheck.resolved, dstCheck.resolved)
      return { success: true, from: srcCheck.resolved, to: dstCheck.resolved }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 2026-10-07（可用性补强 W1）：精确编辑——改几行，而不是把整个文件重打一遍。
  // 写门：file_edit 在 writeGate.WRITE_TOOLS 内（渲染层先行确认）；路径过 validateWritePath；
  // 唯一性判定与"失败不落盘"在 ./fileEdit（可单测）。
  ipcMain.handle('file:edit', (_event, opts: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }) => {
    try {
      const pathCheck = validateWritePath(String(opts?.filePath || ''))
      if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
      const target = pathCheck.resolved
      if (!target || !existsSync(target)) return { success: false, error: '文件不存在' }
      if (!statSync(target).isFile()) return { success: false, error: '不是文件' }
      const r = editFileOnDisk(target, String(opts?.oldString ?? ''), String(opts?.newString ?? ''), opts?.replaceAll === true)
      if (!r.ok) return { success: false, error: r.error }
      return { success: true, replaced: r.replaced, path: target }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('file:createDirectory', (_event, dirPath: string) => {    const pathCheck = validatePath(dirPath)
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

  // 读目录：fs 直读取代 shell 版——shellExec 跑 `dir /b` 在本环境拿不到输出，
  // 导致 macroExecutor 的 list_directory「成功但结果为空」→ {{step_N_top_files}} 无值 → Q16 读取失败。
  ipcMain.handle('file:list', (_event, dirPath: string) => {
    try {
      const pathCheck = validateReadPath(dirPath)
      if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
      const validatedPath = pathCheck.resolved
      if (!validatedPath || !existsSync(validatedPath)) return { success: false, error: '目录不存在' }
      if (!statSync(validatedPath).isDirectory()) return { success: false, error: '不是目录' }
      // 2026-09-24：附带修改时间。Q15「按拍摄日期重命名」需要日期信息，而 file:read 对二进制图片
      // 只能返回 "[二进制文件…]"，文件名（img0.jpg）也不含日期 ⇒ 在列举时就带上 mtime，
      // 让模型可以直接用文件时间推导目标名。（isDir 一并给出，便于模型区分目录。）
      // 2026-09-24 追加（EXIF 批）：图片先读自身 EXIF 拍摄时间，读不到才回退文件系统时间；
      // 两种来源分字段返回（shootDateIso/shootDateTag 与 mtimeIso），渲染侧如实标注来源——
      // 「按拍摄时间整理照片」是高频诉求，有 EXIF 就必须用真的，文件时间只作兜底。
      // 数据路径在 ./fileListing（纯读盘 + 解析，可单测），此处只做路径校验与错误包装。
      const { entries, entriesWithMeta } = listDirectoryWithMeta(validatedPath)
      return { success: true, entries, entriesWithMeta }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 2026-10-07（Wave 2）：文件检索（按名 / 按内容）——**只读**。
  // 路径先过 validateReadPath；递归深度、单文件大小与结果条数的上限在 ./fileSearch 内（防拖住主进程）。
  ipcMain.handle('file:search', (_event, opts: { root: string; query: string; mode?: 'name' | 'content'; maxResults?: number }) => {
    try {
      const pathCheck = validateReadPath(String(opts?.root || ''))
      if (!pathCheck.safe) return { success: false, error: pathCheck.reason }
      const root = pathCheck.resolved
      if (!root || !existsSync(root)) return { success: false, error: '目录不存在' }
      if (!statSync(root).isDirectory()) return { success: false, error: '不是目录' }
      const mode: 'name' | 'content' = opts?.mode === 'content' ? 'content' : 'name'
      const maxResults = Number(opts?.maxResults) > 0 ? Number(opts.maxResults) : undefined
      const r = searchFiles(root, String(opts?.query || ''), mode, maxResults)
      return { success: true, ...r }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 第一波·文档能力：文档 → PDF（docx / md / html / txt）。
  // 走应用内转换（mammoth 出 HTML + Electron printToPDF 出 PDF），不依赖任何外部渲染器——
  // 本机实测无 Word / LibreOffice / pandoc，而 Chromium 是本应用的运行时，零新增依赖。
  // 源走读取校验、目标走写入校验，两侧都过 pathValidator；转换失败不落任何半成品文件。
  // K-1：文档文本提取（PDF/DOCX/XLSX）。原实现让渲染层对 PDF/Office 摄取占位符字符串，
  // 「已入库 N 个分块」实际入库的是假数据——经主进程用已有依赖真正提取文本后回传。
  ipcMain.handle('doc:extractText', async (_event, opts: { name: string; data: Uint8Array }) => {
    try {
      if (!opts || typeof opts.name !== 'string' || !opts.data) {
        return { success: false, error: '参数无效' }
      }
      const buf = opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data as ArrayBuffer)
      if (buf.byteLength === 0) return { success: false, error: '文件内容为空' }
      if (buf.byteLength > 50 * 1024 * 1024) return { success: false, error: '文件过大（上限 50MB）' }
      const text = await extractDocumentText(opts.name, buf)
      return { success: true, text }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 2026-09-30 新增：按**路径**提取文档文本。既有 doc:extractText 的入参是 Uint8Array
  // （上传场景，见 knowledgeBase 的 file.arrayBuffer()），而渲染层 file:read 对二进制只返回
  // 描述串、拿不到字节 —— 本机路径场景必须有本通道。复用同一提取实现与 50MB 上限。
  ipcMain.handle('doc:extractFromPath', async (_event, source: string) => {
    try {
      const src = String(source || '')
      if (!src) return { success: false, error: '缺少 source' }
      const check = validateReadPath(src)
      if (!check.safe) return { success: false, error: `源文件被安全策略拒绝: ${check.reason}` }
      if (!check.resolved || !existsSync(check.resolved)) return { success: false, error: `源文件不存在: ${src}` }
      const size = statSync(check.resolved).size
      if (size === 0) return { success: false, error: '文件内容为空' }
      if (size > 50 * 1024 * 1024) return { success: false, error: '文件过大（上限 50MB）' }
      const name = String(check.resolved).split(/[\\/]/).pop() || ''
      const text = await extractDocumentText(name, new Uint8Array(readFileSync(check.resolved)))
      return { success: true, text }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('doc:convertToPdf', async (_event, opts: { source: string; target: string }) => {
    try {
      const src = String(opts?.source || '')
      const dst = String(opts?.target || '')
      if (!src || !dst) return { success: false, error: '缺少 source 或 target' }
      const srcCheck = validateReadPath(src)
      if (!srcCheck.safe) return { success: false, error: `源文件被安全策略拒绝: ${srcCheck.reason}` }
      if (!srcCheck.resolved || !existsSync(srcCheck.resolved)) return { success: false, error: `源文件不存在: ${src}` }
      const dstCheck = validateWritePath(dst)
      if (!dstCheck.safe) return { success: false, error: `目标路径被安全策略拒绝: ${dstCheck.reason}` }
      const targetPath = dstCheck.resolved as string
      const result = await convertDocumentToPdf(srcCheck.resolved, targetPath, {
        readSource: async (p) => readFileSync(p),
        renderPdf: async ({ html }) => renderHtmlToPdf(html),
        writeTarget: async (p, buf) => { writeFileSync(p, buf) }
      })
      return { success: true, path: targetPath, bytes: result.bytes, title: result.title }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 第二波·图像能力：批量图像处理（sharp / libvips；二进制来自 npm 平台包 @img/sharp-win32-x64，
  // 不走 GitHub、免 electron-rebuild——N-API 预编译）。源逐个过读取校验，输出目录过写入校验；
  // 请求合法性由 imageOps.validateImageRequest 判定（失败给可读原因，绝不静默降级）。
  ipcMain.handle('image:process', async (_event, req: { inputs: string[]; op: ImageOp; outDir?: string; suffix?: string }) => {
    try {
      const rawInputs = Array.isArray(req?.inputs) ? req.inputs : []
      if (rawInputs.length === 0) return { success: false, error: '未提供任何源文件' }
      const safeInputs: string[] = []
      for (const p of rawInputs) {
        const chk = validateReadPath(String(p))
        if (!chk.safe) return { success: false, error: `源文件被安全策略拒绝: ${chk.reason}` }
        if (!chk.resolved || !existsSync(chk.resolved)) return { success: false, error: `源文件不存在: ${p}` }
        safeInputs.push(chk.resolved)
      }
      let outDir: string | undefined
      if (req?.outDir) {
        const dchk = validateWritePath(String(req.outDir))
        if (!dchk.safe) return { success: false, error: `输出目录被安全策略拒绝: ${dchk.reason}` }
        outDir = dchk.resolved as string
      }
      const result = await processImages({
        inputs: safeInputs,
        op: req?.op,
        outDir,
        suffix: req?.suffix ? String(req.suffix) : undefined
      })
      return {
        success: result.outputs.length > 0,
        outputs: result.outputs,
        failures: result.failures,
        error: result.outputs.length === 0 && result.failures.length > 0 ? result.failures[0].error : undefined
      }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 第三波·媒体能力：音视频处理（ffmpeg；二进制来自 npm 平台包 @ffmpeg-installer/win32-x64，
  // 不走 GitHub）。argv 固定、spawn 不经 shell；源逐个过读取校验、输出目录过写入校验。
  // 该构建是 2018 年的 ffmpeg（N-92722），故输入走显式白名单 + 体积上限 + 每步超时强杀（见 mediaOps 头注）。
  ipcMain.handle('media:process', async (_event, req: { inputs: string[]; op: MediaOp; outDir?: string; suffix?: string }) => {
    try {
      const rawInputs = Array.isArray(req?.inputs) ? req.inputs : []
      if (rawInputs.length === 0) return { success: false, error: '未提供任何源文件' }
      const safeInputs: string[] = []
      for (const p of rawInputs) {
        const chk = validateReadPath(String(p))
        if (!chk.safe) return { success: false, error: `源文件被安全策略拒绝: ${chk.reason}` }
        if (!chk.resolved || !existsSync(chk.resolved)) return { success: false, error: `源文件不存在: ${p}` }
        safeInputs.push(chk.resolved)
      }
      let outDir: string | undefined
      if (req?.outDir) {
        const dchk = validateWritePath(String(req.outDir))
        if (!dchk.safe) return { success: false, error: `输出目录被安全策略拒绝: ${dchk.reason}` }
        outDir = dchk.resolved as string
      }
      const run = createFfmpegRunner(resolveFfmpegPath())
      const result = await processMedia({
        inputs: safeInputs,
        op: req?.op,
        outDir,
        suffix: req?.suffix ? String(req.suffix) : undefined
      }, run)
      return {
        success: result.outputs.length > 0,
        outputs: result.outputs,
        failures: result.failures,
        probe: result.probe,
        error: result.outputs.length === 0 && result.failures.length > 0 ? result.failures[0].error : undefined
      }
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
        // A-14：maxBytes 必须为有限正数——Infinity 为 truthy 会绕过 `|| 512000` 整读大文件
        const limit = (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0) ? maxBytes : 512000
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
      // 2026-09-23 事故：api-config.json 被写成「BOM(3)+{}(2)」共 5 字节 ⇒ JSON.parse 抛错 ⇒
      // 应用表现为「没有配置」⇒ 所有 LLM 调用失败。此处先剥 BOM，且失败**不再静默**。
      const cleaned = data.charCodeAt(0) === 0xfeff ? data.slice(1) : data
      try {
        return JSON.parse(cleaned)
      } catch (parseErr) {
        console.warn(
          `[vault:read] 键「${key}」解析失败（文件可能被 BOM 或异常写入损坏，前 80 字：${cleaned.slice(0, 80)}）：`,
          String(parseErr).slice(0, 120)
        )
        return null
      }
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

    const result = startMcpProcess(opts.id, opts.command, opts.args, opts.env, getMainWindow())
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

      const mw = getMainWindow()
      if (mw) {
        mw.webContents.send('mcp:status', { id: opts.id, status: 'running', initResult })
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
        const mw = getMainWindow()
        if (mw) {
          mw.webContents.send('mcp:tools', { id: opts.id, tools })
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
      const mw = getMainWindow()
      if (mw) {
        mw.webContents.send('mcp:status', { id: opts.id, status: 'error', error: message })
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
      const mw = getMainWindow()
      if (mw) {
        mw.webContents.send('mcp:tools', { id: opts.id, tools })
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
      // A-10：SIGKILL 兜底定时器必须可清除——进程正常退出后残留的兜底 kill
      // 会在 3 秒后对已回收的 pid 误发信号（pid 可能已被复用）
      let killTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const extraNodePath = join(process.resourcesPath, 'node_modules')
        // A-03：渲染层传入的 env 必须先经 sanitizeMcpEnv 过滤危险键，
        // （NODE_OPTIONS=--import=... 可借 shell 通道注入任意主进程代码），
        // 再强制 NODE_PATH 为主进程指定值，防止 node -e 加载恶意模块
        const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), NODE_PATH: extraNodePath, ...sanitizeMcpEnv(opts.env) }
        childEnv.NODE_PATH = extraNodePath
        const child = spawn(opts.command, [], {
          cwd,
          shell: true,
          env: childEnv
        })
        // A-17：stdout/stderr 累积必须有字节上限——大文件 type / 长时间 npm install
        // 会使主进程内存持续增长；超限后停止累积并追加截断标记
        const MAX_STREAM_OUTPUT = 1024 * 1024
        const appendCapped = (current: string, data: Buffer): string => {
          if (current.length >= MAX_STREAM_OUTPUT) return current
          // F-3（2026-09-24）：原为 data.toString()（一律 UTF-8）——Windows cmd 内建命令按
          // GBK/CP936 输出，「系统找不到指定的文件。」上屏即乱码、失败原因对用户不可读。
          // 改走代码页解码（UTF-8 严格 → GBK）。此处与 file:read 的 jschardet 检测不同：
          // shell 输出常常很短（十几个字节），统计式检测不可靠，确定性策略更稳。
          const appended = current + decodeShellOutput(data)
          return appended.length > MAX_STREAM_OUTPUT
            ? appended.slice(0, MAX_STREAM_OUTPUT) + '\n... (输出超限，已截断)'
            : appended
        }
        child.stdout?.on('data', (data: Buffer) => { stdout = appendCapped(stdout, data) })
        child.stderr?.on('data', (data: Buffer) => { stderr = appendCapped(stderr, data) })
        child.on('close', (code: number | null) => {
          if (!settled) {
            settled = true
            if (tierTimer) clearTimeout(tierTimer)
            if (capTimer) clearTimeout(capTimer)
            resolve({ success: code === 0, code: code ?? -1, stdout, stderr })
          }
          if (killTimer) clearTimeout(killTimer)
        })
        child.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            if (tierTimer) clearTimeout(tierTimer)
            if (capTimer) clearTimeout(capTimer)
            resolve({ success: false, code: -1, stdout, stderr: err.message })
          }
          if (killTimer) clearTimeout(killTimer)
        })
        tierTimer = setTimeout(() => {
          if (!settled) {
            settled = true
            // A-10：Windows 下 shell:true 的直接子进程是 cmd.exe，kill 只杀壳进程，
            // 孙进程（npm/node 进程群）存活后台，超时保护名存实亡——
            // 改用 taskkill /T /F 杀整棵进程树；非 Windows 保留 SIGTERM→SIGKILL
            if (process.platform === 'win32' && child.pid) {
              try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already exited */ }
            } else {
              try { child.kill('SIGTERM') } catch { /* already exited */ }
              killTimer = setTimeout(() => {
                try { child.kill('SIGKILL') } catch { /* ignore */ }
              }, 3000)
            }
            resolve({ success: false, code: -1, stdout, stderr: `命令超时(${tierTimeout}ms)，已发送终止信号` })
          }
        }, tierTimeout)
        capTimer = setTimeout(() => {
          if (!settled) {
            settled = true
            // A-10：绝对超时同样按进程树击杀
            if (process.platform === 'win32' && child.pid) {
              try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already exited */ }
            } else {
              try { child.kill('SIGKILL') } catch { /* ignore */ }
            }
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

    // E-5：超时计时器必须活到 **body 读完** 为止——原实现紧跟 `await safeFetch` 的 finally
    // 就 clearTimeout，于是超时只覆盖到"响应头到达"，其后读 body 完全无界：慢速/停滞的
    // 响应体可以把主进程挂住，HTTP_ABSOLUTE_CAP 也拦不住。这里把"最近一跳"的计时器存起来，
    // 直到 body 正常/异常收尾才释放。
    // 注：必须声明在 try 之外——try / catch / finally 是三个独立块，块内 const 在 finally 不可见。
    let liveTimers: { tier: ReturnType<typeof setTimeout>; cap: ReturnType<typeof setTimeout> } | null = null
    const clearLiveTimers = () => {
      if (!liveTimers) return
      clearTimeout(liveTimers.tier)
      clearTimeout(liveTimers.cap)
      liveTimers = null
    }

    try {
      let currentUrl = opts.url
      let currentMethod = method
      let currentBody = opts.body
      let resp: Response | null = null

      // 对账 §4 #9：跳转响应体既不消费也不 cancel 时，undici 连接要等 GC 才回收——
      // 连续 302 用不到几次就能把连接池占住。每一跳（含超限返回）都显式释放。
      const releaseRedirectBody = async () => {
        if (!resp?.body) return
        try { await resp.body.cancel() } catch { /* 已关闭/已消费 */ }
      }

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // P0-3：每一跳都重新做协议 + DNS 解析 + 私网判定，堵死 302 重定向绕过；
        // A-12：safeFetch 校验后固定连接已校验 IP，消除 DNS rebinding TOCTOU
        clearLiveTimers() // 上一跳的计时器不再需要（其 body 已 cancel 或即将 cancel）
        const controller = new AbortController()
        const tierTimer = setTimeout(() => controller.abort(), tierTimeout)
        const capTimer = setTimeout(() => controller.abort(), HTTP_ABSOLUTE_CAP)
        liveTimers = { tier: tierTimer, cap: capTimer }
        // E-5：这里**不**在 finally 里 clearTimeout——计时器要活到 body 读完
        resp = await safeFetch(currentUrl, {
          method: currentMethod,
          headers: opts.headers,
          body: (currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD') ? currentBody : undefined,
          signal: controller.signal
        })

        if ([301, 302, 303, 307, 308].includes(resp.status)) {
          const location = resp.headers.get('location')
          if (!location) break
          if (hop === MAX_REDIRECTS) {
            await releaseRedirectBody()
            return { success: false, status: 0, error: `重定向次数超过上限(${MAX_REDIRECTS})` }
          }
          currentUrl = new URL(location, currentUrl).toString()
          if ([301, 302, 303].includes(resp.status)) {
            currentMethod = 'GET'
            currentBody = undefined
          }
          await releaseRedirectBody()
          continue
        }
        break
      }

      if (!resp) {
        return { success: false, status: 0, error: '请求未产生响应' }
      }
      // A-15：流式限量读取，不再先整读后截断。
      // E-5：读 body 期间 liveTimers 仍活着——停滞的 body 会被 tier/绝对上限掐断。
      const text = await readBodyCapped(resp)
      return { success: true, status: resp.status, headers: Object.fromEntries(resp.headers.entries()), body: text }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('abort') || msg.includes('AbortError')) {
        return { success: false, status: 0, error: `HTTP请求超时(${tierTimeout}ms)` }
      }
      return { success: false, status: 0, error: msg }
    } finally {
      // E-5：成功 / 失败 / 超时任一出口都释放超时计时器
      clearLiveTimers()
    }
  })

  ipcMain.handle('backup:create', async () => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const output = createWriteStream(join(backupDir, `holo-backup-${ts}.zip`))
      const archive = archiver('zip', { zlib: { level: 6 } })
      archive.pipe(output)
      // E-4：备份 SQLite 主库前先把 WAL 落盘——否则 default.db 与其 -wal 的读取非原子，
      // 并发写入期间备份可能得到事务不一致的快照
      checkpointVault()
      archive.directory(storeDir, 'store')
      // P1-5：只备 store 目录会漏掉 vault SQLite（全部 store 持久化数据）与
      // knowledge 知识库——"备份成功"却丢最核心数据；vectorDir 已含于 store 内
      const vaultsDir = join(userDataDir, 'vaults')
      if (existsSync(vaultsDir)) archive.directory(vaultsDir, 'vaults')
      if (existsSync(knowledgeDir)) archive.directory(knowledgeDir, 'knowledge')
      // A-09：archiver 流错误必须有监听（否则 EventEmitter 抛出→uncaughtException 杀应用），
      // 且 finalize() 的 Promise 需与 output close 一并等待，防止 handler 永久挂起
      await new Promise<void>((resolve, reject) => {
        archive.on('error', reject)
        output.on('close', resolve)
        output.on('error', reject)
        archive.finalize().catch(reject)
      })
      return { success: true, path: join(backupDir, `holo-backup-${ts}.zip`) }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('backup:restore', async () => {
    // P1-1/E-4 修复：解压到临时目录 → 全量校验 → 快照现网 → 原子交换（store + vaults + knowledge）
    const mw = getMainWindow()
    if (!mw) return { success: false, error: 'No window' }
    let tmpDir = ''
    let vaultsClosed = false
    try {
      const result = await dialog.showOpenDialog(mw, {
        properties: ['openFile'],
        filters: [{ name: '备份文件', extensions: ['zip'] }],
        title: '选择备份文件恢复'
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: '取消选择' }

      tmpDir = join(userDataDir, `restore-tmp-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      await extract(result.filePaths[0], { dir: tmpDir })

      const targets = planRestoreTargets(tmpDir, {
        storeDir,
        vaultsDir: join(userDataDir, 'vaults'),
        knowledgeDir,
      })
      const storeFiles = validateBackupDir(targets[0].staged, BACKUP_EXTS.store).files

      // E-4：vault 是唯一真相源，恢复必须同步交换 vaults/knowledge——旧实现只换 store，
      // 「恢复成功」却保留旧 vault，灾难迁移场景静默丢最核心数据。
      // vaults 交换前必须释放 SQLite 文件锁（Windows 下被打开的文件不可 rename）。
      const snapshots = applyRestore(targets, Date.now(), (kind) => {
        if (kind === 'vaults' && !vaultsClosed) {
          closeVault()
          vaultsClosed = true
        }
      })
      const swapped = targets.map(t => t.kind).join(' / ')
      return {
        success: true,
        message: `备份已恢复（store ${storeFiles} 个文件，已交换 ${swapped}）。恢复前数据已快照至 ${snapshots.join('、')}，请重启应用生效`,
      }
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      // 交换完成后重新打开 vault（指向恢复后的新库）；失败路径下同样把旧库重新打开
      if (vaultsClosed) {
        try { openVault() } catch { /* 重启后仍会打开 */ }
      }
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
        const mw = getMainWindow()
        if (mw) {
          mw.webContents.send('watchfs:changed', { event: eventType, filename, path: join(pathCheck.resolved, filename) })
        }
      })
      // A-08：成功建立监听后回写 watchDir，否则 watchfs:getDir 恒返回 null，UI 无法恢复监听状态
      watchDir = pathCheck.resolved
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
    temperature?: number
    // LLM-ABORT：渲染侧生成的关联 id——据此可按 id 取消在途 fetch（llm:abort 通道）
    requestId?: string
  }) => {
    const { providerId, model, messages, tools, maxTokens, temperature, requestId } = opts
    if (!providerId || !model || !messages) {
      return { success: false, error: 'Missing providerId, model, or messages' }
    }
    // LLM-ABORT：登记可取消控制器；请求收敛（成功/失败/中止）由 finally 摘除
    const abortCtrl = requestId ? registerLlmRequest(requestId) : null
    try {
      const stored = readStoredApiConfig()
      if (!stored) {
        return { success: false, error: 'No API configuration found' }
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
      // G-2：temperature 可选透传进请求体（渲染进程 routingOptions.temperature → IPC）
      if (temperature !== undefined) {
        body.temperature = temperature
      }
      const maxTok = maxTokens || 16384
      // P0-B1：统一超时阶梯（llmTimeouts.ts 唯一定义点，CPU 校准值）；
      // AbortSignal.timeout 原生抛 TimeoutError DOMException，供 errorClassifier 确定性归类
      const tierTimeout = tierTimeoutFor(maxTok)
      const absoluteCap = LLM_TIMEOUT_ABSOLUTE_CAP_MS
      // A-12：safeFetch 校验后固定连接已校验 IP，消除 DNS rebinding TOCTOU
      const resp = await safeFetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // LLM-ABORT：外部取消（abortCtrl）与自身超时任一触发即中断请求；
        // 无 requestId 时保持原行为（仅超时）
        signal: abortCtrl
          ? AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(Math.min(tierTimeout, absoluteCap))])
          : AbortSignal.timeout(Math.min(tierTimeout, absoluteCap))
      })
      if (!resp.ok) {
        const errBody = await readBodyCapped(resp, 16384).catch(() => '')
        return { success: false, error: `API error ${resp.status}: ${errBody.slice(0, 200)}` }
      }
      // E-6：JSON 响应体先设体积上限再解析（原 resp.json() 无上限，超大响应可打爆主进程）
      const data = await readJsonCapped<Record<string, unknown>>(resp, LLM_JSON_MAX_BYTES)
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
    } finally {
      // LLM-ABORT：任何出口（成功/失败/中止）都摘除登记，避免 Map 泄漏
      if (requestId) releaseLlmRequest(requestId)
    }
  })

  // LLM-ABORT：按 requestId 取消在途的非流式 LLM 请求。
  // 渲染侧「终止执行」经此通道真正中断主进程 fetch、省下仍在途的 Token
  // （此前 B-07 的 race 只让调用方不再等待，请求照跑、Token 照计）。
  ipcMain.handle('llm:abort', (_event, opts: { requestId?: string }) => {
    if (!opts?.requestId) return { aborted: false }
    return { aborted: abortLlmRequest(opts.requestId) }
  })

  ipcMain.handle('llm:listModels', async (_event, opts: { providerId: string }) => {
    if (!opts.providerId) {
      return { success: false, error: 'Missing providerId' }
    }
    try {
      const stored = readStoredApiConfig()
      if (!stored) {
        return { success: false, error: 'No API configuration found' }
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
      // A-12：safeFetch 校验后固定连接已校验 IP，消除 DNS rebinding TOCTOU
      const resp = await safeFetch(`${baseUrl}${endpoint}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000)
      })
      if (!resp.ok) {
        const errBody = await readBodyCapped(resp, 16384).catch(() => '')
        return { success: false, error: `API error ${resp.status}: ${errBody.slice(0, 200)}` }
      }
      // E-6：listModels 响应同样设体积上限
      const data = await readJsonCapped<{ data?: Array<{ id: string }> }>(resp, LLM_JSON_MAX_BYTES)
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
      // A-21：毫秒时间戳 ID 并发摄取同毫秒可碰撞互相覆盖，追加随机段保证唯一
      const id = `kb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
      // A-21：首/尾空格 split 出的空词 includes('') 恒真会匹配所有 chunk，必须过滤
      const queryWords = query.split(/\s+/).filter((w: string) => w.length > 0)
      if (queryWords.length === 0) {
        return { success: false, error: 'Missing query' }
      }
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
    // F-8：与 file:*/doc:* handler 复用同一展开实现（单一真相），不再各写一套 replace
    const resolved = expandPathTemplate(template, app.getPath('home'))
    const pathCheck = _validatePath(resolved)
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

  // P1-6：openVault 失败（库文件损坏/被其他进程占用）此前会让 setupIpc 整体炸掉——
  // 后续所有 IPC 通道不注册、异常落入 whenReady 的 unhandledRejection，用户无任何提示。
  // 捕获后弹系统级错误框；vault:* 通道照常注册，调用时 getDb 抛明确错误，
  // 渲染层 syncFromVault 失败将 fail-fast 拒绝挂载（见 src/main.ts）
  try {
    openVault()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[vault] 数据库打开失败:', msg)
    dialog.showErrorBox(
      '数据存储打开失败',
      `本地数据库无法打开，应用数据读写不可用。\n\n${msg}\n\n请检查数据目录磁盘状态或确认没有其他实例占用后重启应用。`
    )
  }

  ipcMain.handle('vault:read', (_event, namespace: string, key: string) => {
    return vaultRead(namespace, key)
  })

  ipcMain.handle('vault:write', (event, namespace: string, key: string, value: string, encrypted?: boolean) => {
    vaultWrite(namespace, key, value, encrypted)
    // 2026-10-01（缺陷修复）：多窗口各自持有渲染层 vault 缓存、彼此不可见，导致
    // 「A 窗改完 → B 窗用旧快照写回 → A 的改动被覆盖」。实测到知识库删除被主窗旧快照回滚。
    // 这里在写入后向**其他**窗口广播变更，让它们刷新该 key，从根上避免旧快照回写。
    try {
      for (const w of ElectronBrowserWindow.getAllWindows()) {
        if (w.webContents.id === event.sender.id) continue
        w.webContents.send('vault:changed', { namespace, key })
      }
    } catch { /* 广播失败不影响写入本身 */ }
  })

  ipcMain.handle('vault:delete', (event, namespace: string, key: string) => {
    vaultDelete(namespace, key)
    try {
      for (const w of ElectronBrowserWindow.getAllWindows()) {
        if (w.webContents.id === event.sender.id) continue
        w.webContents.send('vault:changed', { namespace, key })
      }
    } catch { /* 同上 */ }
  })

  ipcMain.handle('vault:list', (_event, namespace?: string) => {
    return vaultList(namespace)
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
  temperature?: number
}) => {
  const { streamId, providerId, model, messages, tools, maxTokens, temperature } = opts
  const abortCtrl = new AbortController()
  activeStreamControllers.set(streamId, abortCtrl)

  const chunkChannel = `llm:stream:chunk:${streamId}`
  const endChannel = `llm:stream:end:${streamId}`
  const errorChannel = `llm:stream:error:${streamId}`

  try {
    if (!providerId || !model || !messages) {
      safeSendTo(event.sender, errorChannel, 'Missing providerId, model, or messages')
      activeStreamControllers.delete(streamId)
      return
    }
    const stored = readStoredApiConfig()
    if (!stored) {
      safeSendTo(event.sender, errorChannel, 'No API configuration found')
      activeStreamControllers.delete(streamId)
      return
    }
    const provider = (stored.providers || []).find(p => p.id === providerId)
    if (!provider) {
      safeSendTo(event.sender, errorChannel, `Provider '${providerId}' not found`)
      activeStreamControllers.delete(streamId)
      return
    }
    let apiKey = provider.apiKey || ''
    if (apiKey.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
      try {
        const buffer = Buffer.from(apiKey.substring(4), 'base64')
        apiKey = safeStorage.decryptString(buffer)
      } catch {
        safeSendTo(event.sender, errorChannel, 'Failed to decrypt API key')
        activeStreamControllers.delete(streamId)
        return
      }
    }
    const baseUrl = (provider.baseUrl || stored.baseUrl || '').replace(/\/+$/, '')
    if (!baseUrl) {
      safeSendTo(event.sender, errorChannel, 'No base URL configured')
      activeStreamControllers.delete(streamId)
      return
    }
    try {
      const baseUrlObj = new URL(baseUrl)
      const hostCheck = await isHostAllowed(baseUrlObj.hostname)
      if (!hostCheck.allowed) {
        safeSendTo(event.sender, errorChannel, `LLM API不允许访问内网地址: ${baseUrlObj.hostname}（${hostCheck.reason || ''}）`)
        activeStreamControllers.delete(streamId)
        return
      }
    } catch {
      safeSendTo(event.sender, errorChannel, 'LLM API base URL格式无效')
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
    // G-2：temperature 可选透传进请求体（渲染进程 routingOptions.temperature → IPC）
    if (temperature !== undefined) {
      body.temperature = temperature
    }

    const maxTok = maxTokens || 16384
    // P0-B1：统一超时阶梯（同非流式 IPC 路径）
    const tierTimeout = tierTimeoutFor(maxTok)
    const absoluteCap = LLM_TIMEOUT_ABSOLUTE_CAP_MS
    const fetchSignal = AbortSignal.any([abortCtrl.signal, AbortSignal.timeout(Math.min(tierTimeout, absoluteCap))])

    // A-12：safeFetch 校验后固定连接已校验 IP，消除 DNS rebinding TOCTOU（SSE 流透传）
    const resp = await safeFetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal
    })
    if (!resp.ok) {
      const errBody = await readBodyCapped(resp, 16384).catch(() => '')
      safeSendTo(event.sender, errorChannel, `API error ${resp.status}: ${errBody.slice(0, 200)}`)
      activeStreamControllers.delete(streamId)
      return
    }
    if (!resp.body) {
      safeSendTo(event.sender, errorChannel, 'Response body is null')
      activeStreamControllers.delete(streamId)
      return
    }

    let accumulatedContent = ''
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
    let promptTokens = 0
    let completionTokens = 0
    // S-3：缓存命中/未命中同样要透传——原实现 end payload 硬编码 0，令 G-5「按实际 usage
    // 计价」在桌面流式主路径整段失效（DeepSeek 等缓存折扣被清零，账本按全价记）
    let cacheHitTokens = 0
    let cacheMissTokens = 0

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
        // S-4/B-11 对齐渲染层：冒号后至多剥一个空格——data:xxx（无空格）此前被整行丢弃
        if (!line.startsWith('data:') && !line.startsWith('event:')) continue
        if (line.startsWith('data:')) {
          const raw = line.slice(5)
          const d = raw.startsWith(' ') ? raw.slice(1) : raw
          if (chatFormat === 'openai') {
            if (d.trim() === '[DONE]') {
              const toolCalls = Array.from(toolCallMap.values())
              safeSendTo(event.sender, endChannel, { content: accumulatedContent, toolCalls, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens, cacheMissTokens } })
              activeStreamControllers.delete(streamId)
              return
            }
            try {
              const p = JSON.parse(d)
              // S-4：服务端在流内报错必须走 error 频道，不得静默丢弃后当成功收尾
              if (p.error) {
                safeSendTo(event.sender, errorChannel, typeof p.error === 'string' ? p.error : (p.error.message || 'stream error'))
                activeStreamControllers.delete(streamId)
                return
              }
              if (p.choices?.[0]?.delta?.content) {
                accumulatedContent += p.choices[0].delta.content
                safeSendTo(event.sender, chunkChannel, { content: accumulatedContent, delta: p.choices[0].delta.content, toolCalls: undefined, usage: undefined, done: false })
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
                // S-3：四个字段一并解析（含 prompt_cache_hit_tokens / prompt_tokens_details.cached_tokens）
                const u = parseStreamUsage(p.usage)
                if (u.promptTokens !== undefined) promptTokens = u.promptTokens
                if (u.completionTokens !== undefined) completionTokens = u.completionTokens
                if (u.cacheHitTokens !== undefined) cacheHitTokens = u.cacheHitTokens
                if (u.cacheMissTokens !== undefined) cacheMissTokens = u.cacheMissTokens
              }
            } catch { /* skip */ }
          } else {
            try {
              const p = JSON.parse(d)
              // S-4：Anthropic 流内错误事件（overloaded_error 等）→ error 频道
              if (p.type === 'error') {
                safeSendTo(event.sender, errorChannel, p.error?.message || p.error?.type || 'anthropic stream error')
                activeStreamControllers.delete(streamId)
                return
              }
              if (p.type === 'content_block_delta' && p.delta?.type === 'text_delta' && p.delta?.text) {
                accumulatedContent += p.delta.text
                safeSendTo(event.sender, chunkChannel, { content: accumulatedContent, delta: p.delta.text, toolCalls: undefined, usage: undefined, done: false })
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
                // S-3：Anthropic 的 cache_read_input_tokens 同样计入命中（此前只取 input_tokens）
                const u = parseStreamUsage(p.message.usage)
                if (u.promptTokens !== undefined) promptTokens = u.promptTokens
                if (u.cacheHitTokens !== undefined) cacheHitTokens = u.cacheHitTokens
                if (u.cacheMissTokens !== undefined) cacheMissTokens = u.cacheMissTokens
              }
              if (p.type === 'message_delta' && p.usage) {
                const u = parseStreamUsage(p.usage)
                if (u.completionTokens !== undefined) completionTokens = u.completionTokens
                if (u.cacheHitTokens !== undefined) cacheHitTokens = u.cacheHitTokens
                if (u.cacheMissTokens !== undefined) cacheMissTokens = u.cacheMissTokens
              }
              if (p.type === 'message_stop') {
                const toolCalls = Array.from(toolCallMap.values())
                safeSendTo(event.sender, endChannel, { content: accumulatedContent, toolCalls, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens, cacheMissTokens } })
                activeStreamControllers.delete(streamId)
                return
              }
            } catch { /* skip */ }
          }
        }
      }
    }

    if (!abortCtrl.signal.aborted) {
      // S-4：走到这里说明流已 EOF 但从未见到终止标记（[DONE]/message_stop）——标记 truncated，
      // 交由渲染层判失败/不入缓存，不再当成正常完成
      const toolCalls = Array.from(toolCallMap.values())
      safeSendTo(event.sender, endChannel, { content: accumulatedContent, toolCalls, truncated: true, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheHitTokens, cacheMissTokens } })
    }
    activeStreamControllers.delete(streamId)
  } catch (err) {
    if (!abortCtrl.signal.aborted) {
      safeSendTo(event.sender, errorChannel, err instanceof Error ? err.message : String(err))
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
