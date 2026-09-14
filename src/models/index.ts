export enum ToolLevel {
  L0 = 'L0',
  L1 = 'L1',
  L2 = 'L2',
  L3 = 'L3'
}

export enum JobRole {
  HR = 'hr',
  Finance = 'finance',
  Sales = 'sales',
  Legal = 'legal',
  General = 'general'
}

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface ToolNode {
  id: string
  name: string
  level: ToolLevel
  position: Vector3
  gridIndex: [number, number, number]
  description: string
  icon?: string
  apiRole?: string
  enabled: boolean
  locked: boolean
  communityHeat?: number
  lastUsedAt?: number
  parentL1Id?: string
  comboToolIds?: string[]
  gravityWeight?: number
  inputSchema?: SchemaField[]
  outputSchema?: SchemaField[]
  contextCache?: ContextCache
  isL05?: boolean
  isOrchestrator?: boolean
  mcpToolIds?: string[]
  jobRoles?: string[]
}

export interface SchemaField {
  name: string
  type: 'string' | 'number' | 'object' | 'array' | 'markdown'
  required: boolean
  description: string
}

export interface ContextCache {
  id: string
  toolId: string
  partialInput: string
  partialOutput: string
  stepIndex: number
  totalSteps: number
  savedAt: number
}

export interface CircuitBreakerState {
  isOpen: boolean
  failureCount: number
  lastFailureAt: number
  cooldownMs: number
  retryCount: number
  maxRetries: number
}

export interface HistoryEntry {
  id: string
  toolId: string
  toolName: string
  input: string
  output: string
  timestamp: number
  success: boolean
}

export interface ApiConfig {
  baseUrl: string
  models: ModelInfo[]
  activeModel: string
  isReachable: boolean
  lastCheckedAt: number
  providers: ProviderConfig[]
  activeProviderId: string
}

export interface ProviderConfig {
  id: string
  name: string
  baseUrl: string
  authType: 'none' | 'bearer' | 'api-key'
  apiKey: string
  modelsEndpoint: string
  chatFormat: 'openai' | 'anthropic' | 'custom'
  models: ModelInfo[]
  isReachable: boolean
  lastCheckedAt: number
}

export interface ModelInfo {
  id: string
  name: string
  size?: string
  providerId?: string
}

export interface PipelineStep {
  toolId: string
  params: Record<string, string>
  outputKey: string
}

export interface Pipeline {
  id: string
  name: string
  steps: PipelineStep[]
  mode: 'serial' | 'parallel'
  createdAt: number
  lastRunAt?: number
  sessionId?: string
  knowledgeGroupId?: string
  attachedEntryIds: string[]
  dagNodes?: DagNode[]
  dagEdges?: DagEdge[]
}

export interface DagNode {
  id: string
  toolId: string
  toolName: string
  toolLevel: 'L1' | 'L2' | 'L3' | 'skill' | 'mcp'
  position: { x: number; y: number }
  params: Record<string, string>
  outputKey: string
  modelTier?: string
  status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  result?: string
}

export interface DagEdge {
  id: string
  sourceNodeId: string
  sourceOutputKey: string
  targetNodeId: string
  targetParamName: string
}

export interface KnowledgeEntry {
  id: string
  filename: string
  fileType: string
  chunks: number
  fingerprint: string
  createdAt: number
  ownerType?: 'global' | 'session' | 'pipeline' | 'group' | 'conversation'
  ownerId?: string
  partition?: 'kernel' | 'pack' | 'user'
  partitionId?: string
}

