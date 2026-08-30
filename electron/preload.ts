import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform === 'win32' ? 'win32'
    : process.platform === 'darwin' ? 'darwin' : 'linux',

  openFile: (options?: { filters?: { name: string; extensions: string[] }[]; title?: string }) =>
    ipcRenderer.invoke('dialog:openFile', options),

  openDirectory: (options?: { title?: string }) =>
    ipcRenderer.invoke('dialog:openDirectory', options),

  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  mcpSpawn: (opts: { id: string; command: string; args: string[]; env: Record<string, string> }) =>
    ipcRenderer.invoke('mcp:spawn', opts),

  mcpCallTool: (opts: { id: string; toolName: string; args: Record<string, unknown> }) =>
    ipcRenderer.invoke('mcp:callTool', opts),

  mcpListTools: (opts: { id: string }) =>
    ipcRenderer.invoke('mcp:listTools', opts),

  mcpStop: (opts: { id: string }) =>
    ipcRenderer.invoke('mcp:stop', opts),

  mcpGetStatus: (opts: { id: string }) =>
    ipcRenderer.invoke('mcp:getStatus', opts),

  shellExec: (opts: { command: string; cwd?: string; timeout?: number; env?: Record<string, string> }) =>
    ipcRenderer.invoke('shell:exec', opts),

  safeStorageEncrypt: (text: string) =>
    ipcRenderer.invoke('safeStorage:encrypt', text),

  safeStorageDecrypt: (encrypted: string) =>
    ipcRenderer.invoke('safeStorage:decrypt', encrypted),

  safeStorageIsAvailable: () =>
    ipcRenderer.invoke('safeStorage:isAvailable'),

  storeRead: (key: string) =>
    ipcRenderer.invoke('store:read', key),

  storeWrite: (key: string, value: unknown) =>
    ipcRenderer.invoke('store:write', key, value),

  storeDelete: (key: string) =>
    ipcRenderer.invoke('store:delete', key),

  vectorReadBin: (key: string) =>
    ipcRenderer.invoke('vector:readBin', key),

  vectorWriteBin: (key: string, base64Data: string) =>
    ipcRenderer.invoke('vector:writeBin', key, base64Data),

  vectorListKeys: () =>
    ipcRenderer.invoke('vector:listKeys'),

  fileRead: (filePath: string, maxBytes?: number) =>
    ipcRenderer.invoke('file:read', filePath, maxBytes),

  fileWrite: (opts: { filePath: string; content: string; encoding?: string }) =>
    ipcRenderer.invoke('file:write', opts),

  createDirectory: (dirPath: string) =>
    ipcRenderer.invoke('file:createDirectory', dirPath),

  createDocx: (opts: { filePath: string; content?: string; title?: string }) =>
    ipcRenderer.invoke('file:createDocx', opts),

  httpFetch: (opts: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number }) =>
    ipcRenderer.invoke('http:fetch', opts),

  backupCreate: () =>
    ipcRenderer.invoke('backup:create'),

  backupRestore: () =>
    ipcRenderer.invoke('backup:restore'),

  backupList: () =>
    ipcRenderer.invoke('backup:list'),

  watchfsSetDir: (dirPath: string | null) =>
    ipcRenderer.invoke('watchfs:setDir', dirPath),

  watchfsGetDir: () =>
    ipcRenderer.invoke('watchfs:getDir'),

  onMcpStatus: (callback: (data: { id: string; status: string; error?: string; initResult?: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; status: string; error?: string; initResult?: unknown }) => callback(data)
    ipcRenderer.on('mcp:status', handler)
    return () => ipcRenderer.removeListener('mcp:status', handler)
  },

  onMcpTools: (callback: (data: { id: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }) => callback(data)
    ipcRenderer.on('mcp:tools', handler)
    return () => ipcRenderer.removeListener('mcp:tools', handler)
  },

  onWatchfsChanged: (callback: (data: { event: string; filename: string; path: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { event: string; filename: string; path: string }) => callback(data)
    ipcRenderer.on('watchfs:changed', handler)
    return () => ipcRenderer.removeListener('watchfs:changed', handler)
  },

  onGlobalQuickInput: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('global:quickInput', handler)
    return () => ipcRenderer.removeListener('global:quickInput', handler)
  },

  openPipelineWindow: () => ipcRenderer.send('open:pipeline-window'),

  pipelineAddNode: (nodeData: { toolId: string; toolName: string; toolLevel: string }) =>
    ipcRenderer.send('pipeline:addNode', nodeData),

  pipelineWindowMinimize: () => ipcRenderer.send('pipeline:window:minimize'),
  pipelineWindowMaximize: () => ipcRenderer.send('pipeline:window:maximize'),
  pipelineWindowClose: () => ipcRenderer.send('pipeline:window:close'),

  pipelineToggleFloat: (isFloat: boolean) => ipcRenderer.send('pipeline:toggleFloat', isFloat),

  onPipelineNodeAdded: (callback: (data: { toolId: string; toolName: string; toolLevel: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { toolId: string; toolName: string; toolLevel: string }) => callback(data)
    ipcRenderer.on('pipeline:nodeAdded', handler)
    return () => ipcRenderer.removeListener('pipeline:nodeAdded', handler)
  },

  storeSyncToPipeline: (data: { storeId: string; state: Record<string, unknown> }) =>
    ipcRenderer.send('store:syncToPipeline', data),

  storeSyncToMain: (data: { storeId: string; state: Record<string, unknown> }) =>
    ipcRenderer.send('store:syncToMain', data),

  onStoreApplyUpdate: (callback: (data: { storeId: string; state: Record<string, unknown> }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { storeId: string; state: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('store:applyUpdate', handler)
    return () => ipcRenderer.removeListener('store:applyUpdate', handler)
  },

  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),

  appHealth: () => ipcRenderer.invoke('app:health'),

  llmChatCompletion: (opts: {
    providerId: string
    model: string
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    maxTokens?: number
  }) =>
    ipcRenderer.invoke('llm:chatCompletion', opts),

  llmListModels: (opts: { providerId: string }) =>
    ipcRenderer.invoke('llm:listModels', opts),

  knowledgeIngest: (opts: { filename: string; content: string; fileType?: string }) =>
    ipcRenderer.invoke('knowledge:ingest', opts),

  knowledgeSearch: (opts: { query: string; topK?: number }) =>
    ipcRenderer.invoke('knowledge:search', opts),

  knowledgeListEntries: () =>
    ipcRenderer.invoke('knowledge:listEntries'),

  resolvePath: (template: string) =>
    ipcRenderer.invoke('env:resolvePath', template),

  openFilePath: (filePath: string) =>
    ipcRenderer.invoke('shell:openPath', filePath),

  openDebugWindow: () => ipcRenderer.send('open:debug-window'),

  debugWindowMinimize: () => ipcRenderer.send('debug:window:minimize'),
  debugWindowMaximize: () => ipcRenderer.send('debug:window:maximize'),
  debugWindowClose: () => ipcRenderer.send('debug:window:close'),
  debugToggleFloat: (isFloat: boolean) => ipcRenderer.send('debug:toggleFloat', isFloat),

  openBenchmarkWindow: () => ipcRenderer.send('open:benchmark-window'),
  benchmarkWindowMinimize: () => ipcRenderer.send('benchmark:window:minimize'),
  benchmarkWindowMaximize: () => ipcRenderer.send('benchmark:window:maximize'),
  benchmarkWindowClose: () => ipcRenderer.send('benchmark:window:close'),

  storeSyncToDebug: (data: { storeId: string; state: Record<string, unknown> }) =>
    ipcRenderer.send('store:syncToDebug', data),

  ipcRendererSend: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args)
})
