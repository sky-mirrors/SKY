import type { ModelTier, DetectedDomain, ChatMessage } from '@/models'

export interface KernelContext {
  domain?: string
  /** P1-13：语义缓存 pack 隔离归因；缺省时按 domain 经挂载 pack 归因 */
  packId?: string
  jobRole?: string
  sessionId?: string
  taskType?: string
  callerId?: string
  // #2 收尾：traceId 参数化传播（原模块级全局并发下串号）
  traceId?: string
  budgetLimit?: number
  budgetMode?: string
  cacheNamespace?: string
  skipCacheRead?: boolean
  skipCacheWrite?: boolean
  riskTolerance?: 'strict' | 'normal' | 'relaxed'
  manifestMaxTier?: ModelTier
  persistence?: PersistencePort
  io?: IOPort
  llm?: LLMPort
}

export interface KernelResult {
  success: boolean
  tier: ModelTier
  responseText?: string
  responseStream?: AsyncIterable<string>
  fromCache: boolean
  routingDecision?: RoutingDecisionResult
  budgetCheck?: BudgetCheckResult
  securityResult?: SecurityCheckResult
  factResult?: FactCheckResult
  cacheHit?: CacheLookupResult
  costRecord?: CostRecordResult
  error?: string
}

export interface RoutingDecisionResult {
  tier: ModelTier
  complexity: TaskComplexity
  reason: string
  confidence: number
  budgetCapped: boolean
}

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex'

export interface RouteInput {
  text: string
  taskType?: string
  callerId?: string
  historicalTokenAvg?: number
  domain?: string
  manifestMaxTier?: ModelTier
  cacheHint?: { hit: boolean; tier?: ModelTier }
}

export interface RouteResult {
  tier: ModelTier
  complexity: TaskComplexity
  reason: string
  confidence: number
  estimatedTokens: number
  estimatedCost: number
  budgetCapped: boolean
  budgetAllowed: boolean
  budgetRecommendedTier: ModelTier
}

export interface CacheLookupResult {
  hit: boolean
  responseText?: string
  tier?: ModelTier
  promptTokens?: number
  completionTokens?: number
  similarity?: number
  entryId?: string
}

export interface CacheStoreInput {
  queryText: string
  responseText: string
  tier: ModelTier
  promptTokens: number
  completionTokens: number
  domain?: string
  /** P1-13：写入条目的 pack 归属（不传=全局条目，pack 卸载失效语义见 semanticCache.packMatch） */
  packId?: string
  constraintIds?: string[]
  ttl?: number
}

export interface SecurityCheckInput {
  action: string
  targetPath?: string
  targetUrl?: string
  params?: Record<string, unknown>
  manifestId?: string
  userInput: string
}

export interface SecurityCheckResult {
  safe: boolean
  riskLevel: 'low' | 'medium' | 'high'
  reason?: string
  dualEngineResult?: DualEngineDetail
  ruleResult?: RuleEngineDetail
}

export interface DualEngineDetail {
  intent_match: boolean
  parameter_sane: boolean
  risk_level: string
}

export interface RuleEngineDetail {
  matched: boolean
  output: string
  matchedRuleId?: string
}

export interface BudgetCheckInput {
  estimatedTokens: number
  requestedTier: ModelTier
}

export interface BudgetCheckResult {
  allowed: boolean
  recommendedTier: ModelTier
  reason: string
  estimatedCost: number
}

export interface BudgetRecordInput {
  tier: ModelTier
  promptTokens: number
  completionTokens: number
  cost: number
  category?: string
  cacheHitTokens?: number
}

export interface FactCheckInput {
  llmOutput: string
  sourceEntities: ExtractedEntityInput[]
  manifestRoles: string[]
  documents?: Array<{ docId: string; text: string }>
}

export interface ExtractedEntityInput {
  type: string
  raw: string
  normalized: string
}

export interface FactCheckResult {
  severity: 'ok' | 'minor' | 'critical'
  conflicts: FactConflictItem[]
  autoCorrected: boolean
  correctedText?: string
  constraintResults?: unknown[]
}

export interface FactConflictItem {
  type: string
  source: string
  output: string
  severity: string
}

export interface CostRecordResult {
  tier: ModelTier
  promptTokens: number
  completionTokens: number
  cost: number
}

export interface LLMPort {
  chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options: LLMCallOptions
  ): Promise<LLMCallResult>
  chatCompletionStream(
    messages: Array<{ role: string; content: string }>,
    options: LLMCallOptions
  ): Promise<AsyncIterable<string>>
  listModels(): Promise<Array<{ id: string; name: string }>>
}

export interface LLMCallOptions {
  tier?: ModelTier
  taskType?: string
  callerId?: string
  // #2 收尾：traceId 参数化传播
  traceId?: string
  maxTokens?: number
  domain?: string
  stream?: boolean
}

export interface LLMCallResult {
  content: string
  tier: ModelTier
  promptTokens: number
  completionTokens: number
}

export interface PersistencePort {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  keys(): string[]
}

export interface IOPort {
  storeRead(key: string): Promise<string | null>
  storeWrite(key: string, value: string): Promise<void>
  storeDelete(key: string): Promise<void>
  vectorWriteBin(key: string, base64Data: string): Promise<boolean>
  vectorReadBin(key: string): Promise<ArrayBuffer | Uint8Array | null>
  vectorListKeys(): Promise<string[]>
  shellExec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }>
  fileWrite(path: string, content: string): Promise<boolean>
  fileRead(path: string): Promise<string | null>
  createDirectory(path: string): Promise<boolean>
  createDocx(path: string, content: string): Promise<boolean>
  httpFetch(url: string, options: Record<string, unknown>): Promise<{ status: number; body: string }>
  mcpSpawn(id: string, config: unknown): Promise<boolean>
  mcpStop(id: string): Promise<void>
  mcpListTools(id: string): Promise<Array<{ name: string; description: string }>>
  mcpCallTool(id: string, toolName: string, args: Record<string, unknown>): Promise<unknown>
  llmChatCompletion(params: unknown): Promise<unknown>
  llmChatCompletionStream(
    params: unknown,
    callbacks?: { onChunk: (chunk: unknown) => void; onDone: (final: unknown) => void; onError: (err: string) => void }
  ): Promise<unknown>
  llmListModels(params: unknown): Promise<unknown>
  safeStorageEncrypt(value: string): Promise<string>
  safeStorageDecrypt(value: string): Promise<string>
  openFile(options?: unknown): Promise<string | null>
  openDirectory(options?: unknown): Promise<string | null>
  backupCreate(): Promise<string>
  backupRestore(zipPath: string): Promise<boolean>
  knowledgeIngest(params: unknown): Promise<unknown>
  knowledgeSearch(params: unknown): Promise<unknown>
  watchfsSetDir(dir: string): Promise<void>
  watchfsGetDir(): Promise<string | null>
  getPlatform(): Promise<string>
  getVersion(): Promise<string>
  getUserDataPath(): Promise<string>
}

export interface DispatchOptions {
  stream?: boolean
  messages?: Array<{ role: string; content: string }>
  routeOnly?: boolean
  skipSecurity?: boolean
  skipFactCheck?: boolean
  manifestRoles?: string[]
  documents?: Array<{ docId: string; text: string }>
}

export interface L0DirectPlan {
  intent: string
  steps: Array<{ tool: string; params: Record<string, string>; dependsOn?: number[] }>
  isExploration: boolean
}
