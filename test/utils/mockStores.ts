import { vi } from 'vitest'

export function createMockApiStore(responses: { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }[] = [{ content: 'mocked-llm-response' }]) {
  const queue = [...responses]
  return {
    config: {
      baseUrl: 'http://mock-llm.test',
      models: [{ id: 'mock-model', name: 'Mock Model' }],
      activeModel: 'mock-model',
      isReachable: true,
      lastCheckedAt: Date.now(),
      providers: [{
        id: 'mock-provider',
        name: 'Mock Provider',
        baseUrl: 'http://mock-llm.test',
        authType: 'bearer' as const,
        apiKey: 'test-key',
        modelsEndpoint: '/v1/models',
        chatFormat: 'openai' as const,
        models: [{ id: 'mock-model', name: 'Mock Model' }],
        isReachable: true,
        lastCheckedAt: Date.now()
      }],
      activeProviderId: 'mock-provider'
    },
    circuitBreaker: {
      isOpen: false,
      failureCount: 0,
      lastFailureAt: 0,
      cooldownMs: 30000,
      retryCount: 0,
      maxRetries: 3
    },
    isConfigured: true,
    hasActiveModel: true,
    isReady: true,
    isCircuitOpen: false,
    activeProvider: {
      id: 'mock-provider',
      name: 'Mock Provider',
      baseUrl: 'http://mock-llm.test',
      authType: 'bearer' as const,
      apiKey: 'test-key',
      modelsEndpoint: '/v1/models',
      chatFormat: 'openai' as const,
      models: [{ id: 'mock-model', name: 'Mock Model' }],
      isReachable: true,
      lastCheckedAt: Date.now()
    },
    gatewayAdapter: {
      chatCompletion: vi.fn().mockResolvedValue('mock-llm-text'),
      listModels: vi.fn().mockReturnValue([{ id: 'mock-model', name: 'Mock Model' }]),
      switchProvider: vi.fn(),
      switchModel: vi.fn(),
      getActiveProvider: vi.fn().mockReturnValue(null)
    },
    checkAndResetCircuitBreaker: vi.fn(),
    canMakeRequest: vi.fn().mockReturnValue(true),
    maybeResetCircuitBreaker: vi.fn(),
    addProvider: vi.fn().mockReturnValue('mock-provider-id'),
    removeProvider: vi.fn(),
    switchProvider: vi.fn(),
    pingProvider: vi.fn().mockResolvedValue(true),
    pingAllProviders: vi.fn().mockResolvedValue({ 'mock-provider': true }),
    setBaseUrl: vi.fn(),
    setModels: vi.fn(),
    setActiveModel: vi.fn(),
    setReachable: vi.fn(),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    resetCircuitBreaker: vi.fn(),
    checkConnection: vi.fn().mockResolvedValue(true),
    chatCompletion: vi.fn().mockImplementation(() => {
      const resp = queue.shift() || { content: 'default' }
      return Promise.resolve({
        ...resp,
        toolCalls: resp.toolCalls || [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cacheHitTokens: 0, cacheMissTokens: 10 }
      })
    }),
    chatCompletionStream: vi.fn().mockResolvedValue({ cancel: vi.fn() }),
    loadFromStorage: vi.fn().mockResolvedValue(undefined),
    saveToStorage: vi.fn().mockResolvedValue(undefined),
    detectDomain: vi.fn().mockReturnValue('general')
  }
}

