import { app, BrowserWindow, ipcMain } from 'electron'
import { createWindow, registerGlobalShortcuts, unregisterGlobalShortcuts, createPipelineWindow, getPipelineWindow, getMainWindow, setOnPipelineWindowReady, createDebugWindow, getDebugWindow, setOnDebugWindowClosed } from './window-manager'
import { setupIpc, cleanupMcpProcesses } from './ipc-handlers'

let pendingPipelineNodes: { toolId: string; toolName: string; toolLevel: string }[] = []

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason)
})

app.whenReady().then(async () => {
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
    if (!pw) {
      createPipelineWindow()
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

  let debugWindowReady = false
  let pendingDebugSyncs: { storeId: string; state: Record<string, unknown> }[] = []

  ipcMain.on('debug:ready', () => {
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
})
