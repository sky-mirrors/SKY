import { vi } from 'vitest'

export function createMockPromptTranslator() {
  return {
    searchTaskCases: vi.fn().mockReturnValue([]),
    saveTaskCase: vi.fn(),
    disambiguateChoice: vi.fn().mockResolvedValue(null),
    translateIntent: vi.fn().mockResolvedValue(null),
    planTask: vi.fn().mockResolvedValue({ steps: [], estimatedTier: 'standard', requiresDisambiguation: false }),
    replan: vi.fn().mockResolvedValue([]),
    reflectOnResult: vi.fn().mockReturnValue({ satisfied: true, missingSteps: [], suggestion: '' }),
    compileToChain: vi.fn().mockResolvedValue({ chain: [], totalSteps: 0, estimatedTokens: 0 })
  }
}

export function createMockRuleEngine() {
  return {
    runRuleEngine: vi.fn().mockReturnValue({ matched: false, output: '', tags: [] }),
    buildRuleContext: vi.fn().mockReturnValue({})
  }
}

export function createMockPipelineExecutor() {
  return {
    registerHandler: vi.fn(),
    getHandler: vi.fn().mockReturnValue(undefined),
    getAllHandlers: vi.fn().mockReturnValue([]),
    executePipeline: vi.fn().mockResolvedValue({})
  }
}

export function createMockEmbedder() {
  const pseudoVector = new Array(384).fill(0).map(() => Math.random() * 0.1)
  return {
    getEmbedder: vi.fn().mockResolvedValue({ embed: vi.fn().mockResolvedValue(pseudoVector) }),
    isEmbedderReady: vi.fn().mockReturnValue(false),
    generatePseudoVector: vi.fn().mockReturnValue(pseudoVector),
    generateVector: vi.fn().mockResolvedValue(pseudoVector),
    cosineSimilarity: vi.fn().mockReturnValue(0.95),
    needsReembedding: vi.fn().mockReturnValue(false)
  }
}

export function createMockKnowledgeBase() {
  return {
    initEmbedder: vi.fn().mockResolvedValue(true),
    isEmbedderReady: vi.fn().mockReturnValue(false),
    getKnowledgeEntries: vi.fn().mockReturnValue([]),
    ingestFile: vi.fn().mockResolvedValue({ id: 'mock-entry', text: 'mock', vector: [], tokens: 0, source: 'test.txt', createdAt: Date.now() }),
    ingestText: vi.fn().mockResolvedValue({ id: 'mock-entry', text: 'mock', vector: [], tokens: 0, source: 'inline', createdAt: Date.now() }),
    searchKnowledge: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    getEntry: vi.fn().mockReturnValue(null),
    deleteKnowledgeEntry: vi.fn().mockResolvedValue(true),
    getEntriesByOwner: vi.fn().mockReturnValue([]),
    searchKnowledgeInGroup: vi.fn().mockResolvedValue([]),
    knowledgeAdapter: {
      ingestFile: vi.fn().mockResolvedValue({ id: 'mock-entry' }),
      search: vi.fn().mockResolvedValue([]),
      getEntry: vi.fn().mockReturnValue(null)
    }
  }
}

export function createMockVectorStore() {
  return {
    saveChunksToFile: vi.fn().mockResolvedValue(true),
    loadChunksFromFile: vi.fn().mockResolvedValue(null),
    listVectorEntries: vi.fn().mockResolvedValue([]),
    migrateFromLocalStorage: vi.fn().mockResolvedValue(0)
  }
}

export function createMockConvMemory() {
  return {
    indexConversationRound: vi.fn().mockResolvedValue(undefined),
    searchConversationContext: vi.fn().mockResolvedValue([]),
    getLatestSummary: vi.fn().mockReturnValue(''),
    savePeriodSummary: vi.fn(),
    getAllSummaries: vi.fn().mockReturnValue(''),
    shouldCompress: vi.fn().mockReturnValue(false),
    detectChallenge: vi.fn().mockReturnValue(false),
    clearConvMemory: vi.fn()
  }
}

