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
  /** 2026-10-07（Wave 2）：递归文件检索（按名 / 按内容），只读 */
  fileSearch: (opts: { root: string; query: string; mode?: 'name' | 'content'; maxResults?: number }) => Promise<{ success: boolean; hits?: Array<{ path: string; name: string; line?: number; excerpt?: string }>; scanned?: number; truncated?: boolean; error?: string }>
  /** 2026-10-07（可用性补强 W1）：精确编辑（唯一子串替换），写类 */
  fileEdit: (opts: { filePath: string; oldString: string; newString: string; replaceAll?: boolean }) => Promise<{ success: boolean; replaced?: number; path?: string; error?: string }>
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
  /** 2026-10-07：新增**批量形态**（fromDir + ext? + toDir）—— 把目录下（可按扩展名过滤）的文件全部移入目标目录
   *  2026-10-08：ext 支持**扩展名集**（逗号分隔，如 'jpg,png'）；留空 = 目录下全部文件 */
  fileMove: (opts: { from?: string; to?: string; fromDir?: string; ext?: string; toDir?: string }) => Promise<{ success: boolean; from?: string; to?: string; error?: string; moved?: number; files?: string[]; failed?: string[]; toDir?: string }>
  /** 2026-09-30：复制文件（与 fileMove 同校验口径） */
  fileCopy: (opts: { from: string; to: string }) => Promise<{ success: boolean; from?: string; to?: string; error?: string }>
  /** 2026-10-08：按类型分拣（一个动作产出多个目录并按类型分派）—— 把 fromDir 顶层文件按类别搬进各自子目录；
   *  只搬文件不碰子目录；目标同名文件跳过不覆盖（可重复执行） */
  fileSortByType: (opts: { fromDir: string; toDir?: string }) => Promise<{ success: boolean; moved?: number; folders?: { name: string; dir: string; moved: string[] }[]; files?: string[]; failed?: string[]; fromDir?: string; error?: string }>
  /** 2026-10-08：解压并归类 —— fromDir 下的每个 .zip 解成一个同名子目录（目标已存在则跳过，不覆盖）；非 zip 进 unsupported 如实上报 */
  fileUnzip: (opts: { fromDir: string; toDir?: string }) => Promise<{ success: boolean; extracted?: { archive: string; dir: string; files: number }[]; skipped?: string[]; failed?: string[]; unsupported?: string[]; fromDir?: string; toDir?: string; error?: string }>
  /** 2026-10-08：批量改扩展名（**就地**，不挪窝）—— 目标已存在同名文件则跳过（不覆盖，可重复执行） */
  fileRenameExt: (opts: { fromDir: string; fromExt: string; toExt: string }) => Promise<{ success: boolean; renamed?: { from: string; to: string }[]; skipped?: string[]; failed?: string[]; fromDir?: string; error?: string }>
  createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
  createDocx: (opts: { filePath: string; content?: string; title?: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  docConvertToPdf: (opts: { source: string; target: string }) => Promise<{ success: boolean; path?: string; bytes?: number; title?: string; error?: string }>
  imageProcess: (opts: { inputs: string[]; op: Record<string, unknown>; outDir?: string; suffix?: string }) => Promise<{ success: boolean; outputs?: Array<{ from: string; to: string; bytes: number; width: number; height: number; format: string }>; failures?: Array<{ from: string; error: string }>; error?: string }>
  mediaProcess: (opts: { inputs: string[]; op: Record<string, unknown>; outDir?: string; suffix?: string }) => Promise<{ success: boolean; outputs?: Array<{ from: string; to: string; bytes: number }>; failures?: Array<{ from: string; error: string }>; probe?: { durationSec?: number; width?: number; height?: number; videoCodec?: string; audioCodec?: string }; error?: string }>
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
    // LLM-ABORT：关联 id——配合 llmAbort 可在途中止主进程 fetch
    requestId?: string
  }) => Promise<{
    success: boolean
    content?: string
    toolCalls?: Array<{ id: string; name: string; arguments: string }>
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number }
    chatFormat?: string
    error?: string
  }>
  // LLM-ABORT：按 requestId 取消在途的非流式 LLM 请求（「终止执行」→ 真正省下 Token）
  llmAbort: (requestId: string) => Promise<{ aborted: boolean }>
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
  // K-1：文档文本提取（PDF/DOCX/XLSX）——知识摄取不再用占位符假入库
  docExtractText: (opts: { name: string; data: Uint8Array }) => Promise<{ success: boolean; text?: string; error?: string }>
  /** 2026-09-30：按路径提取文档文本（PDF/DOCX/XLSX/XLS） */
  docExtractFromPath: (source: string) => Promise<{ success: boolean; text?: string; error?: string }>
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
  /** 2026-10-01：他窗 vault 写入广播（多窗口缓存一致性用） */
  onVaultChanged: (callback: (data: { namespace: string; key: string }) => void) => () => void
  openDebugWindow: () => void
  /** 2026-10-01 开发者端（合并窗口：调试中心 / 压测台 / 规则审核） */
  openDevWindow: () => void
  devWindowMinimize: () => void
  devWindowMaximize: () => void
  devWindowClose: () => void
  /** 2026-10-01 知识库独立窗口 */
  openKnowledgeWindow: () => void
  knowledgeWindowMinimize: () => void
  knowledgeWindowMaximize: () => void
  knowledgeWindowClose: () => void
  storeSyncToKnowledge: (data: { storeId: string; state: Record<string, unknown> }) => void
  knowledgeRequestSnapshot: () => void
  onKnowledgePushSnapshot: (callback: () => void) => () => void
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
}