export interface ConversationMemory {
  id: string
  projectId: string
  messages: ChatMessage[]
  fileFingerprints: string[]
  updatedAt: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface AdjacencyMap {
  [nodeId: string]: string[]
}

export interface UserConfig {
  jobRole: JobRole
  selectedL2Ids: string[]
  firstLaunchDone: boolean
  apiConfig: ApiConfig
  uiMode?: 'workbench' | 'starmap'
  onboardingCompleted?: boolean
  apiConfigured?: boolean
  knowledgeFed?: boolean
  terminologyStyle?: 'technical' | 'plain'
  animationEnabled?: boolean
  starmapNodeDensity?: 'core' | 'standard' | 'full'
  dialogPanelWidth?: number
  favoriteSkills?: string[]
  recentSkills?: RecentSkillEntry[]
  viewMode?: 'starmap' | 'preview'
}

export interface RecentSkillEntry {
  id: string
  name: string
  lastUsed: number
}

export type NotificationType =
  | 'audit_block'
  | 'api_degrade'
  | 'circuit_breaker'
  | 'tool_fail'
  | 'storage_warning'
  | 'tool_complete'
  | 'knowledge_ingest'
  | 'cache_hit'
  | 'skill_install'

export type NotificationPriority = 'high' | 'medium' | 'low'

export interface NotificationAction {
  label: string
  action: 'detail' | 'retry' | 'view' | 'manage' | 'settings'
  payload: Record<string, string>
}

export interface Notification {
  id: string
  type: NotificationType
  priority: NotificationPriority
  title: string
  message: string
  timestamp: number
  read: boolean
  actions: NotificationAction[]
  autoReadAt: number | null
  expiresAt: number | null
}

export interface NotificationSettings {
  auditBlock: boolean
  apiDegrade: boolean
  toolComplete: boolean
  toolFail: boolean
  cacheHit: boolean
  knowledgeIngest: boolean
  storageWarning: boolean
  popupDuration: number
}

export interface CommandPaletteResult {
  type: 'skill' | 'tool' | 'setting' | 'action' | 'history'
  id: string
  label: string
  description: string
  category: string
  weight: number
  data?: Record<string, unknown>
}

export interface StorageBreakdown {
  category: string
  sizeMB: number
  storeKey: string
  label: string
  canClean: boolean
}

export interface ImportPreview {
  sourceFile: string
  exportDate: string
  appVersion: string
  items: ImportPreviewItem[]
  warnings: string[]
}

export interface ImportPreviewItem {
  category: string
  label: string
  count: number
  strategy: 'overwrite' | 'merge' | 'append' | 'skip'
}

export interface InteractionState {
  hoveredNodeId: string | null
  selectedNodeId: string | null
  draggingNodeId: string | null
  dragTargetLevel: ToolLevel | null
  isDragging: boolean
  mouseSpeed: number
  onboardingPhase: 'waiting' | 'pulsing' | 'stardust' | 'exploding' | 'done'
  selectedRole: JobRole | null
  toolUseCount: number
  circuitBreaker: CircuitBreakerState
  l0RedFlash: boolean
  dialogMode: 'command' | 'plan' | 'teach'
  ctrlKey: boolean
}

export interface IngestProgress {
  totalChunks: number
  processedChunks: number
  isRunning: boolean
}

export interface L3DecayState {
  nodeId: string
  daysUntilCollapse: number
  isCollapsed: boolean
}

export interface DegradedState {
  isDegraded: boolean
  unavailableToolIds: string[]
  reason: string
}

export interface SessionMemory {
  id: string
  createdAt: number
  updatedAt: number
  messages?: DialogMessage[]
}

export interface ProjectMemory {
  id: string
  name: string
  fileFingerprints: string[]
  knowledgeEntryIds: string[]
  vectorIndex: Record<string, number[]>
  updatedAt: number
  parentGroupId?: string
}

export interface KnowledgeGroup {
  id: string
  name: string
  sharedEntryIds: string[]
  createdAt: number
  updatedAt: number
}

export interface GlobalMemory {
  id: string
  preferences: Record<string, string>
  promptTemplates: PromptTemplate[]
  frequentTerms: string[]
  updatedAt: number
}

export interface PromptTemplate {
  id: string
  name: string
  content: string
  createdAt: number
}

export interface ThoughtStep {
  phase: 'plan' | 'thought' | 'observation' | 'reflection'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  timestamp: number
}

export interface TaskPlan {
  intent: string
  needs: string[]
  steps: {
    step: number
    description: string
    tool: string
    depends_on: number[]
    params: Record<string, unknown>
    expectedOutput: string
    fallback?: string
  }[]
}

export interface TaskCase {
  id: string
  input: string
  plan: TaskPlan
  toolsUsed: string[]
  success: boolean
  vector: number[]
  createdAt: number
}

export interface FileAttachment {
  fileName: string
  filePath: string
  fileType: string
  fileSize?: number
  label?: string
}

export interface DialogMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  type: 'text' | 'workflow_card' | 'tool_log' | 'system_notice'
  content: string
  workflowCard?: WorkflowCard
  toolLog?: ToolCallLog
  thoughtChain?: ThoughtStep[]
  taskPlan?: TaskPlan
  lineage?: { step: number; source: string; tool: string; ruleId?: string; tier?: string }[]
  fileAttachment?: FileAttachment
  timestamp: number
  isTyping?: boolean
}