export function createMockDagCheckpoint() {
  return {
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
    removeCheckpoint: vi.fn().mockResolvedValue(undefined),
    getCheckpoint: vi.fn().mockResolvedValue(null),
    getIncompleteCheckpoints: vi.fn().mockResolvedValue([]),
    getAllCheckpoints: vi.fn().mockResolvedValue([]),
    pruneExpired: vi.fn().mockResolvedValue(0),
    createCheckpointId: vi.fn().mockReturnValue('cp-mock-id')
  }
}

export function createMockProactiveScheduler() {
  return {
    loadPersistedState: vi.fn(),
    logManifestUsage: vi.fn()
  }
}

export function createMockSecureStore() {
  const store = new Map<string, unknown>()
  return {
    storeGet: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    storeSet: vi.fn().mockImplementation((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(true) }),
    storeDelete: vi.fn().mockImplementation((key: string) => { store.delete(key); return Promise.resolve(true) }),
    migrateFromLocalStorage: vi.fn().mockResolvedValue(0)
  }
}

export function createMockResultBeautifier() {
  return {
    parseMarkdownAstWithRanges: vi.fn().mockReturnValue({ type: 'root', children: [] }),
    renderToHtml: vi.fn().mockReturnValue('<p>mock html</p>'),
    renderToEmailHtml: vi.fn().mockReturnValue('<p>mock email html</p>'),
    beautify: vi.fn().mockReturnValue('<p>mock beautified</p>')
  }
}

export function createMockDebugLog() {
  return {
    debugLog: vi.fn()
  }
}

export function createMockMemory() {
  return {
    getConversations: vi.fn().mockReturnValue([]),
    getOrCreateConversation: vi.fn().mockReturnValue({ id: 'mock-conv', projectId: 'mock', messages: [], fileFingerprints: [], updatedAt: Date.now() }),
    addMessage: vi.fn(),
    addFileFingerprint: vi.fn(),
    getRecentMessages: vi.fn().mockReturnValue([]),
    getContextWindow: vi.fn().mockReturnValue({ messages: [], summary: '' }),
    summarizeOld: vi.fn().mockReturnValue(''),
    memoryAdapter: {
      getRecent: vi.fn().mockReturnValue([]),
      addMessage: vi.fn(),
      summarizeOld: vi.fn().mockReturnValue('')
    }
  }
}

export function createMockHash() {
  return {
    contentHash: vi.fn().mockReturnValue('mock-hash-a1b2c3')
  }
}

export function createMockErrorClassifier() {
  return {
    classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'abort' }),
    classifyErrorForUser: vi.fn().mockReturnValue('An unknown error occurred')
  }
}

export function createMockConstraintFeedback() {
  return {
    recordFeedback: vi.fn(),
    getFeedbackLog: vi.fn().mockReturnValue([]),
    getFeedbackForConstraint: vi.fn().mockReturnValue([]),
    calculateFalsePositiveRate: vi.fn().mockReturnValue(0),
    calculateStatsForConstraint: vi.fn().mockReturnValue({ total: 0, falsePositives: 0, truePositives: 0, falsePositiveRate: 0 }),
    processConstraintResults: vi.fn().mockReturnValue([]),
    clearFeedbackLog: vi.fn()
  }
}

export function createMockCrossDocValidator() {
  return {
    extractEntitiesFromDocuments: vi.fn().mockReturnValue([]),
    findCrossDocumentConflicts: vi.fn().mockReturnValue([]),
    runCrossDocValidation: vi.fn().mockReturnValue({ conflicts: [], entityCount: 0 })
  }
}

