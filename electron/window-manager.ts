import { BrowserWindow, shell, globalShortcut } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let mainWindow: BrowserWindow | null = null
let pipelineWindow: BrowserWindow | null = null
let debugWindow: BrowserWindow | null = null
let benchmarkWindow: BrowserWindow | null = null
let onPipelineWindowReady: (() => void) | null = null

export function setOnPipelineWindowReady(cb: () => void) {
  onPipelineWindowReady = cb
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Renderer CRASHED] reason=${details.reason}, exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[MainWindow] Renderer finished loading')
  })

  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error(`[MainWindow] Renderer FAILED to load: code=${code}, desc=${desc}`)
  })

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
    title: 'HoloStarmap - 流水线工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  pipelineWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

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

export function setOnDebugWindowClosed(cb: () => void) {
  onDebugWindowClosed = cb
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
    title: 'HoloStarmap - 调试监视器',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  debugWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
    title: 'HoloStarmap - Token优化压测台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  benchmarkWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    benchmarkWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/benchmark.html`)
  } else {
    benchmarkWindow.loadFile(join(__dirname, '../renderer/benchmark.html'))
  }

  benchmarkWindow.on('closed', () => { benchmarkWindow = null })
  return benchmarkWindow
}

export function registerGlobalShortcuts() {
  globalShortcut.register('Ctrl+Space', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show()
    }
    mainWindow.focus()
    mainWindow.webContents.send('global:quickInput')
  })
}

export function unregisterGlobalShortcuts() {
  globalShortcut.unregisterAll()
}