export interface StreamChunk {
  content: string
  delta: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number }
  done: boolean
}

export interface StreamCallbacks {
  onChunk: (chunk: StreamChunk) => void
  onDone: (final: { content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage?: StreamChunk['usage'] }) => void
  onError: (error: Error) => void
}

export interface WorkflowCard {
  nodeIds: string[]
  edgeIds: string[]
  status: 'running' | 'completed' | 'failed'
}

export interface ToolCallLog {
  toolName: string
  steps: ToolCallStep[]
  totalTimeMs: number
}

export interface ToolCallStep {
  toolId: string
  toolName: string
  action: string
  result: string
  resultHash?: string
  durationMs: number
}

export interface Skill {
  id: string
  name: string
  description: string
  version: string
  nodes: SkillNode[]
  edges: SkillEdge[]
  dependencies: string[]
  author: string
  createdAt: number
  isInstalled: boolean
  isFromMarket: boolean
  catalogId?: string
}

export interface SkillNode {
  toolId: string
  params: Record<string, string>
  position: { x: number; y: number }
}

export interface SkillEdge {
  from: string
  to: string
  type: 'data' | 'control'
}

export interface McpConnection {
  id: string
  name: string
  url: string
  isConnected: boolean
  tools: McpTool[]
  lastTestedAt: number
  isWhitelisted: boolean
  catalogId?: string
  catalogCommand?: string
  catalogArgs?: string[]
  catalogEnv?: Record<string, string>
}

export type McpToolPermission = 'readonly' | 'readwrite' | 'execute'

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isAutoAllowed: boolean
  permission: McpToolPermission
}

export interface McpRequestLog {
  id: string
  mcpId: string
  toolName: string
  request: string
  response: string
  timestamp: number
  success: boolean
}

export interface WorkflowLog {
  id: string
  name: string
  nodes: WorkflowLogNode[]
  edges: WorkflowLogEdge[]
  timestamps: number[]
  ioSnapshots: WorkflowIoSnapshot[]
  startedAt: number
  completedAt: number
  status: 'running' | 'completed' | 'failed'
}

export interface WorkflowLogNode {
  toolId: string
  toolName: string
  startedAt: number
  completedAt: number
  status: 'pending' | 'running' | 'completed' | 'failed'
}

export interface WorkflowLogEdge {
  from: string
  to: string
  type: 'data' | 'control'
  activatedAt?: number
}

export interface WorkflowIoSnapshot {
  toolId: string
  input: string
  output: string
  inputHash?: string
  outputHash?: string
  timestamp: number
}

export interface AuditLogEntry {
  id: string
  userId: string
  action: string
  toolId: string
  fileName?: string
  mcpId?: string
  timestamp: number
  details: string
}

export interface ConnectionFlow {
  from: string
  to: string
  type: 'data' | 'control'
  isRunning: boolean
  startTime: number
}

