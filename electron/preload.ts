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

  vectorDeleteBin: (key: string) =>
    ipcRenderer.invoke('vector:deleteBin', key),

  fileRead: (filePath: string, maxBytes?: number) =>
    ipcRenderer.invoke('file:read', filePath, maxBytes),

  fileList: (dirPath: string) =>
    ipcRenderer.invoke('file:list', dirPath),

  // 2026-10-07（Wave 2）：递归文件检索（按名 / 按内容），只读
  fileSearch: (opts: { root: string; query: string; mode?: 'name' | 'content'; maxResults?: number }) =>
    ipcRenderer.invoke('file:search', opts),

  fileWrite: (opts: { filePath: string; content: string; encoding?: string }) =>
    ipcRenderer.invoke('file:write', opts),
  fileMove: (opts: { from: string; to: string }) =>
    ipcRenderer.invoke('file:move', opts),
  // 2026-09-30：复制文件（与 file:move 同校验口径）
  fileCopy: (opts: { from: string; to: string }) =>
    ipcRenderer.invoke('file:copy', opts),

  createDirectory: (dirPath: string) =>
    ipcRenderer.invoke('file:createDirectory', dirPath),

  createDocx: (opts: { filePath: string; content?: string; title?: string }) =>
    ipcRenderer.invoke('file:createDocx', opts),

  // 第一波·文档能力：文档 → PDF（应用内转换，无外部渲染器依赖）
  docConvertToPdf: (opts: { source: string; target: string }) =>
    ipcRenderer.invoke('doc:convertToPdf', opts),

  // 第二波·图像能力：批量图像处理（sharp / libvips，二进制来自 npm 平台包）
  imageProcess: (opts: { inputs: string[]; op: Record<string, unknown>; outDir?: string; suffix?: string }) =>
    ipcRenderer.invoke('image:process', opts),

  // 第三波·媒体能力：音视频处理（ffmpeg，二进制来自 npm 平台包）
  mediaProcess: (opts: { inputs: string[]; op: Record<string, unknown>; outDir?: string; suffix?: string }) =>
    ipcRenderer.invoke('media:process', opts),

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

  // P1-26：流水线窗口"运行当前画布"——请求主窗口执行，并接收进度事件
  pipelineRunRequest: (data: { nodes: { id: string; toolId: string; toolName: string; params: Record<string, string>; outputKey: string }[]; edges: unknown[] }) =>
    ipcRenderer.send('pipeline:runRequest', data),

  onPipelineRunEvent: (callback: (data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) => callback(data)
    ipcRenderer.on('pipeline:runEvent', handler)
    return () => ipcRenderer.removeListener('pipeline:runEvent', handler)
  },

  // P1-26：主窗口侧——接收画布执行请求，回传进度
  onPipelineRunRequest: (callback: (data: { nodes: { id: string; toolId: string; toolName: string; params: Record<string, string>; outputKey: string }[]; edges: unknown[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { nodes: { id: string; toolId: string; toolName: string; params: Record<string, string>; outputKey: string }[]; edges: unknown[] }) => callback(data)
    ipcRenderer.on('pipeline:run', handler)
    return () => ipcRenderer.removeListener('pipeline:run', handler)
  },

  pipelineRunProgress: (data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) =>
    ipcRenderer.send('pipeline:runProgress', data),

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
    temperature?: number
    // LLM-ABORT：关联 id——配合 llmAbort 可在途中止主进程 fetch
    requestId?: string
  }) =>
    ipcRenderer.invoke('llm:chatCompletion', opts),

  // LLM-ABORT：按 requestId 取消在途的非流式 LLM 请求（「终止执行」→ 真正省下 Token）
  llmAbort: (requestId: string) =>
    ipcRenderer.invoke('llm:abort', { requestId }),

  llmChatCompletionStream: (
    opts: {
      providerId: string
      model: string
      messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
      maxTokens?: number
      temperature?: number
    },
    callbacks: {
      onChunk: (chunk: { content: string; delta: string; done: boolean }) => void
      onDone: (final: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; truncated?: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number } }) => void
      onError: (err: string) => void
    }
  ) => {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const chunkChannel = `llm:stream:chunk:${streamId}`
    const endChannel = `llm:stream:end:${streamId}`
    const errorChannel = `llm:stream:error:${streamId}`

    const chunkHandler = (_event: Electron.IpcRendererEvent, data: unknown) => callbacks.onChunk(data as { content: string; delta: string; done: boolean })
    const endHandler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      cleanup()
      callbacks.onDone(data as { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number } })
    }
    const errorHandler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      cleanup()
      callbacks.onError(data as string)
    }

    const cleanup = () => {
      ipcRenderer.removeListener(chunkChannel, chunkHandler)
      ipcRenderer.removeListener(endChannel, endHandler)
      ipcRenderer.removeListener(errorChannel, errorHandler)
    }

    ipcRenderer.on(chunkChannel, chunkHandler)
    ipcRenderer.on(endChannel, endHandler)
    ipcRenderer.on(errorChannel, errorHandler)
    ipcRenderer.send('llm:stream:start', { streamId, ...opts })

    return () => {
      cleanup()
      ipcRenderer.send('llm:stream:cancel', { streamId })
    }
  },

  llmListModels: (opts: { providerId: string }) =>
    ipcRenderer.invoke('llm:listModels', opts),

  knowledgeIngest: (opts: { filename: string; content: string; fileType?: string }) =>
    ipcRenderer.invoke('knowledge:ingest', opts),

  knowledgeSearch: (opts: { query: string; topK?: number }) =>
    ipcRenderer.invoke('knowledge:search', opts),

  knowledgeListEntries: () =>
    ipcRenderer.invoke('knowledge:listEntries'),

  // K-1：文档文本提取（PDF/DOCX/XLSX）——知识摄取不再用占位符假入库
  docExtractText: (opts: { name: string; data: Uint8Array }) =>
    ipcRenderer.invoke('doc:extractText', opts),
  // 2026-09-30：按**路径**提取（渲染层 file:read 对二进制只返回描述串，拿不到字节）
  docExtractFromPath: (source: string) =>
    ipcRenderer.invoke('doc:extractFromPath', source),

  resolvePath: (template: string) =>
    ipcRenderer.invoke('env:resolvePath', template),

  openFilePath: (filePath: string) =>
    ipcRenderer.invoke('shell:openPath', filePath),

  dataExportZip: (opts: { data: string; defaultName: string }) =>
    ipcRenderer.invoke('data:exportZip', opts),

  dataImportZip: () =>
    ipcRenderer.invoke('data:importZip'),

  getUserDataPath: () =>
    ipcRenderer.invoke('app:getUserDataPath'),

  vaultRead: (namespace: string, key: string) =>
    ipcRenderer.invoke('vault:read', namespace, key),

  vaultWrite: (namespace: string, key: string, value: string, encrypted?: boolean) =>
    ipcRenderer.invoke('vault:write', namespace, key, value, encrypted),

  vaultDelete: (namespace: string, key: string) =>
    ipcRenderer.invoke('vault:delete', namespace, key),

  vaultList: (namespace?: string) =>
    ipcRenderer.invoke('vault:list', namespace),

  // 2026-10-01（缺陷修复）：他窗写入广播——供各窗口刷新本地 vault 缓存，避免旧快照覆盖新数据
  onVaultChanged: (callback: (data: { namespace: string; key: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { namespace: string; key: string }) => callback(data)
    ipcRenderer.on('vault:changed', handler)
    return () => ipcRenderer.removeListener('vault:changed', handler)
  },

  openDebugWindow: () => ipcRenderer.send('open:debug-window'),

  // 2026-10-01 开发者端（合并窗口：调试中心 / 压测台 / 规则审核）
  openDevWindow: () => ipcRenderer.send('open:dev-window'),
  devWindowMinimize: () => ipcRenderer.send('dev:window:minimize'),
  devWindowMaximize: () => ipcRenderer.send('dev:window:maximize'),
  devWindowClose: () => ipcRenderer.send('dev:window:close'),

  // 2026-10-01 知识库独立窗口
  openKnowledgeWindow: () => ipcRenderer.send('open:knowledge-window'),
  knowledgeWindowMinimize: () => ipcRenderer.send('knowledge:window:minimize'),
  knowledgeWindowMaximize: () => ipcRenderer.send('knowledge:window:maximize'),
  knowledgeWindowClose: () => ipcRenderer.send('knowledge:window:close'),
  storeSyncToKnowledge: (data: { storeId: string; state: Record<string, unknown> }) =>
    ipcRenderer.send('store:syncToKnowledge', data),
  // 知识库窗挂载后请主窗推一次全量快照（静态数据——不像 debug 窗那样靠增量自发对齐）
  knowledgeRequestSnapshot: () => ipcRenderer.send('knowledge:request-snapshot'),
  onKnowledgePushSnapshot: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('knowledge:push-snapshot', handler)
    return () => ipcRenderer.removeListener('knowledge:push-snapshot', handler)
  },

  debugWindowMinimize: () => ipcRenderer.send('debug:window:minimize'),
  debugWindowMaximize: () => ipcRenderer.send('debug:window:maximize'),
  debugWindowClose: () => ipcRenderer.send('debug:window:close'),
  debugToggleFloat: (isFloat: boolean) => ipcRenderer.send('debug:toggleFloat', isFloat),

  openBenchmarkWindow: () => ipcRenderer.send('open:benchmark-window'),
  benchmarkWindowMinimize: () => ipcRenderer.send('benchmark:window:minimize'),
  benchmarkWindowMaximize: () => ipcRenderer.send('benchmark:window:maximize'),
  benchmarkWindowClose: () => ipcRenderer.send('benchmark:window:close'),

  openRuleReviewWindow: () => ipcRenderer.send('open:rule-review-window'),
  ruleReviewWindowMinimize: () => ipcRenderer.send('rule-review:window:minimize'),
  ruleReviewWindowMaximize: () => ipcRenderer.send('rule-review:window:maximize'),
  ruleReviewWindowClose: () => ipcRenderer.send('rule-review:window:close'),

  storeSyncToDebug: (data: { storeId: string; state: Record<string, unknown> }) =>
    ipcRenderer.send('store:syncToDebug', data),

})
