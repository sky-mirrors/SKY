const DEBUG = process.env.HOLO_DEBUG === '1'
import { BrowserWindow, shell, globalShortcut } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { attachNavigationGuard } from './navigation-guard'

let mainWindow: BrowserWindow | null = null
let pipelineWindow: BrowserWindow | null = null
let debugWindow: BrowserWindow | null = null
let devWindow: BrowserWindow | null = null
let knowledgeWindow: BrowserWindow | null = null
let benchmarkWindow: BrowserWindow | null = null
let onPipelineWindowReady: (() => void) | null = null

// E-1 修复：导航白名单策略 = 应用渲染目录（生产 file:// 入口）+ dev 渲染服务器 origin
function navigationPolicy() {
  return {
    rendererDir: join(__dirname, '../renderer'),
    devServerUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
  }
}

// E-1 修复：给窗口挂 will-navigate 白名单——阻止渲染层把整窗导航到远程源
// （preload 会随窗口注入到新页面，等于把完整 electronAPI 交给攻击者页面）。
// 白名单外的 http(s) 目标交给系统浏览器打开。
function guardWindow(win: BrowserWindow): void {
  attachNavigationGuard(win.webContents, navigationPolicy(), (url) => { void shell.openExternal(url) })
}

export function setOnPipelineWindowReady(cb: () => void) {
  onPipelineWindowReady = cb
}

export function getMainWindow(): BrowserWindow | null {
  // A-01：与其他窗口一致，销毁后返回 null，防止调用方对已销毁 webContents 发送消息抛异常
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function getPipelineWindow(): BrowserWindow | null {
  return pipelineWindow && !pipelineWindow.isDestroyed() ? pipelineWindow : null
}

export function getDebugWindow(): BrowserWindow | null {
  return debugWindow && !debugWindow.isDestroyed() ? debugWindow : null
}

export function createWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.focus()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(mainWindow)

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer][${level}] ${message} @ ${sourceId}:${line}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Renderer CRASHED] reason=${details.reason}, exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    DEBUG && console.log('[MainWindow] Renderer finished loading')
  })

  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error(`[MainWindow] Renderer FAILED to load: code=${code}, desc=${desc}`)
  })

  // A-01：销毁后清空引用，避免跨窗口消息对已销毁对象调用 send 导致 uncaughtException 杀掉整个应用
  mainWindow.on('closed', () => { mainWindow = null })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function createPipelineWindow(): BrowserWindow {
  if (pipelineWindow && !pipelineWindow.isDestroyed()) {
    pipelineWindow.focus()
    return pipelineWindow
  }

  pipelineWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - 流水线工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  pipelineWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(pipelineWindow)

  pipelineWindow.webContents.on('did-finish-load', () => {
    if (onPipelineWindowReady) onPipelineWindowReady()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    pipelineWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pipeline.html`)
  } else {
    pipelineWindow.loadFile(join(__dirname, '../renderer/pipeline.html'))
  }

  pipelineWindow.on('closed', () => { pipelineWindow = null })
  return pipelineWindow
}

let onDebugWindowClosed: (() => void) | null = null
let onDebugWindowReady: (() => void) | null = null

export function setOnDebugWindowClosed(cb: () => void) {
  onDebugWindowClosed = cb
}

export function setOnDebugWindowReady(cb: () => void) {
  onDebugWindowReady = cb
}

export function createDebugWindow(): BrowserWindow {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus()
    return debugWindow
  }

  debugWindow = new BrowserWindow({
    width: 800,
    height: 400,
    minWidth: 400,
    minHeight: 300,
    show: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#050510',
    title: 'SKY - 调试监视器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  debugWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(debugWindow)

  // P1-35：ready 协议统一走主进程 did-finish-load（与 pipeline 窗一致），不再依赖渲染层手动上报
  debugWindow.webContents.on('did-finish-load', () => {
    onDebugWindowReady?.()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    debugWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/debug.html`)
  } else {
    debugWindow.loadFile(join(__dirname, '../renderer/debug.html'))
  }

  debugWindow.on('closed', () => {
    debugWindow = null
    onDebugWindowClosed?.()
  })
  return debugWindow
}

/**
 * 2026-10-01 开发者端（合并窗口）：把「调试中心 / 压测台 / 规则审核」三页收进一个窗口。
 * 管线编辑器按用户裁定不进开发者端（保留自己的独立窗口）。
 */