export interface NodeHandlerContext {
  input: Record<string, unknown>
  signal: AbortSignal
  onProgress: (msg: string) => void
  gateway: ModelGatewayAdapter
  memory: MemoryAdapter
  knowledge: KnowledgeAdapter
}

export interface NodeHandler {
  id: string
  inputSchema: SchemaField[]
  outputSchema: SchemaField[]
  run(ctx: NodeHandlerContext): Promise<Record<string, unknown>>
}

export interface ModelGatewayAdapter {
  chatCompletion(messages: { role: string; content: string }[]): Promise<string>
  listModels(): ModelInfo[]
  switchProvider(providerId: string): void
  switchModel(modelId: string): void
  getActiveProvider(): ProviderConfig | null
}

export interface MemoryAdapter {
  getRecent(projectId: string, tokenBudget: number): ChatMessage[]
  addMessage(projectId: string, role: string, content: string): void
  summarizeOld(projectId: string, tokenBudget: number): string
}

export interface KnowledgeAdapter {
  ingestFile(file: File): Promise<KnowledgeEntry>
  search(query: string, topK: number): Promise<SearchResult[]>
  getEntry(id: string): KnowledgeEntry | null
}

export interface SearchResult {
  text: string
  entryId: string
  score: number
  source: 'vector' | 'keyword' | 'hybrid' | 'pseudo-vector'
}

export interface PromptChainStep {
  tool: string
  params: Record<string, unknown>
  expectedOutput: string
}

export interface PromptChainResult {
  steps: PromptChainStep[]
  raw: string
}

export interface MarkdownDocument {
  type: string
  children: MarkdownNode[]
}

export interface MarkdownNode {
  type: string
  content?: string
  children?: MarkdownNode[]
  level?: number
  ordered?: boolean
  language?: string
  href?: string
  alt?: string
}

export interface McpCatalogItem {
  id: string
  name: string
  description: string
  category: string
  command: string
  args: string[]
  envKeys: string[]
  homepage: string
  source: 'official' | 'community'
  tags: string[]
}

export interface L2ToolIdentity {
  id: string
  name: string
  version: string
  author: 'official' | 'user' | 'community'
  createdAt: number
  updatedAt: number
  templateId: string
}

export interface L2ToolVisual {
  baseColor: string
  ringStyle: 'solid' | 'dashed'
  badges: ('sparkle' | 'chain' | 'lightning')[]
  hoverLabel: string
  anchorGlow: string
  upgradeGlow: string
}

export interface L2ToolRouting {
  keywords: string[]
  targetRoles: ('hr' | 'finance' | 'legal' | 'sales' | 'general')[]
  requiredL1: string[]
  inputType: 'file' | 'text' | 'file_or_text'
  retrievalSummary: string
  userSummary: string
  confidenceThreshold: number
}

export interface L2DagStep {
  step: number
  description: string
  tool: string
  depends_on: number[]
  params: Record<string, unknown>
  expectedOutput: string
  fallback?: string
  modelTier?: 'nano' | 'mini' | 'standard' | 'pro'
  outputExtract?: string
}

export interface L2ParamSlot {
  name: string
  source: 'file_path' | 'input_text' | 'clipboard' | 'context'
  description: string
  required: boolean
}

export interface L2ParamBinding {
  slotName: string
  targetStep: number
  targetParam: string
}

export interface L2ToolExecution {
  mode: 'direct' | 'macro' | 'chain'
  directCall?: {
    l1Target: string
    promptTemplate: string
    maxTokens: number
  }
  dagPlan?: {
    steps: L2DagStep[]
    fallbackStrategy: 'retry' | 'skip' | 'ask_user'
    maxRetries: number
  }
  paramMapping: {
    slots: L2ParamSlot[]
    bindings: L2ParamBinding[]
  }
  fallbackModelTier?: 'mini' | 'nano' | 'rule'
  conditions?: L2ConditionBranch[]
}

export interface L2ConditionBranch {
  fromStep: number
  toStep: number
  expr: string
}

