import { vi } from 'vitest'

export interface MockElectronAPI {
  platform: string
  openFile: ReturnType<typeof vi.fn>
  openDirectory: ReturnType<typeof vi.fn>
  getVersion: ReturnType<typeof vi.fn>
  getPlatform: ReturnType<typeof vi.fn>
  appHealth: ReturnType<typeof vi.fn>
  windowMinimize: ReturnType<typeof vi.fn>
  windowMaximize: ReturnType<typeof vi.fn>
  windowClose: ReturnType<typeof vi.fn>
  mcpSpawn: ReturnType<typeof vi.fn>
  mcpCallTool: ReturnType<typeof vi.fn>
  mcpListTools: ReturnType<typeof vi.fn>
  mcpStop: ReturnType<typeof vi.fn>
  mcpGetStatus: ReturnType<typeof vi.fn>
  onMcpStatus: ReturnType<typeof vi.fn>
  onMcpTools: ReturnType<typeof vi.fn>
  shellExec: ReturnType<typeof vi.fn>
  openFilePath: ReturnType<typeof vi.fn>
  safeStorageEncrypt: ReturnType<typeof vi.fn>
  safeStorageDecrypt: ReturnType<typeof vi.fn>
  safeStorageIsAvailable: ReturnType<typeof vi.fn>
  storeRead: ReturnType<typeof vi.fn>
  storeWrite: ReturnType<typeof vi.fn>
  storeDelete: ReturnType<typeof vi.fn>
  vectorReadBin: ReturnType<typeof vi.fn>
  vectorWriteBin: ReturnType<typeof vi.fn>
  vectorListKeys: ReturnType<typeof vi.fn>
  fileRead: ReturnType<typeof vi.fn>
  fileWrite: ReturnType<typeof vi.fn>
  createDirectory: ReturnType<typeof vi.fn>
  createDocx: ReturnType<typeof vi.fn>
  httpFetch: ReturnType<typeof vi.fn>
  backupCreate: ReturnType<typeof vi.fn>
  backupRestore: ReturnType<typeof vi.fn>
  backupList: ReturnType<typeof vi.fn>
  watchfsSetDir: ReturnType<typeof vi.fn>
  watchfsGetDir: ReturnType<typeof vi.fn>
  onWatchfsChanged: ReturnType<typeof vi.fn>
  onGlobalQuickInput: ReturnType<typeof vi.fn>
  openPipelineWindow: ReturnType<typeof vi.fn>
  pipelineAddNode: ReturnType<typeof vi.fn>
  pipelineWindowMinimize: ReturnType<typeof vi.fn>
  pipelineWindowMaximize: ReturnType<typeof vi.fn>
  pipelineWindowClose: ReturnType<typeof vi.fn>
  pipelineToggleFloat: ReturnType<typeof vi.fn>
  onPipelineNodeAdded: ReturnType<typeof vi.fn>
  storeSyncToPipeline: ReturnType<typeof vi.fn>
  storeSyncToMain: ReturnType<typeof vi.fn>
  storeSyncToDebug: ReturnType<typeof vi.fn>
  onStoreApplyUpdate: ReturnType<typeof vi.fn>
  llmChatCompletion: ReturnType<typeof vi.fn>
  llmChatCompletionStream: ReturnType<typeof vi.fn>
  llmListModels: ReturnType<typeof vi.fn>
  knowledgeIngest: ReturnType<typeof vi.fn>
  knowledgeSearch: ReturnType<typeof vi.fn>
  knowledgeListEntries: ReturnType<typeof vi.fn>
  resolvePath: ReturnType<typeof vi.fn>
  openDebugWindow: ReturnType<typeof vi.fn>
  debugWindowMinimize: ReturnType<typeof vi.fn>
  debugWindowMaximize: ReturnType<typeof vi.fn>
  debugWindowClose: ReturnType<typeof vi.fn>
  debugToggleFloat: ReturnType<typeof vi.fn>
  openBenchmarkWindow: ReturnType<typeof vi.fn>
  benchmarkWindowMinimize: ReturnType<typeof vi.fn>
  benchmarkWindowMaximize: ReturnType<typeof vi.fn>
  benchmarkWindowClose: ReturnType<typeof vi.fn>
  openRuleReviewWindow: ReturnType<typeof vi.fn>
  ruleReviewWindowMinimize: ReturnType<typeof vi.fn>
  ruleReviewWindowMaximize: ReturnType<typeof vi.fn>
  ruleReviewWindowClose: ReturnType<typeof vi.fn>
}