export function createDevWindow(): BrowserWindow {
  if (devWindow && !devWindow.isDestroyed()) {
    devWindow.focus()
    return devWindow
  }

  devWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - 开发者端',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  devWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(devWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    devWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/dev.html`)
  } else {
    devWindow.loadFile(join(__dirname, '../renderer/dev.html'))
  }

  devWindow.on('closed', () => {
    devWindow = null
  })
  return devWindow
}

export function getDevWindow(): BrowserWindow | null {
  return devWindow && !devWindow.isDestroyed() ? devWindow : null
}

/**
 * 2026-10-01 知识库独立窗口（用户裁定：知识库管理应出现在独立窗口，而非指令区右栏的全屏覆盖层）。
 * 与 dev / benchmark / rule-review 窗同一套多窗口接线。
 */
export function createKnowledgeWindow(): BrowserWindow {
  if (knowledgeWindow && !knowledgeWindow.isDestroyed()) {
    knowledgeWindow.focus()
    return knowledgeWindow
  }

  knowledgeWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 560,
    minHeight: 400,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - 知识库',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  knowledgeWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(knowledgeWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    knowledgeWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/knowledge.html`)
  } else {
    knowledgeWindow.loadFile(join(__dirname, '../renderer/knowledge.html'))
  }

  knowledgeWindow.on('closed', () => {
    knowledgeWindow = null
  })
  return knowledgeWindow
}

export function getKnowledgeWindow(): BrowserWindow | null {
  return knowledgeWindow && !knowledgeWindow.isDestroyed() ? knowledgeWindow : null
}

// 领域包编辑器窗口（2026-10）：让领域专家不改代码就能给用户包添加知识与规则。
let packEditorWindow: BrowserWindow | null = null

export function createPackEditorWindow(): BrowserWindow {
  if (packEditorWindow && !packEditorWindow.isDestroyed()) {
    packEditorWindow.focus()
    return packEditorWindow
  }

  packEditorWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - 领域包编辑器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  packEditorWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(packEditorWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    packEditorWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/packs.html`)
  } else {
    packEditorWindow.loadFile(join(__dirname, '../renderer/packs.html'))
  }

  packEditorWindow.on('closed', () => {
    packEditorWindow = null
  })
  return packEditorWindow
}

export function getPackEditorWindow(): BrowserWindow | null {
  return packEditorWindow && !packEditorWindow.isDestroyed() ? packEditorWindow : null
}

export function getBenchmarkWindow(): BrowserWindow | null {
  return benchmarkWindow && !benchmarkWindow.isDestroyed() ? benchmarkWindow : null
}

export function createBenchmarkWindow(): BrowserWindow {
  if (benchmarkWindow && !benchmarkWindow.isDestroyed()) {
    benchmarkWindow.focus()
    return benchmarkWindow
  }

  benchmarkWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - Token优化压测台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  benchmarkWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(benchmarkWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    benchmarkWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/benchmark.html`)
  } else {
    benchmarkWindow.loadFile(join(__dirname, '../renderer/benchmark.html'))
  }

  benchmarkWindow.on('closed', () => { benchmarkWindow = null })
  return benchmarkWindow
}

let ruleReviewWindow: BrowserWindow | null = null

export function getRuleReviewWindow(): BrowserWindow | null {
  return ruleReviewWindow && !ruleReviewWindow.isDestroyed() ? ruleReviewWindow : null
}

export function createRuleReviewWindow(): BrowserWindow {
  if (ruleReviewWindow && !ruleReviewWindow.isDestroyed()) {
    ruleReviewWindow.focus()
    return ruleReviewWindow
  }

  ruleReviewWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: true,
    frame: false,
    backgroundColor: '#050510',
    title: 'SKY - 规则审核',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  ruleReviewWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  guardWindow(ruleReviewWindow)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    ruleReviewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/rule-review.html`)
  } else {
    ruleReviewWindow.loadFile(join(__dirname, '../renderer/rule-review.html'))
  }

  ruleReviewWindow.on('closed', () => { ruleReviewWindow = null })
  return ruleReviewWindow
}

export function registerGlobalShortcuts() {
  globalShortcut.register('Ctrl+Space', () => {
    const mw = getMainWindow()
    if (!mw) return
    if (mw.isMinimized()) {
      mw.restore()
    }
    if (!mw.isVisible()) {
      mw.show()
    }
    mw.focus()
    mw.webContents.send('global:quickInput')
  })
}

export function unregisterGlobalShortcuts() {
  globalShortcut.unregisterAll()
}