export interface L2RuleCondition {
  field: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'regex' | 'between'
  value: string | number
  valueMax?: number
}

export interface L2RuleAction {
  outputTemplate: string
  severity?: 'info' | 'warning' | 'error'
  tags?: string[]
}

export interface L2RuleEntry {
  id: string
  conditions: L2RuleCondition[]
  action: L2RuleAction
  priority: number
}

export interface L2RuleBasedFallback {
  enabled: boolean
  coverage: number
  rules: L2RuleEntry[]
  fallbackToLLM: boolean
  targetStep?: number
}

export interface L2ToolCacheMeta {
  estimatedTokenSaving: number
  avgExecutionTime: number
  cacheable: boolean
  cacheKeyTemplate?: string
  cacheTTL?: number
}

export interface L2ToolManifest {
  identity: L2ToolIdentity
  visual: L2ToolVisual
  routing: L2ToolRouting
  execution: L2ToolExecution
  cacheMeta: L2ToolCacheMeta
  ruleBasedFallback?: L2RuleBasedFallback
}

export interface SkillCatalogItem {
  id: string
  name: string
  description: string
  category: string
  version: string
  author: string
  nodes: SkillNode[]
  edges: SkillEdge[]
  dependencies: string[]
  tags: string[]
  mcpServerId?: string
  mcpCommand?: string
  mcpArgs?: string[]
  mcpEnvKeys?: string[]
  mcpTools?: string[]
  homepage?: string
}

export type ProbeSource = 'rule' | 'cache' | 'llm' | 'mcp' | 'shell' | 'read_file' | 'knowledge' | 'skip' | 'error'

export type ConsoleLogLevel = 'log' | 'warn' | 'error' | 'info'

export type ConsoleCategory = 'system' | 'raap' | 'llm' | 'shell' | 'cache' | 'rule' | 'dialog' | 'feedback' | 'factguard' | 'tool' | 'schedule'

export interface ConsoleLogEntry {
  id: string
  level: ConsoleLogLevel
  text: string
  timestamp: number
  tag?: string
  category?: ConsoleCategory
  detail?: string
  traceId?: string
}

export interface ProbeSnapshot {
  id: string
  stepNum: number
  manifestId: string
  source: ProbeSource
  sourceDetail: string
  toolName: string
  inputSnapshot: Record<string, unknown>
  outputSnapshot: string
  modelTier?: string
  modelParams?: { temperature?: number; topP?: number; maxTokens?: number }
  ruleId?: string
  cacheFingerprint?: string
  errorStack?: string
  timestamp: number
  durationMs: number
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostCny: number }
  traceId?: string
}

export interface DebugSession {
  id: string
  startedAt: number
  probes: ProbeSnapshot[]
  environment: {
    model: string
    provider: string
    apiReachable: boolean
    nodeCount: number
    manifestCount: number
  }
}

export interface DagCheckpoint {
  id: string
  manifestId: string
  userInput: { filePath?: string; inputText?: string; context?: string }
  completedResults: Record<number, string>
  failedSteps: number[]
  skipSteps: number[]
  totalSteps: number
  createdAt: number
  updatedAt: number
  resumed: boolean
}

export type FeedbackAction = 'thumbs_up' | 'thumbs_down' | 'undo'

export type DetectedDomain = 'legal' | 'finance' | 'hr' | 'general'

export type RewriteStrategy = 'none' | 'keyword_extract'
export type DisambigStrategy = 'auto_pick' | 'show_candidates' | 'ask_clarify' | 'fallback_l1'

export interface DomainRewriteOffsets {
  minContentLength: number
  minKeywordCount: number
  minLawArticleCount: number
  minFinanceTermCount: number
}

export interface DomainDisambigOffsets {
  highConfidenceGap: number
  mediumConfidenceGap: number
  lowConfidenceCandidateCount: number
  lowConfidenceScoreGap: number
}

