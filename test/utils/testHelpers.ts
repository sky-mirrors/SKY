export { createMockApiStore, createMockConfigStore, createMockDebugStore, createMockDialogStore, createMockFeedbackStore, createMockMcpStore, createMockNodeStore, createMockPipelineStore, createMockSessionStore, createMockKnowledgeStore, createMockMemoryStore, createMockRuleStore, createMockSkillStore, createMockWorkflowLogStore, createAllMockStores } from './mockStores'
export { createFullMockElectronAPI, installMockElectronAPI, removeMockElectronAPI } from './mockElectronAPI'
export type { MockElectronAPI } from './mockElectronAPI'
export { createAllMockServices, createMockPromptTranslator, createMockRuleEngine, createMockPipelineExecutor, createMockEmbedder, createMockKnowledgeBase, createMockVectorStore, createMockConvMemory, createMockDagCheckpoint, createMockProactiveScheduler, createMockSecureStore, createMockResultBeautifier, createMockDebugLog, createMockMemory, createMockHash, createMockErrorClassifier, createMockConstraintFeedback, createMockCrossDocValidator, createMockDomainConstraints, createMockDualEngineValidator, createMockFactGuard, createMockFileContext, createMockL0SkillRouter, createMockMacroExecutor, createMockNerExtractor, createMockScheduleOptimizer, createMockSemanticCache, createMockSmartRouter, createMockSseParser, createMockStrategySelector, createMockTokenBudget, createMockTokenEstimate, createMockTokenPricing, createMockToolRetrieval, createMockZeroTokenLearning } from './mockServices'

import { vi } from 'vitest'
import { createFullMockElectronAPI } from './mockElectronAPI'
import type { MockElectronAPI } from './mockElectronAPI'

export function createMockElectronAPI(overrides: Partial<MockElectronAPI> = {}): MockElectronAPI {
  return createFullMockElectronAPI(overrides)
}
