import { vi } from 'vitest'

export function createMockMcpStore(tools: { id: string; name: string; callResult?: string }[] = []) {
  const connections = tools.map(t => ({
    id: t.id,
    name: t.id,
    isConnected: true,
    tools: [{ name: t.name, description: `Mock tool ${t.name}`, inputSchema: { type: 'object', properties: {} } }],
    config: {},
    status: 'connected' as const
  }))
  return {
    connections,
    callTool: vi.fn().mockResolvedValue('mock-mcp-result'),
    mcpToolsAsNodes: []
  }
}

export function createMockApiStore(responses: { content: string }[] = [{ content: 'mocked-llm-response' }]) {
  const queue = [...responses]
  return {
    config: { activeModel: 'mock-model', activeProviderId: 'mock', isReachable: true, baseUrl: 'http://mock', providers: [], models: [] },
    isReady: true,
    isCircuitOpen: false,
    chatCompletion: vi.fn().mockImplementation(() => {
      const resp = queue.shift() || { content: 'default' }
      return Promise.resolve({ ...resp, toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })
    }),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn()
  }
}

export function createMockDebugStore() {
  return {
    enabled: false,
    emitEvent: vi.fn(),
    recordProbe: vi.fn(),
    registerAbortController: vi.fn(),
    clearAbortController: vi.fn()
  }
}

export function createMockDialogStore() {
  return {
    dagPaused: false,
    dagPausedStep: null as number | null,
    awaitingTakeover: false,
    takeoverStepNum: null as number | null,
    addSystemNotice: vi.fn(),
    requestRiskConfirm: vi.fn().mockResolvedValue(true),
    requestTakeover: vi.fn().mockResolvedValue('takeover-result'),
    clearAllPausePoints: vi.fn()
  }
}

export function createMockFeedbackStore() {
  return {
    addSideEffectManifest: vi.fn(),
    recordFeedback: vi.fn(),
    getWeightModifier: vi.fn().mockReturnValue(0)
  }
}

export function createMockElectronAPI(overrides: Record<string, unknown> = {}) {
  return {
    shellExec: vi.fn().mockResolvedValue({ success: true, stdout: 'mock-shell-output', stderr: '', code: 0 }),
    fileRead: vi.fn().mockResolvedValue({ success: true, content: 'mock-file-content', size: 100, isBinary: false, encoding: 'utf-8' }),
    httpFetch: vi.fn().mockResolvedValue({ success: true, status: 200, body: 'mock-http-body' }),
    storeRead: vi.fn().mockResolvedValue(null),
    storeWrite: vi.fn().mockResolvedValue(undefined),
    safeStorageIsAvailable: vi.fn().mockResolvedValue(false),
    safeStorageEncrypt: vi.fn().mockResolvedValue(null),
    safeStorageDecrypt: vi.fn().mockResolvedValue(null),
    ...overrides
  }
}