export interface StrategyContext {
  contentLength: number
  keywordCount: number
  initialMatchFailed: boolean
  detectedDomain: DetectedDomain
  lawArticleCount: number
  financeTermCount: number
  constraintHitCount: number
  candidateCount: number
  topScoreGap: number
  hasDomainSignalMatch: boolean
}

export interface DecisionContext {
  rewriteStrategy: RewriteStrategy
  disambigStrategy?: DisambigStrategy
  wasRewritten: boolean
  originalQuery: string
  rewrittenQuery?: string
  matchResult: string
  gate: string
  detectedDomain: DetectedDomain
  strategyContextSnapshot: Record<string, number>
}

export interface FeedbackEntry {
  id: string
  queryFingerprint: string
  matchedSkillId: string
  contextFiles: string[]
  action: FeedbackAction
  timestamp: number
  sessionId: string
  decisionContext?: DecisionContext
}

export interface SkillWeightModifier {
  skillId: string
  modifier: number
  decayRate: number
  lastUpdated: number
}

export interface SideEffectRecord {
  stepNum: number
  tool: string
  operation: 'create' | 'modify' | 'read'
  filePath: string
  originalExisted: boolean
  timestamp: number
}

export interface SideEffectManifest {
  executionId: string
  manifestId: string
  userInput: string
  queryFingerprint: string
  sideEffects: SideEffectRecord[]
  timestamp: number
}

