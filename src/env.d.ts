/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ElectronAPI {
  platform: string
  openFile: (options?: {
    filters?: { name: string; extensions: string[] }[]
    title?: string
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
  openDirectory: (options?: { title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>
  getVersion: () => Promise<string>
  shellExec: (opts: { command: string; cwd?: string; timeout?: number; env?: Record<string, string> }) => Promise<{ success: boolean; code: number; stdout: string; stderr: string }>
  safeStorageEncrypt: (text: string) => Promise<string | null>
  safeStorageDecrypt: (encrypted: string) => Promise<string | null>
  safeStorageIsAvailable: () => Promise<boolean>
  storeRead: (key: string) => Promise<unknown | null>
  storeWrite: (key: string, value: unknown) => Promise<boolean>
  storeDelete: (key: string) => Promise<boolean>
  vectorReadBin: (key: string) => Promise<ArrayBuffer | Uint8Array | null>
  vectorWriteBin: (key: string, base64Data: string) => Promise<boolean>
  vectorListKeys: () => Promise<string[]>
  vectorDeleteBin: (key: string) => Promise<boolean>
  fileRead: (filePath: string, maxBytes?: number) => Promise<{ success: boolean; content?: string; error?: string; size?: number; isBinary?: boolean; encoding?: string }>
  fileList: (dirPath: string) => Promise<{ success: boolean; entries?: string[]; entriesWithMeta?: Array<{ name: string; isDir: boolean; mtimeMs: number; mtimeIso: string | null; shootDateIso?: string | null; shootDateTag?: string | null }>; error?: string }>
  httpFetch: (opts: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number }) => Promise<{ success: boolean; status: number; headers?: Record<string, string>; body?: string; error?: string }>
  backupCreate: () => Promise<{ success: boolean; path?: string; error?: string }>
  backupRestore: () => Promise<{ success: boolean; message?: string; error?: string }>
  backupList: () => Promise<{ name: string; path: string; size: number; createdAt: number }[]>
  watchfsSetDir: (dirPath: string | null) => Promise<{ success: boolean; error?: string }>
  watchfsGetDir: () => Promise<string | null>
  onWatchfsChanged: (callback: (data: { event: string; filename: string; path: string }) => void) => () => void
  onGlobalQuickInput: (callback: () => void) => () => void
  openPipelineWindow: () => void
  pipelineAddNode: (nodeData: { toolId: string; toolName: string; toolLevel: string }) => void
  pipelineWindowMinimize: () => void
  pipelineWindowMaximize: () => void
  pipelineWindowClose: () => void
  pipelineToggleFloat: (isFloat: boolean) => void
  onPipelineNodeAdded: (callback: (data: { toolId: string; toolName: string; toolLevel: string }) => void) => () => void
  pipelineRunRequest: (data: { nodes: { id: string; toolId: string; toolName: string; params: Record<string, string>; outputKey: string }[]; edges: unknown[] }) => void
  onPipelineRunEvent: (callback: (data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) => void) => () => void
  onPipelineRunRequest: (callback: (data: { nodes: { id: string; toolId: string; toolName: string; params: Record<string, string>; outputKey: string }[]; edges: unknown[] }) => void) => () => void
  pipelineRunProgress: (data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) => void
  storeSyncToPipeline: (data: { storeId: string; state: Record<string, unknown> }) => void
  storeSyncToMain: (data: { storeId: string; state: Record<string, unknown> }) => void
  onStoreApplyUpdate: (callback: (data: { storeId: string; state: Record<string, unknown> }) => void) => () => void
  mcpSpawn: (opts: { id: string; command: string; args: string[]; env: Record<string, string> }) => Promise<{ success: boolean; tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[]; error?: string }>
  mcpCallTool: (opts: { id: string; toolName: string; args: Record<string, unknown> }) => Promise<{ success: boolean; result?: unknown; error?: string }>
  mcpListTools: (opts: { id: string }) => Promise<{ success: boolean; tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[]; error?: string }>
  mcpStop: (opts: { id: string }) => Promise<{ success: boolean; error?: string }>
  mcpGetStatus: (opts: { id: string }) => Promise<{ status: string; tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[] }>
  onMcpStatus: (callback: (data: { id: string; status: string; error?: string; initResult?: unknown }) => void) => () => void
  onMcpTools: (callback: (data: { id: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }) => void) => () => void
  fileWrite: (opts: { filePath: string; content: string; encoding?: BufferEncoding }) => Promise<{ success: boolean; path?: string; error?: string }>
  fileMove: (opts: { from: string; to: string }) => Promise<{ success: boolean; from?: string; to?: string; error?: string }>
  createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  createDocx: (opts: { filePath: string; content?: string; title?: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  docConvertToPdf: (opts: { source: string; target: string }) => Promise<{ success: boolean; path?: string; bytes?: number; title?: string; error?: string }>
  imageProcess: (opts: { inputs: string[]; op: Record<string, unknown>; outDir?: string; suffix?: string }) => Promise<{ success: boolean; outputs?: Array<{ from: string; to: string; bytes: number; width: number; height: number; format: string }>; failures?: Array<{ from: string; error: string }>; error?: string }>
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  getPlatform: () => Promise<string>
  appHealth: () => Promise<{ status: string; timestamp: number }>
  llmChatCompletion: (opts: {
    providerId: string
    model: string
    messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    maxTokens?: number
    temperature?: number
  }) => Promise<{
    success: boolean
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number }
    chatFormat?: string
    error?: string
  }>
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
      onDone: (final: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number } }) => void
      onError: (err: string) => void
    }
  ) => () => void
  llmListModels: (opts: { providerId: string }) => Promise<{
    success: boolean
    models?: Array<{ id: string; name: string; providerId?: string }>
    error?: string
  }>
  knowledgeIngest: (opts: { filename: string; content: string; fileType?: string }) => Promise<{ success: boolean; entry?: unknown; error?: string }>
  knowledgeSearch: (opts: { query: string; topK?: number }) => Promise<{ success: boolean; results?: { text: string; score: number }[]; error?: string }>
  knowledgeListEntries: () => Promise<{ success: boolean; entries?: unknown[]; error?: string }>
  resolvePath: (template: string) => Promise<string>
  openFilePath: (filePath: string) => Promise<{ success: boolean; error?: string }>
  dataExportZip: (opts: { data: string; defaultName: string }) => Promise<{ success: boolean; filePath?: string; error?: string }>
  dataImportZip: () => Promise<{ success: boolean; content?: string; filePath?: string; error?: string }>
  getUserDataPath: () => Promise<string>
  // B-8：vault 四件套此前 exposed-but-undeclared（vector/migrate/stats 六个死通道已随 B-6 删除）
  vaultRead: (namespace: string, key: string) => Promise<string | null>
  vaultWrite: (namespace: string, key: string, value: string, encrypted?: boolean) => Promise<void>
  vaultDelete: (namespace: string, key: string) => Promise<void>
  vaultList: (namespace?: string) => Promise<string[]>
  openDebugWindow: () => void
  openBenchmarkWindow: () => void
  openRuleReviewWindow: () => void
  debugWindowMinimize: () => void
  debugWindowMaximize: () => void
  debugWindowClose: () => void
  benchmarkWindowMinimize: () => void
  benchmarkWindowMaximize: () => void
  benchmarkWindowClose: () => void
  ruleReviewWindowMinimize: () => void
  ruleReviewWindowMaximize: () => void
  ruleReviewWindowClose: () => void
  debugToggleFloat: (isFloat: boolean) => void
  storeSyncToDebug: (data: { storeId: string; state: Record<string, unknown> }) => void
}

interface Window {
  electronAPI: ElectronAPI
  requestIdleCallback?: (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void, opts?: { timeout: number }) => number
  _holoStarMapDblClickCommand?: (command: string) => void
}
