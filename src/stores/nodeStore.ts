import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ToolNode, ToolLevel, JobRole, InteractionState, DegradedState, HistoryEntry, ContextCache, L2ToolManifest } from '@/models'
import { generateAllNodes, getJobRoleTemplates } from '@/data/topology'
import { vault } from '@/vault'

/**
 * nodeStore：工具节点图 + L2 manifest 注册表 + 少量跨组件运行态。
 *
 * 2026-09-26（删除星图视图）：此前一半成员是 125 节点 3D 星图的专用状态——拖拽/重力/
 * 连线流/滤镜/L3 衰减/节点视觉事件/星图 DAG 动画——随 `useThreeScene` 与 `StarMap.vue`
 * 一并移除。**保留的成员都有生产引用**，消费者是：工作台 `RuntimePanel`/`StatusBar`、
 * `DialogPanel`、流水线的 `ToolSelector`、`SettingsPage`、`domains\node` 的总线处理器、
 * 以及 dialogStore 的路由上下文（`node:get-*` 系列）。
 *
 * 注意：`dagChainState` 当前**只读不写**（写入方是已删除的星图侧 `node:set-dag-chain`
 * 等频道，且这批频道在删除前就已无监听）——工作台的 DAG 卡片因此恒不显示，属既有
 * 缺陷，本次不修（见快照 §十一）。
 */
export const useNodeStore = defineStore('nodes', () => {
  const nodes = ref<ToolNode[]>(generateAllNodes())
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
  const degraded = ref<DegradedState>({
    isDegraded: false,
    unavailableToolIds: [],
    reason: ''
  })
  const history = ref<HistoryEntry[]>([])
  const flowActivePaths = ref<{ from: string; to: string; startTime: number }[]>([])
  const selectedNodeIds = ref<string[]>([])

  type L1WorkStatus = 'idle' | 'working' | 'success' | 'error' | 'long_running'
  const l1WorkStatus = ref<Record<string, L1WorkStatus>>({})
  const l1StatusTimers = ref<Record<string, ReturnType<typeof setTimeout>>>({})

  /** L1 运行态：由 domains\node 的 node:set-l1-status 桥写入，工作台 StatusBar 读取 */
  function setL1Status(nodeId: string, status: L1WorkStatus) {
    l1WorkStatus.value[nodeId] = status
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

  const l1Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L1))
  const l2Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L2))
  const l3Nodes = computed(() => nodes.value.filter(n => n.level === ToolLevel.L3))

  const selectedNode = computed(() =>
    interaction.value.selectedNodeId
      ? nodes.value.find(n => n.id === interaction.value.selectedNodeId) ?? null
      : null
  )

  function selectNode(nodeId: string | null) {
    interaction.value.selectedNodeId = nodeId
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

  function loadHistory() {
    const saved = vault.readCache('node', 'holo-history')
    if (saved) {
      try { history.value = JSON.parse(saved) as HistoryEntry[] } catch { /* ignore */ }
    }
  }

  /** DialogPanel：把画布上选中的工具送入流水线时记录的流向（星图移除后暂无读取方，保留调用点） */
  function addFlowPath(from: string, to: string) {
    flowActivePaths.value.push({ from, to, startTime: Date.now() })
  }

  function addSelectedToDialog() {
    return selectedNodeIds.value.map(id => nodes.value.find(n => n.id === id)).filter((n): n is ToolNode => !!n)
  }

  function clearNodeSelection() {
    selectedNodeIds.value = []
  }

  const l2Manifests = ref<Record<string, L2ToolManifest>>({})

  // H-2：manifest id 带版本后缀（l2-xxx-v1），拓扑节点 id 不带——统一归一化，
  // 否则按节点 id 取 manifest 恒 null（双击直达与 domains\node 的 get-l2-manifest 同病）。
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

  /** 路由在用：domains\node 的 node:get-l2-manifest 经此取真实 manifest */
  function getL2Manifest(nodeId: string): L2ToolManifest | null {
    return l2Manifests.value[nodeId] || l2Manifests.value[normalizeL2Id(nodeId)] || null
  }

  function getAllL2Manifests(): L2ToolManifest[] {
    return Object.values(l2Manifests.value)
  }

  /**
   * 星图 DAG 动画已随星图移除；此状态保留给工作台 RuntimePanel/StatusBar 读取。
   * 当前无写入方（原写入方是已无监听的 node:set-dag-chain 等频道，本次一并删除）。
   */
  const dagChainState = ref<{
    active: boolean
    steps: { nodeId: string; stepNum: number; status: 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip' }[]
    dependsOnMap: Record<number, number[]>
  }>({ active: false, steps: [], dependsOnMap: {} })

  /**
   * 路由在用（domains\node 的 node:get-visible-l2-ids ← dialogStore）。
   * 原实现经 levelFilter/roleFilter 过滤；那两个滤镜的开关已随星图 FilterBar 移除，
   * 且生产侧从无调用方，故此处直接返回全部 L2 节点 id（与滤镜恒为空时等价）。
   */
  function getVisibleL2Ids(): string[] {
    return nodes.value.filter(n => n.level === ToolLevel.L2).map(n => n.id)
  }

  return {
    nodes,
    interaction,
    degraded,
    history,
    flowActivePaths,
    l1Nodes,
    l2Nodes,
    l3Nodes,
    selectedNode,
    selectNode,
    applyJobRoleTemplates,
    setDegradedState,
    loadContextCache,
    loadHistory,
    addFlowPath,
    selectedNodeIds,
    addSelectedToDialog,
    clearNodeSelection,
    l1WorkStatus,
    setL1Status,
    dagChainState,
    l2Manifests,
    loadL2Manifests,
    getL2Manifest,
    getAllL2Manifests,
    getVisibleL2Ids
  }
})