export function createMockDomainConstraints() {
  return {
    getAllConstraints: vi.fn().mockReturnValue([]),
    getConstraintsByDomain: vi.fn().mockReturnValue([]),
    getConstraintsByAutomationLevel: vi.fn().mockReturnValue([]),
    getActiveConstraints: vi.fn().mockReturnValue([]),
    getConstraintById: vi.fn().mockReturnValue(null),
    updateConstraintStatus: vi.fn(),
    approveConstraint: vi.fn(),
    recordConstraintTrigger: vi.fn(),
    runConstraints: vi.fn().mockReturnValue([]),
    validateConstraintTestCases: vi.fn().mockReturnValue({ passed: 0, failed: 0 }),
    validateAllConstraints: vi.fn().mockReturnValue({ total: 0, valid: 0, invalid: 0 })
  }
}

export function createMockDualEngineValidator() {
  return {
    shouldValidate: vi.fn().mockReturnValue(true),
    isPathUnsafe: vi.fn().mockReturnValue(false),
    isUrlUnsafe: vi.fn().mockReturnValue(false),
    buildActionManifest: vi.fn().mockReturnValue({ actions: [], riskLevel: 'low' }),
    dualEngineValidate: vi.fn().mockResolvedValue({ approved: true, riskLevel: 'low', violations: [] })
  }
}

export function createMockFactGuard() {
  return {
    shouldTrigger: vi.fn().mockReturnValue(false),
    runFactGuardV2: vi.fn().mockReturnValue({ triggered: false, inconsistencies: [], riskLevel: 'low' })
  }
}

export function createMockFileContext() {
  return {
    getFileContext: vi.fn().mockReturnValue({ activeFile: null, recentFiles: [], boostedIds: [] }),
    getFileBoostForItem: vi.fn().mockReturnValue(0),
    setActiveFile: vi.fn(),
    initFileContextWatch: vi.fn(),
    destroyFileContextWatch: vi.fn()
  }
}

export function createMockL0SkillRouter() {
  return {
    classifyDomain: vi.fn().mockReturnValue('general'),
    tryL0Skill: vi.fn().mockReturnValue(null),
    tryL05QuickMatch: vi.fn().mockReturnValue(null),
    checkL1Capability: vi.fn().mockReturnValue(false),
    buildExplorePlan: vi.fn().mockReturnValue([])
  }
}

export function createMockMacroExecutor() {
  return {
    callToolDirectWithTier: vi.fn().mockResolvedValue('mock-tool-result'),
    extractStepResult: vi.fn().mockReturnValue('mock-step-result'),
    resolveParams: vi.fn().mockReturnValue({}),
    evaluateCondition: vi.fn().mockReturnValue(true),
    executeStep: vi.fn().mockResolvedValue({ output: 'mock-step-output', lineage: { stepNum: 0, toolId: 'test', tier: 'standard', inputHash: '', outputHash: '', tokensUsed: 0, cacheHit: false, durationMs: 0 } }),
    executeMacro: vi.fn().mockResolvedValue({ output: 'mock-macro-output', lineage: [] }),
    resolveDirectPrompt: vi.fn().mockResolvedValue('mock-prompt-result')
  }
}

export function createMockNerExtractor() {
  return {
    extractEntities: vi.fn().mockReturnValue([]),
    extractEntitiesByType: vi.fn().mockReturnValue([]),
    extractChineseNumberEntities: vi.fn().mockReturnValue([]),
    extractLawArticleEntities: vi.fn().mockReturnValue([]),
    extractCompanyNameEntities: vi.fn().mockReturnValue([])
  }
}

