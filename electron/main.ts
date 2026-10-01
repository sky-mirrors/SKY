import { app, BrowserWindow, ipcMain } from 'electron'
import { createWindow, registerGlobalShortcuts, unregisterGlobalShortcuts, createPipelineWindow, getPipelineWindow, getMainWindow, setOnPipelineWindowReady, createDebugWindow, getDebugWindow, setOnDebugWindowClosed, setOnDebugWindowReady, createBenchmarkWindow, getBenchmarkWindow, createRuleReviewWindow, getRuleReviewWindow, createDevWindow, getDevWindow } from './window-manager'
import { setupIpc, cleanupMcpProcesses } from './ipc-handlers'
// A-19：退出时关闭 SQLite 连接（closeVault 此前被导入但从未调用），
// 避免 WAL 文件残留与数据未 checkpoint 落盘
import { closeVault } from './vault'

let pendingPipelineNodes: { toolId: string; toolName: string; toolLevel: string }[] = []

let isCrashing = false

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err)
  if (!isCrashing) {
    isCrashing = true
    setTimeout(() => { app.quit() }, 1000)
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason)
})

// E-8：单实例锁。docs\ARCHITECTURE.md:133 承诺「启动序列: requestSingleInstanceLock(单实例)…
// 第二个实例启动时聚焦已有主窗口」，但此前从未实现——双实例会并行写 vaults\default.db
// （应用层 last-write-wins，无行级锁）与非原子的 store JSON。必须在 app.whenReady() 之前请求。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 已有实例在运行：本实例立即退出，不再建窗 / 初始化 Vault / 注册 IPC（避免双写）
  app.quit()
} else {
  // 第二个实例被拒后，由已有实例聚焦主窗（最小化时先还原再 show/focus）
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

app.whenReady().then(async () => {
  // 未持锁者已在上面 app.quit()；quit 是异步的，此处兜底不再初始化，避免竞态下建窗
  if (!gotTheLock) return

  const win = createWindow()
  setupIpc(win)

  setOnPipelineWindowReady(() => {
    const pw = getPipelineWindow()
    if (pw) {
      for (const node of pendingPipelineNodes) {
        pw.webContents.send('pipeline:nodeAdded', node)
      }
      pendingPipelineNodes = []
    }
  })

  ipcMain.on('open:pipeline-window', () => {
    createPipelineWindow()
  })

  ipcMain.on('pipeline:addNode', (_event, nodeData: { toolId: string; toolName: string; toolLevel: string }) => {
    const pw = getPipelineWindow()
    // A-07：窗口对象存在但 did-finish-load 未触发期间，webContents.send 是
    // fire-and-forget，节点会被静默丢弃——isLoading 期间统一入队，
    // 由 ready 回调在加载完成后冲刷
    if (!pw || pw.webContents.isLoading()) {
      if (!pw) createPipelineWindow()
      pendingPipelineNodes.push(nodeData)
      return
    }
    pw.webContents.send('pipeline:nodeAdded', nodeData)
  })

  ipcMain.on('pipeline:window:minimize', () => { getPipelineWindow()?.minimize() })
  ipcMain.on('pipeline:window:maximize', () => {
    const pw = getPipelineWindow()
    if (pw) { pw.isMaximized() ? pw.unmaximize() : pw.maximize() }
  })
  ipcMain.on('pipeline:window:close', () => { getPipelineWindow()?.close() })

  ipcMain.on('store:syncToPipeline', (_event, data: { storeId: string; state: Record<string, unknown> }) => {
    const pw = getPipelineWindow()
    if (pw) { pw.webContents.send('store:applyUpdate', data) }
  })

  // P1-26：流水线窗口"运行当前画布"——转发到主窗口执行（内核/LLM 网关只在主窗口注册）
  ipcMain.on('pipeline:runRequest', (_event, data: unknown) => {
    const mw = getMainWindow()
    if (mw) { mw.webContents.send('pipeline:run', data) }
  })

  ipcMain.on('pipeline:runProgress', (_event, data: unknown) => {
    const pw = getPipelineWindow()
    if (pw) { pw.webContents.send('pipeline:runEvent', data) }
  })

  ipcMain.on('store:syncToMain', (_event, data: { storeId: string; state: Record<string, unknown> }) => {
    const mw = getMainWindow()
    if (mw) { mw.webContents.send('store:applyUpdate', data) }
  })

  ipcMain.on('pipeline:toggleFloat', (_event, isFloat: boolean) => {
    const pw = getPipelineWindow()
    if (pw) {
      pw.setAlwaysOnTop(isFloat)
    }
  })

  ipcMain.on('open:debug-window', () => {
    createDebugWindow()
  })

  // 2026-10-01 开发者端（合并窗口）：调试中心 / 压测台 / 规则审核三页合一
  ipcMain.on('open:dev-window', () => {
    createDevWindow()
  })
  ipcMain.on('dev:window:minimize', () => { getDevWindow()?.minimize() })
  ipcMain.on('dev:window:maximize', () => {
    const w = getDevWindow()
    if (w) { w.isMaximized() ? w.unmaximize() : w.maximize() }
  })
  ipcMain.on('dev:window:close', () => { getDevWindow()?.close() })

  let debugWindowReady = false
  let pendingDebugSyncs: { storeId: string; state: Record<string, unknown> }[] = []

  // P1-35：debug 窗 ready 由主进程 did-finish-load 判定（替代原渲染层 ipcRendererSend 死链）
  setOnDebugWindowReady(() => {
    debugWindowReady = true
    const dw = getDebugWindow()
    if (dw) {
      for (const sync of pendingDebugSyncs) {
        dw.webContents.send('store:applyUpdate', sync)
      }
      pendingDebugSyncs = []
    }
  })

  setOnDebugWindowClosed(() => {
    debugWindowReady = false
    pendingDebugSyncs = []
  })

  ipcMain.on('debug:window:minimize', () => { getDebugWindow()?.minimize() })
  ipcMain.on('debug:window:maximize', () => {
    const dw = getDebugWindow()
    if (dw) { dw.isMaximized() ? dw.unmaximize() : dw.maximize() }
  })
  ipcMain.on('debug:window:close', () => { getDebugWindow()?.close() })

  ipcMain.on('store:syncToDebug', (_event, data: { storeId: string; state: Record<string, unknown> }) => {
    // 2026-10-01：开发者端（合并窗：调试/压测/规则审核三页）复用同一条下发通道。
    // 不做 ready 队列——下发是增量广播，dev 窗打开后的下一次变更即逐项对齐。
    getDevWindow()?.webContents.send('store:applyUpdate', data)
    const dw = getDebugWindow()
    if (!dw) return
    if (!debugWindowReady) {
      const existing = pendingDebugSyncs.findIndex(s => s.storeId === data.storeId)
      if (existing >= 0) {
        pendingDebugSyncs[existing] = data
      } else {
        pendingDebugSyncs.push(data)
      }
      return
    }
    dw.webContents.send('store:applyUpdate', data)
  })

  ipcMain.on('debug:toggleFloat', (_event, isFloat: boolean) => {
    const dw = getDebugWindow()
    if (dw) {
      dw.setAlwaysOnTop(isFloat)
    }
  })

  ipcMain.on('open:benchmark-window', () => {
    createBenchmarkWindow()
  })

  ipcMain.on('benchmark:window:minimize', () => { getBenchmarkWindow()?.minimize() })
  ipcMain.on('benchmark:window:maximize', () => {
    const bw = getBenchmarkWindow()
    if (bw) { bw.isMaximized() ? bw.unmaximize() : bw.maximize() }
  })
  ipcMain.on('benchmark:window:close', () => { getBenchmarkWindow()?.close() })

  ipcMain.on('open:rule-review-window', () => {
    createRuleReviewWindow()
  })

  ipcMain.on('rule-review:window:minimize', () => { getRuleReviewWindow()?.minimize() })
  ipcMain.on('rule-review:window:maximize', () => {
    const rrw = getRuleReviewWindow()
    if (rrw) { rrw.isMaximized() ? rrw.unmaximize() : rrw.maximize() }
  })
  ipcMain.on('rule-review:window:close', () => { getRuleReviewWindow()?.close() })

  registerGlobalShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  cleanupMcpProcesses()
  unregisterGlobalShortcuts()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  cleanupMcpProcesses()
  // A-19：退出前关闭 vault SQLite 连接
  closeVault()
})
