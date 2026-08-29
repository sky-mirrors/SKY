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
  fileRead: (filePath: string, maxBytes?: number) => Promise<{ success: boolean; content?: string; error?: string; size?: number; isBinary?: boolean; encoding?: string }>
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
  createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  createDocx: (opts: { filePath: string; content?: string; title?: string }) => Promise<{ success: boolean; path?: string; error?: string }>
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
  }) => Promise<{
    success: boolean
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    chatFormat?: string
    error?: string
  }>
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
  openDebugWindow: () => void
  debugWindowMinimize: () => void
  debugWindowMaximize: () => void
  debugWindowClose: () => void
  debugToggleFloat: (isFloat: boolean) => void
  storeSyncToDebug: (data: { storeId: string; state: Record<string, unknown> }) => void
  ipcRendererSend: (channel: string, ...args: unknown[]) => void
}

interface Window {
  electronAPI: ElectronAPI
  requestIdleCallback?: (cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void, opts?: { timeout: number }) => number
  _holoStarMapDblClickCommand?: (command: string) => void
}