export function createMockScheduleOptimizer() {
  return {
    truncateForLog: vi.fn().mockReturnValue(''),
    contentHash: vi.fn().mockReturnValue('mock-hash'),
    compilePrompt: vi.fn().mockReturnValue(''),
    fillCompiledPrompt: vi.fn().mockReturnValue(''),
    loadPersistedFingerprints: vi.fn(),
    computeInputFingerprint: vi.fn().mockReturnValue('fp-mock'),
    findCachedExecution: vi.fn().mockReturnValue(null),
    saveExecutionFingerprint: vi.fn(),
    isManifestAutoCompiled: vi.fn().mockReturnValue(false),
    getManifestStats: vi.fn().mockReturnValue({ totalSteps: 0, cachedSteps: 0, dirtySteps: 0 }),
    simulateDataFlow: vi.fn().mockReturnValue({ issues: [], clean: true }),
    computeStepOutputHash: vi.fn().mockReturnValue('hash-mock'),
    findDirtySteps: vi.fn().mockReturnValue([]),
    getTierConfig: vi.fn().mockReturnValue({ maxTokens: 4096, timeout: 30000 }),
    computeStepPlan: vi.fn().mockReturnValue([]),
    formatStepPlanVisualization: vi.fn().mockReturnValue(''),
    computeParallelGroups: vi.fn().mockReturnValue([]),
    getValidationCacheKey: vi.fn().mockReturnValue('vck-mock'),
    lookupValidationCache: vi.fn().mockReturnValue(null),
    saveValidationCache: vi.fn()
  }
}

export function createMockSemanticCache() {
  return {
    lookup: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
    invalidateByDomain: vi.fn(),
    invalidateByConstraint: vi.fn(),
    invalidateExpired: vi.fn().mockReturnValue(0),
    clearCache: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ similarityThreshold: 0.85, maxEntries: 100, ttlMs: 3600000 }),
    setConfig: vi.fn(),
    getCacheSize: vi.fn().mockReturnValue(0),
    getCacheEntries: vi.fn().mockReturnValue([]),
    getCacheSavings: vi.fn().mockReturnValue({ tokensSaved: 0, hits: 0, misses: 0 }),
    resetSavingsCounters: vi.fn(),
    getAdaptiveThreshold: vi.fn().mockReturnValue(0.85),
    resetAdaptiveThreshold: vi.fn(),
    loadFromStorage: vi.fn().mockResolvedValue(undefined),
    reembedAll: vi.fn().mockResolvedValue(0),
    initSemanticCache: vi.fn().mockResolvedValue(undefined)
  }
}

export function createMockSmartRouter() {
  return {
    classifyComplexity: vi.fn().mockReturnValue('standard'),
    route: vi.fn().mockResolvedValue({ tier: 'standard', model: 'mock-model', estimatedTokens: 100 }),
    recordRoutingOutcome: vi.fn(),
    analyzeRoutingEfficiency: vi.fn().mockReturnValue({ avgTokens: 0, overkillRate: 0, underkillRate: 0 }),
    getRoutingHistory: vi.fn().mockReturnValue([]),
    clearRoutingHistory: vi.fn(),
    detectOverkill: vi.fn().mockReturnValue(false),
    getMaxTokensForComplexity: vi.fn().mockReturnValue(4096),
    getTierForComplexity: vi.fn().mockReturnValue('standard'),
    getAdaptiveThresholds: vi.fn().mockReturnValue({}),
    resetAdaptiveThresholds: vi.fn(),
    getRoutingZOLState: vi.fn().mockReturnValue({}),
    getHistoricalTokenAvg: vi.fn().mockReturnValue(0),
    initSmartRouter: vi.fn().mockResolvedValue(undefined)
  }
}

export function createMockSseParser() {
  return {
    parseSSELines: vi.fn().mockReturnValue([]),
    extractOpenAIDelta: vi.fn().mockReturnValue({ content: '', delta: '', done: false }),
    extractAnthropicDelta: vi.fn().mockReturnValue({ content: '', delta: '', done: false }),
    readSSEStream: vi.fn().mockResolvedValue([])
  }
}

export function createMockStrategySelector() {
  return {
    countFinanceTerms: vi.fn().mockReturnValue(0),
    selectRewriteStrategy: vi.fn().mockReturnValue('standard'),
    selectDisambigStrategy: vi.fn().mockReturnValue('clarify'),
    extractStrategyContext: vi.fn().mockReturnValue({}),
    recordStrategyOutcome: vi.fn(),
    getZOLState: vi.fn().mockReturnValue({}),
    resetZOL: vi.fn()
  }
}