export function createFullMockElectronAPI(overrides: Partial<MockElectronAPI> = {}): MockElectronAPI {
  const noop = () => {}
  const noopReturn = () => Promise.resolve(undefined)

  const api: MockElectronAPI = {
    platform: 'win32',

    openFile: vi.fn(noopReturn),
    openDirectory: vi.fn(noopReturn),
    getVersion: vi.fn().mockResolvedValue('1.0.0-test'),
    getPlatform: vi.fn().mockResolvedValue('win32'),
    appHealth: vi.fn().mockResolvedValue({ ok: true }),

    windowMinimize: vi.fn(noop),
    windowMaximize: vi.fn(noop),
    windowClose: vi.fn(noop),

    mcpSpawn: vi.fn().mockResolvedValue({ success: true }),
    mcpCallTool: vi.fn().mockResolvedValue('mock-mcp-tool-result'),
    mcpListTools: vi.fn().mockResolvedValue([]),
    mcpStop: vi.fn().mockResolvedValue(undefined),
    mcpGetStatus: vi.fn().mockResolvedValue({ status: 'connected' }),

    onMcpStatus: vi.fn().mockReturnValue(noop),
    onMcpTools: vi.fn().mockReturnValue(noop),

    shellExec: vi.fn().mockResolvedValue({ success: true, stdout: 'mock-shell-output', stderr: '', code: 0 }),
    openFilePath: vi.fn().mockResolvedValue(undefined),

    safeStorageEncrypt: vi.fn().mockResolvedValue('mock-encrypted'),
    safeStorageDecrypt: vi.fn().mockResolvedValue('mock-decrypted'),
    safeStorageIsAvailable: vi.fn().mockResolvedValue(false),

    storeRead: vi.fn().mockResolvedValue(null),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    storeDelete: vi.fn().mockResolvedValue(undefined),

    vectorReadBin: vi.fn().mockResolvedValue(null),
    vectorWriteBin: vi.fn().mockResolvedValue(undefined),
    vectorListKeys: vi.fn().mockResolvedValue([]),

    fileRead: vi.fn().mockResolvedValue({ success: true, content: 'mock-file-content', size: 100, isBinary: false, encoding: 'utf-8' }),
    fileWrite: vi.fn().mockResolvedValue({ success: true }),
    createDirectory: vi.fn().mockResolvedValue({ success: true }),
    createDocx: vi.fn().mockResolvedValue({ success: true }),

    httpFetch: vi.fn().mockResolvedValue({ success: true, status: 200, body: 'mock-http-body' }),

    backupCreate: vi.fn().mockResolvedValue({ success: true }),
    backupRestore: vi.fn().mockResolvedValue({ success: true }),
    backupList: vi.fn().mockResolvedValue([]),

    watchfsSetDir: vi.fn().mockResolvedValue(undefined),
    watchfsGetDir: vi.fn().mockResolvedValue(null),
    onWatchfsChanged: vi.fn().mockReturnValue(noop),
    onGlobalQuickInput: vi.fn().mockReturnValue(noop),

    openPipelineWindow: vi.fn(noop),
    pipelineAddNode: vi.fn(noop),
    pipelineWindowMinimize: vi.fn(noop),
    pipelineWindowMaximize: vi.fn(noop),
    pipelineWindowClose: vi.fn(noop),
    pipelineToggleFloat: vi.fn(noop),
    onPipelineNodeAdded: vi.fn().mockReturnValue(noop),

    storeSyncToPipeline: vi.fn(noop),
    storeSyncToMain: vi.fn(noop),
    storeSyncToDebug: vi.fn(noop),
    onStoreApplyUpdate: vi.fn().mockReturnValue(noop),

    llmChatCompletion: vi.fn().mockResolvedValue({
      content: 'mock-llm-response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
    }),
    llmChatCompletionStream: vi.fn().mockReturnValue(noop),
    llmListModels: vi.fn().mockResolvedValue([]),

    knowledgeIngest: vi.fn().mockResolvedValue({ success: true, entryId: 'mock-entry-id' }),
    knowledgeSearch: vi.fn().mockResolvedValue([]),
    knowledgeListEntries: vi.fn().mockResolvedValue([]),

    resolvePath: vi.fn().mockResolvedValue('C:\\Users\\Test\\resolved-path'),

    openDebugWindow: vi.fn(noop),
    debugWindowMinimize: vi.fn(noop),
    debugWindowMaximize: vi.fn(noop),
    debugWindowClose: vi.fn(noop),
    debugToggleFloat: vi.fn(noop),

    openBenchmarkWindow: vi.fn(noop),
    benchmarkWindowMinimize: vi.fn(noop),
    benchmarkWindowMaximize: vi.fn(noop),
    benchmarkWindowClose: vi.fn(noop),

    openRuleReviewWindow: vi.fn(noop),
    ruleReviewWindowMinimize: vi.fn(noop),
    ruleReviewWindowMaximize: vi.fn(noop),
    ruleReviewWindowClose: vi.fn(noop),

    dataExportZip: vi.fn().mockResolvedValue({ success: true, filePath: '/mock/export.json' }),
    dataImportZip: vi.fn().mockResolvedValue({ success: true, content: '{}', filePath: '/mock/import.json' }),
    getUserDataPath: vi.fn().mockResolvedValue('/mock/userData'),
  }

  return { ...api, ...overrides } as MockElectronAPI
}

export function installMockElectronAPI(overrides: Partial<MockElectronAPI> = {}): MockElectronAPI {
  const api = createFullMockElectronAPI(overrides)
  ;(globalThis as Record<string, unknown>).window = { electronAPI: api }
  return api
}

export function removeMockElectronAPI(): void {
  delete (globalThis as Record<string, unknown>).window
}
