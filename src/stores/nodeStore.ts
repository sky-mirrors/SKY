import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ToolNode, ToolLevel, AdjacencyMap, InteractionState, DegradedState, IngestProgress, L3DecayState, JobRole, CircuitBreakerState, SchemaField, ContextCache, HistoryEntry, ConnectionFlow, L2ToolManifest } from '@/models'
import { generateAllNodes, buildAdjacencyMap, getJobRoleTemplates } from '@/data/topology'
import { vault } from '@/vault'

export const useNodeStore = defineStore('nodes', () => {
  const nodes = ref<ToolNode[]>(generateAllNodes())
  const adjacency = ref<AdjacencyMap>(buildAdjacencyMap(nodes.value))
  const interaction = ref<InteractionState>({
    hoveredNodeId: null,
    selectedNodeId: null,
    draggingNodeId: null,
    dragTargetLevel: null,
    isDragging: false,
    mouseSpeed: 0,
    onboardingPhase: 'waiting',
    selectedRole: null,
    toolUseCount: 0,
    circuitBreaker: {
      isOpen: false,
      failureCount: 0,
      lastFailureAt: 0,
      cooldownMs: 30000,
      retryCount: 0,
      maxRetries: 3
    },
    l0RedFlash: false,
    dialogMode: 'command',
    ctrlKey: false
  })
  const ingestProgress = ref<IngestProgress>({
    totalChunks: 0,
    processedChunks: 0,
    isRunning: false
  })
  const l3DecayStates = ref<L3DecayState[]>([])
  const degraded = ref<DegradedState>({
    isDegraded: false,
    unavailableToolIds: [],
    reason: ''
  })
  const history = ref<HistoryEntry[]>([])
  const flowActivePaths = ref<{ from: string; to: string; startTime: number }[]>([])
  const connectionFlows = ref<ConnectionFlow[]>([])
  const levelFilter = ref<string[]>([])
  const roleFilter = ref<string[]>([])
  const selectedNodeIds = ref<string[]>([])

  type L1WorkStatus = 'idle' | 'working' | 'success' | 'error' | 'long_running'
  const l1WorkStatus = ref<Record<string, L1WorkStatus>>({})
  const l1StatusTimers = ref<Record<string, ReturnType<typeof setTimeout>>>({})
  const l1FlashQueue = ref<string[]>([])
  const taskChainCompleteFlag = ref(false)

  function setL1Status(nodeId: string, status: L1WorkStatus) {
    l1WorkStatus.value[nodeId] = status
    if (status === 'working' || status === 'success') {
      l1FlashQueue.value.push(nodeId)
    }
    if (l1StatusTimers.value[nodeId]) {
      clearTimeout(l1StatusTimers.value[nodeId])
    }
    if (status === 'success') {
      l1StatusTimers.value[nodeId] = setTimeout(() => {
        l1WorkStatus.value[nodeId] = 'idle'
      }, 2000)
    } else if (status === 'error') {
      l1StatusTimers.value[nodeId] = setTimeout(() => {
        l1WorkStatus.value[nodeId] = 'idle'
      }, 5000)
    }
  }

  function getL1Status(nodeId: string): L1WorkStatus {
    return l1WorkStatus.value[nodeId] || 'idle'
  }

  function consumeL1Flashes(): string[] {
    const flashes = [...l1FlashQueue.value]
    l1FlashQueue.value = []
    return flashes
  }

  function markTaskChainComplete() {
    taskChainCompleteFlag.value = true
  }

  function consumeTaskChainComplete(): boolean {
    const val = taskChainCompleteFlag.value
    taskChainCompleteFlag.value = false
    return val
  }

  const l0Node = computed(() => nodes.value.find(n => n.level === ToolLevel.L0))
  const l1Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L1))
  const l2Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L2))
  const l3Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L3))

  const filteredNodes = computed(() => {
    let result = nodes.value
    if (levelFilter.value.length > 0) {
      result = result.filter(n => levelFilter.value.includes(n.level))
    }
    if (roleFilter.value.length > 0) {
      result = result.filter(n => {
        if (!n.jobRoles || n.jobRoles.length === 0) return false
        return n.jobRoles.some(r => roleFilter.value.includes(r))
      })
    }
    return result
  })

  const visibleNodeIds = computed(() => {
    if (levelFilter.value.length === 0 && roleFilter.value.length === 0) return new Set<string>(nodes.value.map(n => n.id))
    return new Set<string>(filteredNodes.value.map(n => n.id))
  })

  const selectedNode = computed(() =>
    interaction.value.selectedNodeId
      ? nodes.value.find(n => n.id === interaction.value.selectedNodeId) ?? null
      : null
  )

  const hoveredNode = computed(() =>
    interaction.value.hoveredNodeId
      ? nodes.value.find(n => n.id === interaction.value.hoveredNodeId) ?? null
      : null
  )

  function getNeighbors(nodeId: string): ToolNode[] {
    const ids = adjacency.value[nodeId] ?? []
    return ids.map(id => nodes.value.find(n => n.id === id)).filter((n): n is ToolNode => !!n)
  }

  function selectNode(nodeId: string | null) {
    interaction.value.selectedNodeId = nodeId
  }

  function hoverNode(nodeId: string | null) {
    interaction.value.hoveredNodeId = nodeId
  }

  function startDrag(nodeId: string) {
    interaction.value.draggingNodeId = nodeId
    interaction.value.isDragging = true
  }

  function endDrag() {
    interaction.value.draggingNodeId = null
    interaction.value.isDragging = false
    interaction.value.dragTargetLevel = null
  }

  function swapLevels(l2Id: string, l1Id: string) {
    const l2Node = nodes.value.find(n => n.id === l2Id)
    const l1Node = nodes.value.find(n => n.id === l1Id)
    if (!l2Node || !l1Node) return

    const savedL2Pos = { ...l2Node.position }
    l2Node.level = ToolLevel.L1
    l2Node.position = { ...l1Node.position }
    l2Node.locked = true

    l1Node.level = ToolLevel.L2
    l1Node.position = savedL2Pos
    l1Node.locked = false

    adjacency.value = buildAdjacencyMap(nodes.value)
  }

  function lockL2Tool(nodeId: string) {
    const node = nodes.value.find(n => n.id === nodeId)
    if (node && node.level === ToolLevel.L2) {
      node.locked = true
    }
  }

  function unlockL2Tool(nodeId: string) {
    const node = nodes.value.find(n => n.id === nodeId)
    if (node && node.level === ToolLevel.L2) {
      node.locked = false
    }
  }

  function applyJobRoleTemplates(jobRole: JobRole) {
    const templateIds = getJobRoleTemplates(jobRole)
    for (const node of l2Nodes.value) {
      node.locked = templateIds.includes(node.id)
    }
  }

  function setDegradedState(state: DegradedState) {
    degraded.value = state
    for (const toolId of state.unavailableToolIds) {
      const node = nodes.value.find(n => n.id === toolId)
      if (node) node.enabled = false
    }
  }

  function setMouseSpeed(speed: number) {
    interaction.value.mouseSpeed = speed
  }

  function setOnboardingPhase(phase: InteractionState['onboardingPhase']) {
    interaction.value.onboardingPhase = phase
  }

  function selectOnboardingRole(role: JobRole) {
    interaction.value.selectedRole = role
    interaction.value.onboardingPhase = 'exploding'
  }

  function incrementToolUseCount() {
    interaction.value.toolUseCount++
  }

  function setIngestProgress(progress: Partial<IngestProgress>) {
    if (progress.totalChunks !== undefined) ingestProgress.value.totalChunks = progress.totalChunks
    if (progress.processedChunks !== undefined) ingestProgress.value.processedChunks = progress.processedChunks
    if (progress.isRunning !== undefined) ingestProgress.value.isRunning = progress.isRunning
  }

  function initL3DecayStates() {
    const now = Date.now()
    l3DecayStates.value = l3Nodes.value.map(n => {
      const lastUsed = n.lastUsedAt ?? now
      const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24)
      const daysUntilCollapse = Math.max(0, 30 - daysSinceUse)
      return {
        nodeId: n.id,
        daysUntilCollapse,
        isCollapsed: daysUntilCollapse <= 0
      }
    })
  }

  function reviveL3Node(nodeId: string) {
    const state = l3DecayStates.value.find(s => s.nodeId === nodeId)
    if (state) {
      state.isCollapsed = false
      state.daysUntilCollapse = 30
    }
    const node = nodes.value.find(n => n.id === nodeId)
    if (node) {
      node.lastUsedAt = Date.now()
      node.enabled = true
    }
  }

  function anchorL3Node(nodeId: string) {
    const state = l3DecayStates.value.find(s => s.nodeId === nodeId)
    if (state) {
      state.daysUntilCollapse = 999
      state.isCollapsed = false
    }
    const node = nodes.value.find(n => n.id === nodeId)
    if (node) node.locked = true
  }

  function isInteractionAllowed(): boolean {
    return interaction.value.mouseSpeed < 1500
  }

  function setGravityWeight(nodeId: string, weight: number) {
    const node = nodes.value.find(n => n.id === nodeId)
    if (node) {
      node.gravityWeight = Math.max(0.1, Math.min(5, weight))
    }
  }

  function setNodeSchema(nodeId: string, direction: 'input' | 'output', schema: SchemaField[]) {
    const node = nodes.value.find(n => n.id === nodeId)
    if (!node) return
    if (direction === 'input') node.inputSchema = schema
    else node.outputSchema = schema
  }

  function validateSchema(data: string, schema: SchemaField[]): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    try {
      const parsed = JSON.parse(data)
      if (typeof parsed !== 'object' || parsed === null) {
        errors.push('Data must be a JSON object')
        return { valid: false, errors }
      }
      for (const field of schema) {
        if (field.required && !(field.name in parsed)) {
          errors.push(`Missing required field: ${field.name}`)
        }
        if (field.name in parsed) {
          const val = parsed[field.name]
          const actualType = Array.isArray(val) ? 'array' : typeof val
          if (actualType !== field.type && field.type !== 'markdown') {
            errors.push(`Field ${field.name} expected ${field.type}, got ${actualType}`)
          }
        }
      }
    } catch {
      // C-19：完全无法解析的数据必须判 invalid——原条件写反，schema 无 required
      // 字段时垃圾数据竟返回 {valid:true}
      errors.push('Data is not valid JSON')
    }
    return { valid: errors.length === 0, errors }
  }

  function saveContextCache(cache: ContextCache) {
    const node = nodes.value.find(n => n.id === cache.toolId)
    if (node) {
      node.contextCache = cache
      vault.writeThrough('node', `holo-context-${cache.toolId}`, JSON.stringify(cache))
    }
  }

  function loadContextCache(toolId: string): ContextCache | null {
    const node = nodes.value.find(n => n.id === toolId)
    if (node?.contextCache) return node.contextCache
    const saved = vault.readCache('node', `holo-context-${toolId}`)
    if (saved) {
      try {
        const cache = JSON.parse(saved) as ContextCache
        if (node) node.contextCache = cache
        return cache
      } catch { /* ignore */ }
    }
    return null
  }

  function clearContextCache(toolId: string) {
    const node = nodes.value.find(n => n.id === toolId)
    if (node) node.contextCache = undefined
    vault.delete('node', `holo-context-${toolId}`)
  }

  function addHistoryEntry(entry: Omit<HistoryEntry, 'id'>) {
    const full: HistoryEntry = { ...entry, id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }
    history.value.unshift(full)
    if (history.value.length > 50) history.value = history.value.slice(0, 50)
    vault.writeThrough('node', 'holo-history', JSON.stringify(history.value))
  }

  function loadHistory() {
    const saved = vault.readCache('node', 'holo-history')
    if (saved) {
      try { history.value = JSON.parse(saved) as HistoryEntry[] } catch { /* ignore */ }
    }
  }

  function addFlowPath(from: string, to: string) {
    flowActivePaths.value.push({ from, to, startTime: Date.now() })
  }

  function removeFlowPath(from: string, to: string) {
    flowActivePaths.value = flowActivePaths.value.filter(p => !(p.from === from && p.to === to))
  }

  function setL0RedFlash(flash: boolean) {
    interaction.value.l0RedFlash = flash
  }

  function updateCircuitBreaker(state: Partial<CircuitBreakerState>) {
    Object.assign(interaction.value.circuitBreaker, state)
    if (state.isOpen) {
      interaction.value.l0RedFlash = true
    }
  }

  function addConnectionFlow(from: string, to: string, type: 'data' | 'control' = 'data', isRunning: boolean = false) {
    const existing = connectionFlows.value.find(f => f.from === from && f.to === to)
    if (existing) {
      existing.type = type
      existing.isRunning = isRunning
      return
    }
    connectionFlows.value.push({ from, to, type, isRunning, startTime: Date.now() })
  }

  function removeConnectionFlow(from: string, to: string) {
    connectionFlows.value = connectionFlows.value.filter(f => !(f.from === from && f.to === to))
  }

  function setConnectionFlowRunning(from: string, to: string, running: boolean) {
    const flow = connectionFlows.value.find(f => f.from === from && f.to === to)
    if (flow) flow.isRunning = running
  }

  function setDialogMode(m: 'command' | 'plan' | 'teach') {
    interaction.value.dialogMode = m
  }

  function toggleLevelFilter(level: string) {
    const idx = levelFilter.value.indexOf(level)
    if (idx >= 0) levelFilter.value.splice(idx, 1)
    else levelFilter.value.push(level)
  }

  function toggleRoleFilter(role: string) {
    const idx = roleFilter.value.indexOf(role)
    if (idx >= 0) roleFilter.value.splice(idx, 1)
    else roleFilter.value.push(role)
  }

  function clearFilters() {
    levelFilter.value = []
    roleFilter.value = []
  }

  function toggleNodeSelection(nodeId: string) {
    const idx = selectedNodeIds.value.indexOf(nodeId)
    if (idx >= 0) selectedNodeIds.value.splice(idx, 1)
    else selectedNodeIds.value.push(nodeId)
  }

  function clearNodeSelection() {
    selectedNodeIds.value = []
  }

  const highlightedL2Ids = ref<string[]>([])

  const l2Manifests = ref<Record<string, L2ToolManifest>>({})

  // H-2：manifest id 带版本后缀（l2-xxx-v1），拓扑节点 id 不带——统一归一化，
  // 否则 getL2Manifest(拓扑节点 id) 恒 null，星图 L2 双击直达整条死路径
  // （useThreeScene 双击传入的是 hitId=拓扑节点 id，domains/node 的 get-l2-manifest 同病）。
  function normalizeL2Id(id: string): string {
    return id.replace(/-v\d+$/i, '')
  }

  function loadL2Manifests(manifests: L2ToolManifest[]) {
    for (const m of manifests) {
      const key = normalizeL2Id(m.identity.id)
      l2Manifests.value[key] = m
      const node = nodes.value.find(n => n.id === key || n.id === m.identity.id || n.name === m.identity.name)
      if (node) {
        node.description = m.routing.retrievalSummary
        node.gravityWeight = m.cacheMeta.estimatedTokenSaving / 1000
      }
    }
  }

  function getL2Manifest(nodeId: string): L2ToolManifest | null {
    return l2Manifests.value[nodeId] || l2Manifests.value[normalizeL2Id(nodeId)] || null
  }

  function getL2ManifestByName(name: string): L2ToolManifest | null {
    for (const m of Object.values(l2Manifests.value)) {
      if (m.identity.name === name) return m
    }
    return null
  }

  function getAllL2Manifests(): L2ToolManifest[] {
    return Object.values(l2Manifests.value)
  }

  function findManifestByKeywords(query: string): L2ToolManifest | null {
    const q = query.toLowerCase()
    for (const m of Object.values(l2Manifests.value)) {
      if (m.routing.keywords.some(k => q.includes(k.toLowerCase()))) return m
      if (m.routing.retrievalSummary.toLowerCase().includes(q)) return m
    }
    return null
  }

  const dagChainState = ref<{
    active: boolean
    steps: { nodeId: string; stepNum: number; status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip' }[]
    dependsOnMap: Record<number, number[]>
  }>({ active: false, steps: [], dependsOnMap: {} })

  function setDAGChain(steps: { nodeId: string; stepNum: number; status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip' }[], dependsOnMap?: Record<number, number[]>) {
    dagChainState.value = { active: true, steps, dependsOnMap: dependsOnMap || {} }
  }

  function updateDAGStep(stepNum: number, status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip') {
    const step = dagChainState.value.steps.find(s => s.stepNum === stepNum)
    if (step) step.status = status
  }

  function clearDAGChain() {
    dagChainState.value = { active: false, steps: [], dependsOnMap: {} }
  }

  function consumeDAGChainUpdate(): { stepNum: number; status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip' }[] {
    if (!dagChainState.value.active) return []
    return dagChainState.value.steps.map(s => ({ stepNum: s.stepNum, status: s.status }))
  }
  function highlightL2Candidates(ids: string[]) {
    highlightedL2Ids.value = ids
  }

  function clearL2Highlights() {
    highlightedL2Ids.value = []
  }

  function consumeL2Highlights(): string[] {
    const ids = [...highlightedL2Ids.value]
    highlightedL2Ids.value = []
    return ids
  }

  function addSelectedToDialog() {
    return selectedNodeIds.value.map(id => nodes.value.find(n => n.id === id)).filter((n): n is ToolNode => !!n)
  }

  const nodeVisualEvents = ref<Map<string, { type: 'cache_hit' | 'rule_hit'; tokensSaved: number; timestamp: number }>>(new Map())
  const sessionTokensSaved = ref(0)

  function emitNodeVisualEvent(nodeId: string, type: 'cache_hit' | 'rule_hit', tokensSaved: number) {
    nodeVisualEvents.value.set(nodeId, { type, tokensSaved, timestamp: Date.now() })
    sessionTokensSaved.value += tokensSaved
  }

  function consumeNodeVisualEvent(nodeId: string): { type: 'cache_hit' | 'rule_hit'; tokensSaved: number; timestamp: number } | null {
    const evt = nodeVisualEvents.value.get(nodeId)
    if (evt) {
      nodeVisualEvents.value.delete(nodeId)
      return evt
    }
    return null
  }

  function getVisibleL2Ids(): string[] {
    return Array.from(visibleNodeIds.value).filter(id => {
      const node = nodes.value.find(n => n.id === id)
      return node?.level === 'L2'
    })
  }

  return {
    nodes,
    adjacency,
    interaction,
    ingestProgress,
    l3DecayStates,
    degraded,
    history,
    flowActivePaths,
    l0Node,
    l1Nodes,
    l2Nodes,
    l3Nodes,
    selectedNode,
    hoveredNode,
    getNeighbors,
    selectNode,
    hoverNode,
    startDrag,
    endDrag,
    swapLevels,
    lockL2Tool,
    unlockL2Tool,
    applyJobRoleTemplates,
    setDegradedState,
    setMouseSpeed,
    isInteractionAllowed,
    setOnboardingPhase,
    selectOnboardingRole,
    incrementToolUseCount,
    setIngestProgress,
    initL3DecayStates,
    reviveL3Node,
    anchorL3Node,
    setGravityWeight,
    setNodeSchema,
    validateSchema,
    saveContextCache,
    loadContextCache,
    clearContextCache,
    addHistoryEntry,
    loadHistory,
    addFlowPath,
    removeFlowPath,
    setL0RedFlash,
    updateCircuitBreaker,
    connectionFlows,
    addConnectionFlow,
    removeConnectionFlow,
    setConnectionFlowRunning,
    setDialogMode,
    levelFilter,
    roleFilter,
    filteredNodes,
    visibleNodeIds,
    toggleLevelFilter,
    toggleRoleFilter,
    clearFilters,
    selectedNodeIds,
    toggleNodeSelection,
    clearNodeSelection,
    addSelectedToDialog,
    l1WorkStatus,
    setL1Status,
    getL1Status,
    consumeL1Flashes,
    markTaskChainComplete,
    consumeTaskChainComplete,
    highlightedL2Ids,
    highlightL2Candidates,
    clearL2Highlights,
    consumeL2Highlights,
    dagChainState,
    setDAGChain,
    updateDAGStep,
    clearDAGChain,
    consumeDAGChainUpdate,
    l2Manifests,
    loadL2Manifests,
    getL2Manifest,
    getL2ManifestByName,
    getAllL2Manifests,
    findManifestByKeywords,
    nodeVisualEvents,
    sessionTokensSaved,
    emitNodeVisualEvent,
    consumeNodeVisualEvent,
    getVisibleL2Ids
  }
})