export function createMockTokenBudget() {
  return {
    getBudget: vi.fn().mockReturnValue({ sessionLimit: 100000, dailyLimit: 500000, monthlyLimit: 5000000 }),
    setBudget: vi.fn(),
    resetBudget: vi.fn(),
    getBudgetMode: vi.fn().mockReturnValue('balanced'),
    setBudgetMode: vi.fn(),
    getTierWhitelist: vi.fn().mockReturnValue([]),
    setTierWhitelist: vi.fn(),
    getBudgetStatus: vi.fn().mockReturnValue({ session: { spent: 0, limit: 100000, remaining: 100000 }, daily: { spent: 0, limit: 500000, remaining: 500000 }, monthly: { spent: 0, limit: 5000000, remaining: 5000000 } }),
    getRecommendedTier: vi.fn().mockReturnValue('standard'),
    checkBudget: vi.fn().mockReturnValue({ allowed: true, tier: 'standard', reason: '' }),
    downgradeTier: vi.fn().mockReturnValue('standard'),
    recordCost: vi.fn(),
    recordLlmCost: vi.fn(),
    getSessionSpent: vi.fn().mockReturnValue(0),
    getDailySpent: vi.fn().mockReturnValue(0),
    getMonthlySpent: vi.fn().mockReturnValue(0),
    getCostRecords: vi.fn().mockReturnValue([]),
    resetSessionSpent: vi.fn(),
    clearCostRecords: vi.fn(),
    initBudgetSystem: vi.fn().mockResolvedValue(undefined),
    getCostBreakdownByTier: vi.fn().mockReturnValue({}),
    getCostBreakdownByCategory: vi.fn().mockReturnValue({})
  }
}

export function createMockTokenEstimate() {
  return {
    estimateTokens: vi.fn().mockReturnValue(10),
    estimateMessagesTokens: vi.fn().mockReturnValue(50),
    estimatePromptTokens: vi.fn().mockReturnValue(100),
    getContextWindowBudget: vi.fn().mockReturnValue(4000),
    truncateToTokenLimit: vi.fn().mockReturnValue('truncated text')
  }
}

export function createMockTokenPricing() {
  return {
    getUserPricing: vi.fn().mockReturnValue({}),
    setUserPricing: vi.fn(),
    resetUserPricing: vi.fn(),
    getPricingForTier: vi.fn().mockReturnValue({ inputPerM: 0, outputPerM: 0 }),
    calculateCost: vi.fn().mockReturnValue({ inputCost: 0, outputCost: 0, totalCost: 0 }),
    calculateCostByTier: vi.fn().mockReturnValue({ inputCost: 0, outputCost: 0, totalCost: 0 }),
    estimateStepCost: vi.fn().mockReturnValue({ minCost: 0, maxCost: 0, estimatedCost: 0 }),
    loadPricingFromStorage: vi.fn()
  }
}

export function createMockToolRetrieval() {
  return {
    getRouteCacheStats: vi.fn().mockReturnValue({ hits: 0, misses: 0 }),
    clearRouteCache: vi.fn(),
    isOnline: vi.fn().mockReturnValue(true),
    manifestFingerprint: vi.fn().mockReturnValue('fp-mock'),
    buildL2Index: vi.fn(),
    buildToolIndex: vi.fn(),
    retrieveTopTools: vi.fn().mockResolvedValue([]),
    makeSummaryToolList: vi.fn().mockReturnValue(''),
    segmentChinese: vi.fn().mockReturnValue([]),
    generateNGrams: vi.fn().mockReturnValue([]),
    keywordMatchScore: vi.fn().mockReturnValue(0),
    extractCoreKeywords: vi.fn().mockReturnValue([]),
    extractKeywordsFromDescription: vi.fn().mockReturnValue([]),
    universalMatch: vi.fn().mockReturnValue({ score: 0, method: 'keyword' }),
    raapMatch: vi.fn().mockReturnValue({ score: 0, method: 'raap' }),
    getTop3Candidates: vi.fn().mockReturnValue([]),
    llmFallback: vi.fn().mockResolvedValue([]),
    getTop3CandidatesUniversal: vi.fn().mockResolvedValue([])
  }
}

