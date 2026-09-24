import { sep } from 'path'
import { fileURLToPath } from 'url'
import type { WebContents } from 'electron'

// E-1 修复：主窗/子窗此前只配了 setWindowOpenHandler（仅拦 window.open / target=_blank），
// 完全没有 will-navigate 防护。渲染层被 XSS 后执行 location.href='https://evil.com'
// 或 <meta http-equiv="refresh"> 即可把整个窗口导航到远程页面——preload 脚本随窗口注入，
// 攻击者页面直接拿到完整 window.electronAPI（shellExec/fileWrite/mcpSpawn/vaultWrite），
// 令 pathValidator / shell-security 全部主进程防线失去"渲染层隔离在本地页面"的前提。
//
// 本模块给每个窗口挂 will-navigate 白名单：只放行应用自身渲染目录的 file:// 入口，
// 以及 dev 模式的渲染服务器同源 URL；其余一律 preventDefault，http(s) 交给系统浏览器。

export interface NavigationPolicy {
  /** 应用渲染资源目录（生产 file:// 入口所在目录） */
  rendererDir: string
  /** dev 模式渲染服务器 origin（如 http://localhost:5173） */
  devServerUrl?: string
}

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '')
}

/**
 * 判定一个将要发生的顶层导航目标是否被允许。
 * 纯函数、无 Electron 依赖——便于单测。
 */
export function isAllowedNavigationTarget(url: string, policy: NavigationPolicy): boolean {
  if (typeof url !== 'string' || url.length === 0) return false

  // 1) dev 渲染服务器同源
  if (policy.devServerUrl) {
    try {
      if (new URL(url).origin === new URL(policy.devServerUrl).origin) return true
    } catch {
      /* 非法 URL，继续走后面的判定 */
    }
  }

  // 2) 应用自身渲染目录内的 file:// 资源
  try {
    const u = new URL(url)
    if (u.protocol !== 'file:') return false
    const filePath = fileURLToPath(u).toLowerCase()
    const root = stripTrailingSep(policy.rendererDir).toLowerCase()
    return filePath === root || filePath.startsWith(root + sep)
  } catch {
    return false
  }
}

/**
 * 给一个窗口的 webContents 挂导航白名单。session 级无法覆盖 —— 每个 webContents 单独挂。
 * openExternal 由调用方注入（避免本模块在非 Electron 环境（单测）下静态依赖 electron）。
 */
export function attachNavigationGuard(
  wc: WebContents | null | undefined,
  policy: NavigationPolicy,
  openExternal?: (url: string) => void
): void {
  if (!wc) return
  wc.on('will-navigate', (event, url) => {
    if (isAllowedNavigationTarget(url, policy)) return
    event.preventDefault()
    if (openExternal && /^https?:\/\//i.test(url)) {
      openExternal(url)
    }
  })
}