export function createMockConfigStore() {
  return {
    config: {
      jobRole: 'general' as const,
      selectedL2Ids: [],
      firstLaunchDone: true,
      apiConfig: { baseUrl: '', models: [], activeModel: '', isReachable: false, lastCheckedAt: 0 },
      onboardingCompleted: false,
      apiConfigured: false,
      knowledgeFed: false,
      terminologyStyle: 'plain' as const,
      animationEnabled: true,
      dialogPanelWidth: 460,
      favoriteSkills: [],
      recentSkills: []
    },
    theme: 'dark' as const,
    isFirstLaunch: false,
    currentJobRole: 'general' as const,
    isLightTheme: false,
    isOnboardingComplete: false,
    terminologyStyle: 'plain' as const,
    animationEnabled: true,
    setJobRole: vi.fn(),
    addSelectedL2: vi.fn(),
    removeSelectedL2: vi.fn(),
    markFirstLaunchDone: vi.fn(),
    toggleTheme: vi.fn(),
    setUiMode: vi.fn(),
    toggleUiMode: vi.fn(),
    markOnboardingComplete: vi.fn(),
    resetOnboarding: vi.fn(),
    setApiConfigured: vi.fn(),
    setKnowledgeFed: vi.fn(),
    setTerminologyStyle: vi.fn(),
    setAnimationEnabled: vi.fn(),
    setStarmapNodeDensity: vi.fn(),
    setDialogPanelWidth: vi.fn(),
    addFavoriteSkill: vi.fn(),
    removeFavoriteSkill: vi.fn(),
    addRecentSkill: vi.fn(),
    clearRecentSkills: vi.fn(),
    loadFromStorage: vi.fn(),
    saveToStorage: vi.fn()
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

export function createMockMcpStore(tools: { id: string; name: string; callResult?: string }[] = []) {
  const connections = tools.map(t => ({
    id: t.id,
    name: t.id,
    url: 'http://localhost:8080',
    isConnected: true,
    tools: [{
      name: t.name,
      description: `Mock tool ${t.name}`,
      inputSchema: { type: 'object', properties: {} },
      isAutoAllowed: false,
      permission: 'readwrite' as const
    }],
    lastTestedAt: Date.now(),
    isWhitelisted: false,
    catalogId: undefined,
    catalogCommand: undefined,
    catalogArgs: undefined,
    catalogEnv: undefined
  }))
  return {
    connections,
    mcpToolsAsNodes: tools.map(t => ({ id: t.id, name: t.name, description: `Mock ${t.name}`, mcpId: t.id })),
    catalog: [],
    spawningId: null as string | null,
    spawningCatalogId: null as string | null,
    lastSpawnError: null as string | null,
    addConnection: vi.fn().mockReturnValue(connections[0]),
    removeConnection: vi.fn(),
    isCatalogItemInstalled: vi.fn().mockReturnValue(false),
    installFromCatalog: vi.fn().mockResolvedValue(connections[0]),
    startMcpFromCatalog: vi.fn().mockResolvedValue(true),
    stopMcpProcess: vi.fn().mockResolvedValue(undefined),
    refreshTools: vi.fn().mockResolvedValue(true),
    testConnection: vi.fn().mockResolvedValue(true),
    callTool: vi.fn().mockResolvedValue(tools[0]?.callResult || 'mock-mcp-result'),
    toggleToolAutoAllow: vi.fn(),
    setToolPermission: vi.fn(),
    setWhitelist: vi.fn(),
    loadFromStorage: vi.fn().mockResolvedValue(undefined),
    autoRestartCatalogMcp: vi.fn().mockResolvedValue(undefined)
  }
}

export function createMockNodeStore() {
  const mockNode = {
    id: 'test-node', name: 'Test Node', level: 'L1' as const,
    position: { x: 0, y: 0, z: 0 }, gridIndex: [0, 0, 0] as [number, number, number],
    description: 'A test node', enabled: true, locked: false
  }
  return {
    nodes: [mockNode],
    adjacency: new Map(),
    interaction: {
      hoveredNodeId: null, selectedNodeId: null, draggingNodeId: null,
      dragTargetLevel: null, isDragging: false, mouseSpeed: 0,
      onboardingPhase: 'waiting' as const, selectedRole: null,
      toolUseCount: 0, circuitBreaker: { isOpen: false, failureCount: 0, lastFailureAt: 0, cooldownMs: 30000, retryCount: 0, maxRetries: 3 },
      l0RedFlash: false, dialogMode: 'command' as const, ctrlKey: false
    },
    ingestProgress: { totalChunks: 0, processedChunks: 0, isRunning: false },
    l3DecayStates: [],
    degraded: { isDegraded: false, unavailableToolIds: [], reason: '' },
    history: [],
    flowActivePaths: [],
    connectionFlows: [],
    levelFilter: [],
    roleFilter: [],
    selectedNodeIds: [],
    l1WorkStatus: {},
    l1StatusTimers: {},
    l1FlashQueue: [],
    taskChainCompleteFlag: false,
    highlightedL2Ids: [],
    l2Manifests: {},
    dagChainState: { active: false, steps: [], dependsOnMap: {} },
    nodeVisualEvents: new Map(),
    sessionTokensSaved: 0,
    l0Node: mockNode,
    l1Nodes: [mockNode],
    l2Nodes: [],
    l3Nodes: [],
    filteredNodes: [mockNode],
    visibleNodeIds: new Set(['test-node']),
    selectedNode: null,
    hoveredNode: null,
    setL1Status: vi.fn(),
    getL1Status: vi.fn().mockReturnValue('idle'),
    consumeL1Flashes: vi.fn().mockReturnValue([]),
    markTaskChainComplete: vi.fn(),
    consumeTaskChainComplete: vi.fn().mockReturnValue(false),
    getNeighbors: vi.fn().mockReturnValue([]),
    selectNode: vi.fn(),
    hoverNode: vi.fn(),
    startDrag: vi.fn(),
    endDrag: vi.fn(),
    swapLevels: vi.fn(),
    lockL2Tool: vi.fn(),
    unlockL2Tool: vi.fn(),
    applyJobRoleTemplates: vi.fn(),
    setDegradedState: vi.fn(),
    setMouseSpeed: vi.fn(),
    isInteractionAllowed: vi.fn().mockReturnValue(true),
    setOnboardingPhase: vi.fn(),
    selectOnboardingRole: vi.fn(),
    incrementToolUseCount: vi.fn(),
    setIngestProgress: vi.fn(),
    initL3DecayStates: vi.fn(),
    reviveL3Node: vi.fn(),
    anchorL3Node: vi.fn(),
    setGravityWeight: vi.fn(),
    setNodeSchema: vi.fn(),
    validateSchema: vi.fn().mockReturnValue({ valid: true, errors: [] }),
    saveContextCache: vi.fn(),
    loadContextCache: vi.fn().mockReturnValue(null),
    clearContextCache: vi.fn(),
    addHistoryEntry: vi.fn(),
    loadHistory: vi.fn(),
    addFlowPath: vi.fn(),
    removeFlowPath: vi.fn(),
    setL0RedFlash: vi.fn(),
    updateCircuitBreaker: vi.fn(),
    addConnectionFlow: vi.fn(),
    removeConnectionFlow: vi.fn(),
    setConnectionFlowRunning: vi.fn(),
    setDialogMode: vi.fn(),
    toggleLevelFilter: vi.fn(),
    toggleRoleFilter: vi.fn(),
    clearFilters: vi.fn(),
    toggleNodeSelection: vi.fn(),
    clearNodeSelection: vi.fn(),
    addSelectedToDialog: vi.fn().mockReturnValue([]),
    highlightL2Candidates: vi.fn(),
    clearL2Highlights: vi.fn(),
    consumeL2Highlights: vi.fn().mockReturnValue([]),
    setDAGChain: vi.fn(),
    updateDAGStep: vi.fn(),
    clearDAGChain: vi.fn(),
    consumeDAGChainUpdate: vi.fn().mockReturnValue([]),
    loadL2Manifests: vi.fn(),
    getL2Manifest: vi.fn().mockReturnValue(null),
    getL2ManifestByName: vi.fn().mockReturnValue(null),
    getAllL2Manifests: vi.fn().mockReturnValue([]),
    findManifestByKeywords: vi.fn().mockReturnValue(null),
    emitNodeVisualEvent: vi.fn(),
    consumeNodeVisualEvent: vi.fn().mockReturnValue(null),
    getVisibleL2Ids: vi.fn().mockReturnValue([])
  }
}

export function createMockPipelineStore() {
  return {
    pipelines: [],
    runningPipelineId: null as string | null,
    currentStepIndex: 0,
    lastResults: null as Record<string, string> | null,
    lastError: null as string | null,
    activeDagPipelineId: null as string | null,
    createPipeline: vi.fn().mockReturnValue({
      id: 'mock-pipeline', name: 'Mock Pipeline', steps: [],
      mode: 'serial' as const, createdAt: Date.now(), attachedEntryIds: []
    }),
    removePipeline: vi.fn(),
    startPipeline: vi.fn().mockResolvedValue({}),
    advanceStep: vi.fn(),
    finishPipeline: vi.fn(),
    loadFromStorage: vi.fn(),
    saveToStorage: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    createPipelineKB: vi.fn().mockResolvedValue(undefined),
    addPipelineEntry: vi.fn(),
    removePipelineEntry: vi.fn(),
    addDagNode: vi.fn(),
    removeDagNode: vi.fn(),
    updateDagNode: vi.fn(),
    addDagEdge: vi.fn(),
    removeDagEdge: vi.fn(),
    setActiveDagPipeline: vi.fn()
  }
}

export function createMockSessionStore() {
  return {
    sessions: [],
    activeSessionId: null as string | null,
    createSession: vi.fn().mockReturnValue({
      id: 'mock-session', name: 'Mock Session', createdAt: Date.now(), updatedAt: Date.now(), messages: []
    }),
    switchSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    loadFromStorage: vi.fn(),
    saveToStorage: vi.fn()
  }
}

export function createMockKnowledgeStore() {
  return {
    knowledgeGroups: [],
    createGroup: vi.fn().mockReturnValue({ id: 'mock-group', name: 'Mock Group', sharedEntryIds: [], createdAt: Date.now(), updatedAt: Date.now() }),
    deleteGroup: vi.fn(),
    renameGroup: vi.fn(),
    addSharedEntryToGroup: vi.fn(),
    removeSharedEntryFromGroup: vi.fn(),
    getGroupProjects: vi.fn().mockReturnValue([]),
    saveGroupsToStorage: vi.fn(),
    loadFromStorage: vi.fn()
  }
}

export function createMockMemoryStore() {
  return {
    sessionMemory: { id: 'session-mock', createdAt: Date.now(), updatedAt: Date.now() },
    projectMemories: [],
    activeProjectId: null as string | null,
    globalMemory: { id: 'global', preferences: {}, promptTemplates: [], frequentTerms: [], updatedAt: Date.now() },
    mcpRequestLogs: [],
    auditLogs: [],
    conversations: [],
    memoryAdapter: {
      getRecent: vi.fn().mockReturnValue([]),
      addMessage: vi.fn(),
      summarizeOld: vi.fn().mockReturnValue('')
    },
    addDialogMessage: vi.fn(),
    clearSession: vi.fn(),
    archiveSession: vi.fn(),
    addProjectMemory: vi.fn().mockReturnValue({ id: 'mock-project', name: 'Mock Project', fileFingerprints: [], knowledgeEntryIds: [], vectorIndex: {}, updatedAt: Date.now() }),
    addFileFingerprint: vi.fn(),
    setProjectGroup: vi.fn(),
    addKnowledgeEntry: vi.fn(),
    getActiveProject: vi.fn().mockReturnValue(null),
    setActiveProject: vi.fn(),
    addPromptTemplate: vi.fn(),
    removePromptTemplate: vi.fn(),
    setPreference: vi.fn(),
    addFrequentTerm: vi.fn(),
    addMcpRequestLog: vi.fn(),
    addAuditLog: vi.fn(),
    exportAuditCsv: vi.fn().mockReturnValue(''),
    getOrCreateConversation: vi.fn().mockReturnValue({ id: 'mock-conv', projectId: 'mock-project', messages: [], fileFingerprints: [], updatedAt: Date.now() }),
    addConvMessage: vi.fn(),
    addConvFileFingerprint: vi.fn(),
    getRecentMessages: vi.fn().mockReturnValue([]),
    getContextWindow: vi.fn().mockReturnValue({ messages: [], summary: '' }),
    summarizeOld: vi.fn().mockReturnValue(''),
    loadFromStorage: vi.fn()
  }
}

export function createMockRuleStore() {
  return {
    rules: [],
    selectedRuleId: null as string | null,
    filterDomain: 'all' as const,
    filterStatus: 'all' as const,
    filterConfidence: 'all' as const,
    filteredRules: [],
    selectedRule: null,
    statsByDomain: {},
    loadRules: vi.fn(),
    selectRule: vi.fn(),
    setFilterDomain: vi.fn(),
    setFilterStatus: vi.fn(),
    setFilterConfidence: vi.fn(),
    changeRuleStatus: vi.fn().mockReturnValue(true),
    approveRule: vi.fn().mockReturnValue(true),
    markFalsePositive: vi.fn(),
    runTestOnRule: vi.fn().mockReturnValue(null),
    runAllTestCases: vi.fn().mockReturnValue({ passed: 0, failed: 0, results: [] }),
    runDomainConstraints: vi.fn().mockReturnValue([]),
    validateRule: vi.fn().mockReturnValue({ valid: true, errors: [], passedTests: 0, failedTests: 0 }),
    validateAll: vi.fn().mockReturnValue({ total: 0, valid: 0, invalid: 0, details: [] })
  }
}

export function createMockSkillStore() {
  return {
    installedSkills: [],
    catalog: [],
    installSkill: vi.fn().mockReturnValue({ success: true, missing: [] }),
    uninstallSkill: vi.fn(),
    isCatalogItemInstalled: vi.fn().mockReturnValue(false),
    installFromCatalog: vi.fn().mockReturnValue({ success: true, missing: [] }),
    exportSkill: vi.fn().mockReturnValue(null),
    importSkill: vi.fn().mockReturnValue({ success: true, missing: [] }),
    createSkillFromWorkflow: vi.fn().mockReturnValue({
      id: 'mock-skill', name: 'Mock Skill', description: '', version: '1.0',
      nodes: [], edges: [], dependencies: [], author: 'test', createdAt: Date.now(),
      isInstalled: true, isFromMarket: false
    }),
    isDependencyMet: vi.fn().mockReturnValue(true),
    saveToStorage: vi.fn(),
    loadFromStorage: vi.fn()
  }
}

export function createMockWorkflowLogStore() {
  return {
    logs: [],
    createLog: vi.fn().mockReturnValue({
      id: 'mock-log', name: 'Mock Log', nodes: [], edges: [], timestamps: [],
      ioSnapshots: [], startedAt: Date.now(), completedAt: 0, status: 'running' as const
    }),
    updateNodeStatus: vi.fn(),
    addIoSnapshot: vi.fn(),
    activateEdge: vi.fn(),
    completeLog: vi.fn(),
    getLog: vi.fn().mockReturnValue(undefined),
    loadFromStorage: vi.fn()
  }
}

export function createMockNotificationStore() {
  return {
    notifications: [],
    settings: {
      auditBlock: true,
      apiDegrade: true,
      toolComplete: true,
      toolFail: true,
      cacheHit: false,
      knowledgeIngest: true,
      storageWarning: true,
      popupDuration: 2000
    },
    unreadCount: 0,
    highPriorityUnread: [],
    activeNotifications: [],
    addNotification: vi.fn().mockReturnValue(null),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
    processAutoRead: vi.fn(),
    expireOld: vi.fn(),
    updateSettings: vi.fn(),
    isTypeEnabled: vi.fn().mockReturnValue(true),
    loadFromStorage: vi.fn(),
    saveToStorage: vi.fn()
  }
}

export function createAllMockStores() {
  return {
    api: createMockApiStore(),
    config: createMockConfigStore(),
    debug: createMockDebugStore(),
    dialog: createMockDialogStore(),
    feedback: createMockFeedbackStore(),
    mcp: createMockMcpStore(),
    node: createMockNodeStore(),
    pipeline: createMockPipelineStore(),
    session: createMockSessionStore(),
    knowledge: createMockKnowledgeStore(),
    memory: createMockMemoryStore(),
    rule: createMockRuleStore(),
    skill: createMockSkillStore(),
    workflowLog: createMockWorkflowLogStore(),
    notification: createMockNotificationStore()
  }
}
