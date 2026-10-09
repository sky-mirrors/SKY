import { ipcMain, app } from 'electron'
import { join, resolve, dirname, sep } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'

/**
 * 用户领域包的写入通道（供「领域包编辑器」UI 使用）。
 *
 * 为什么需要单独一套 IPC：现有的 `file:write` 走 `pathValidator.validateWritePath`，
 * 只允许 Desktop / Documents / Downloads，而用户包放在 `{userData}/holostarmap-packs/`；
 * 直接放开该守卫会削弱全局写保护。因此这里开一条**范围受限**的专用通道：
 *   - 根目录固定为 `{userData}/holostarmap-packs`，调用方无法指定别处
 *   - packId 白名单字符集，杜绝 `..` / 绝对路径 / 盘符
 *   - 相对路径 resolve 后必须仍在包目录内（防穿越）
 *
 * 读侧沿用既有 `installUserPacks()`（src/host/packRuntime.ts），此处的 list/read 只是
 * 为了让编辑器在不重启的情况下看到磁盘现状。
 */

const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function userPacksRoot(): string {
  return join(app.getPath('userData'), 'holostarmap-packs')
}

/** 解析并校验目标路径；越界一律返回 null（fail-closed）。 */
function safeResolve(packId: string, relPath: string): string | null {
  if (!PACK_ID_RE.test(packId)) return null
  const root = resolve(userPacksRoot())
  const target = resolve(root, packId, relPath)
  if (!target.startsWith(root + sep)) return null
  return target
}

function listFilesRecursive(dir: string, prefix: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) listFilesRecursive(join(dir, entry.name), rel, out, depth + 1)
    else out.push(rel)
  }
  return out
}

export function setupUserPackIpc(): void {
  ipcMain.handle('pack:user:root', () => ({ success: true, root: userPacksRoot() }))

  ipcMain.handle('pack:user:list', () => {
    const root = userPacksRoot()
    if (!existsSync(root)) return { success: true, packs: [] as Array<{ id: string; files: string[] }> }
    try {
      const packs = readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && PACK_ID_RE.test(d.name))
        .map(d => ({ id: d.name, files: listFilesRecursive(join(root, d.name), '') }))
      return { success: true, packs }
    } catch (e) {
      return { success: false, packs: [], error: String(e) }
    }
  })

  ipcMain.handle('pack:user:read', (_e, packId: string, relPath: string) => {
    const target = safeResolve(packId, relPath)
    if (!target) return { success: false, error: '路径越界或 packId 不合法' }
    try {
      return { success: true, content: readFileSync(target, 'utf8') }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('pack:user:write', (_e, packId: string, relPath: string, content: string) => {
    const target = safeResolve(packId, relPath)
    if (!target) return { success: false, error: '路径越界或 packId 不合法（只允许字母数字与 -_）' }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      return { success: true, path: target }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('pack:user:deleteFile', (_e, packId: string, relPath: string) => {
    const target = safeResolve(packId, relPath)
    if (!target) return { success: false, error: '路径越界或 packId 不合法' }
    try {
      if (existsSync(target)) rmSync(target, { force: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('pack:user:deletePack', (_e, packId: string) => {
    if (!PACK_ID_RE.test(packId)) return { success: false, error: 'packId 不合法' }
    const root = resolve(userPacksRoot())
    const target = resolve(root, packId)
    if (!target.startsWith(root + sep)) return { success: false, error: '路径越界' }
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