export interface ActionManifest {
  skill_id: string
  target_file: string
  operation: string
  expected_output: string
  intent: string
  isHighRisk: boolean
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ValidationResult {
  intent_match: boolean
  parameter_sane: boolean
  risk_level: RiskLevel
  reason?: string
  from_cache?: boolean
}

export interface ValidationCacheEntry {
  key: string
  result: ValidationResult
  timestamp: number
}

export type FactEntityType = 'amount' | 'date' | 'percentage' | 'contract_id' | 'person_name' | 'law_article' | 'company_name' | 'bank_account' | 'id_card' | 'location'

export interface ExtractedEntity {
  type: FactEntityType
  raw: string
  normalized: string
  linePos: number
  subType?: 'chinese_number' | 'contextual' | 'law_article' | 'ner_model'
  modelScore?: number
}

export interface LawArticleEntity {
  raw: string
  article: number
  paragraph?: number
  item?: number
}

export interface ChineseNumberEntity {
  raw: string
  numericValue: number
  normalized: string
  linePos: number
}

export interface CompanyNameEntity {
  raw: string
  linePos: number
}

export type RuleStatus = 'draft' | 'testing' | 'reviewed' | 'active' | 'deprecated'

export type ConstraintSourceType = 'law' | 'regulation' | 'standard' | 'judicial_interpretation'

export interface ConstraintSource {
  type: ConstraintSourceType
  name: string
  article: string
  effectiveDate: string
  originalText?: string
  verifiedBy?: string
  verifiedAt?: number
}

export interface ConstraintApplicability {
  jurisdiction: string
  companySize?: 'small' | 'medium' | 'large' | 'all'
  expiresAt?: number
}

export interface ConstraintTestCase {
  description: string
  input: string
  expectedTrigger: boolean
  expectedMessage?: string
}

export interface ConstraintReliability {
  confidence: 'high' | 'medium' | 'low'
  source: ConstraintSource
  caveat?: string
}

export interface ConstraintResult {
  triggered: boolean
  constraintId: string
  severity: 'info' | 'warning' | 'error'
  message: string
  reliability: ConstraintReliability
  matchedEntities?: ExtractedEntity[]
  requiresHumanConfirmation?: boolean
  humanJudgmentPrompt?: string
  automationLevel?: 'full' | 'semi'
}

export interface DomainConstraint {
  id: string
  domain: 'finance' | 'legal' | 'hr'
  category: string
  description: string
  severity: 'info' | 'warning' | 'error'
  applicability: ConstraintApplicability
  reliability: ConstraintReliability
  testCases: ConstraintTestCase[]
  status: RuleStatus
  triggerCount: number
  falsePositiveCount: number
  lastTriggeredAt: number
  createdAt: number
  updatedAt: number
  automationLevel: 'full' | 'semi'
  humanJudgmentPrompt?: string
  reviewType: 'auto' | 'manual'
  check(context: ConstraintCheckContext): ConstraintResult | null
}

export interface ConstraintCheckContext {
  entities: ExtractedEntity[]
  sourceText: string
  outputText: string
  stepResults: Record<number, string>
  manifestRoles: string[]
}

export interface RuleWithStatus {
  ruleId: string
  status: RuleStatus
  triggerCount: number
  falsePositiveCount: number
  lastTriggeredAt: number
  lastReviewedAt?: number
  reviewerName?: string
}

export interface ConstraintFeedbackEntry {
  constraintId: string
  timestamp: number
  reviewer?: string
  action?: string
  fromStatus?: RuleStatus | null
  toStatus?: RuleStatus | null
  comment?: string
  isFalsePositive?: boolean
  documentId?: string
}

export interface FactConflict {
  type: FactEntityType
  sourceRaw: string
  outputRaw: string
  sourceNormalized: string
  outputNormalized: string
  severity: 'critical' | 'minor'
  diff: string
}

export interface FactGuardResult {
  ok: boolean
  conflicts: FactConflict[]
  hallucinatedEntities: ExtractedEntity[]
  severity: 'critical' | 'minor' | 'ok'
  correctedOutput: string | null
  summary: string
}

export type ModelTier = 'nano' | 'mini' | 'standard' | 'pro'

export type OverBudgetStrategy = 'degrade' | 'block' | 'warn'

export type BudgetMode = 'zero' | 'economy' | 'standard'

export type TierWhitelist = Record<ModelTier, boolean>

export const BUDGET_MODE_TIERS: Record<BudgetMode, ModelTier> = {
  zero: 'nano',
  economy: 'mini',
  standard: 'pro',
}

export const DEFAULT_TIER_WHITELIST: TierWhitelist = {
  nano: true,
  mini: true,
  standard: true,
  pro: true,
}

export interface UserPricing {
  inputPricePer1k: number
  outputPricePer1k: number
  cacheHitDiscount: number
}

export interface TokenBudget {
  dailyBudgetCny: number
  sessionBudgetCny: number
  monthlyBudgetCny: number
  warnThreshold: number
  overBudgetStrategy: OverBudgetStrategy
  budgetMode: BudgetMode
  tierWhitelist: TierWhitelist
}

export interface BudgetPeriodStatus {
  spent: number
  budget: number
  percent: number
  overBudget: boolean
  warnLevel: 'ok' | 'warning' | 'critical' | 'exceeded'
}

export interface BudgetStatus {
  daily: BudgetPeriodStatus
  session: BudgetPeriodStatus
  monthly: BudgetPeriodStatus
  recommendedTier: ModelTier
  strategy: OverBudgetStrategy
}

export interface CostBreakdown {
  byTier: Record<string, { cost: number; callCount: number; totalTokens: number }>
  byCategory: Record<string, { cost: number; callCount: number }>
  totalInputCost: number
  totalOutputCost: number
  totalCost: number
  cacheSaving: number
}

export interface CostRecord {
  id: string
  tier: ModelTier
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  inputCost: number
  outputCost: number
  cacheSaving: number
  totalCost: number
  category: string
  timestamp: number
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  dailyBudgetCny: 10,
  sessionBudgetCny: 5,
  monthlyBudgetCny: 200,
  warnThreshold: 0.8,
  overBudgetStrategy: 'degrade',
  budgetMode: 'standard',
  tierWhitelist: { ...DEFAULT_TIER_WHITELIST },
}

export const DEFAULT_USER_PRICING: UserPricing = {
  inputPricePer1k: 0.005,
  outputPricePer1k: 0.015,
  cacheHitDiscount: 0.5
}