export function createMockZeroTokenLearning() {
  return {
    clampThreshold: vi.fn().mockReturnValue(0.5)
  }
}

export function createMockCommandPaletteSearch() {
  return {
    search: vi.fn().mockReturnValue([])
  }
}

export function createMockStorageMonitor() {
  return {
    calculateUsage: vi.fn().mockReturnValue([]),
    getTotalUsedMB: vi.fn().mockReturnValue(0),
    shouldAlert: vi.fn().mockReturnValue(false),
    getUsageLevel: vi.fn().mockReturnValue('green'),
    migrateVectorsToFiles: vi.fn().mockResolvedValue(0),
    cleanExpiredCache: vi.fn().mockReturnValue(0)
  }
}

export function createMockDataExporter() {
  return {
    buildExportData: vi.fn().mockReturnValue({ manifest: { version: '1.0', date: '', appVersion: '0.1.0', items: [] } }),
    exportToZip: vi.fn().mockResolvedValue(undefined),
    parseImportPreview: vi.fn().mockReturnValue(null),
    applyImport: vi.fn()
  }
}

export function createMockDataImporter() {
  return {
    importFromZip: vi.fn().mockResolvedValue(null),
    confirmImport: vi.fn().mockResolvedValue(undefined)
  }
}

export function createMockTerminologyMap() {
  return {
    t: vi.fn().mockReturnValue(''),
    getAllTerms: vi.fn().mockReturnValue({})
  }
}

export function createMockOnboardingManager() {
  return {
    completeStep: vi.fn(),
    isStepComplete: vi.fn().mockReturnValue(false),
    resetOnboarding: vi.fn(),
    shouldShowOnboarding: vi.fn().mockReturnValue(true)
  }
}

export function createAllMockServices() {
  return {
    promptTranslator: createMockPromptTranslator(),
    ruleEngine: createMockRuleEngine(),
    pipelineExecutor: createMockPipelineExecutor(),
    embedder: createMockEmbedder(),
    knowledgeBase: createMockKnowledgeBase(),
    vectorStore: createMockVectorStore(),
    convMemory: createMockConvMemory(),
    dagCheckpoint: createMockDagCheckpoint(),
    proactiveScheduler: createMockProactiveScheduler(),
    secureStore: createMockSecureStore(),
    resultBeautifier: createMockResultBeautifier(),
    debugLog: createMockDebugLog(),
    memory: createMockMemory(),
    hash: createMockHash(),
    errorClassifier: createMockErrorClassifier(),
    constraintFeedback: createMockConstraintFeedback(),
    crossDocValidator: createMockCrossDocValidator(),
    domainConstraints: createMockDomainConstraints(),
    dualEngineValidator: createMockDualEngineValidator(),
    factGuard: createMockFactGuard(),
    fileContext: createMockFileContext(),
    l0SkillRouter: createMockL0SkillRouter(),
    macroExecutor: createMockMacroExecutor(),
    nerExtractor: createMockNerExtractor(),
    scheduleOptimizer: createMockScheduleOptimizer(),
    semanticCache: createMockSemanticCache(),
    smartRouter: createMockSmartRouter(),
    sseParser: createMockSseParser(),
    strategySelector: createMockStrategySelector(),
    tokenBudget: createMockTokenBudget(),
    tokenEstimate: createMockTokenEstimate(),
    tokenPricing: createMockTokenPricing(),
    toolRetrieval: createMockToolRetrieval(),
    zeroTokenLearning: createMockZeroTokenLearning(),
    commandPaletteSearch: createMockCommandPaletteSearch(),
    storageMonitor: createMockStorageMonitor(),
    dataExporter: createMockDataExporter(),
    dataImporter: createMockDataImporter(),
    terminologyMap: createMockTerminologyMap(),
    onboardingManager: createMockOnboardingManager()
  }
}
