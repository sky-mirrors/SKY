import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ToolNode, ToolLevel, JobRole, InteractionState, DegradedState, HistoryEntry, ContextCache, L2ToolManifest } from '@/models'
import { generateAllNodes, getJobRoleTemplates } from '@/data/topology'
import { vault } from '@/vault'

export type DagStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'replanned' | 'reuse' | 'skip'
export interface DagStep { nodeId: string; stepNum: number; status: DagStepStatus }
export interface DagChainState { active: boolean; steps: DagStep[]; dependsOnMap: Record<number, number[]> }

/**
 * nodeStore：工具节点图 + L2 manifest 注册表 + 少量跨组件运行态。
 *
 * 2026-09-26（删除星图视图）：此前一半成员是 125 节点 3D 星图的专用状态——拖拽/重力/
 * 连线流/滤镜/L3 衰减/节点视觉事件/星图 DAG 动画——随 `useThreeScene` 与 `StarMap.vue`
 * 一并移除。**保留的成员都有生产引用**，消费者是：工作台 `RuntimePanel`/`StatusBar`、
 * `DialogPanel`、流水线的 `ToolSelector`、`SettingsPage`、`domains\node` 的总线处理器、
 * 以及 dialogStore 的路由上下文（`node:get-*` 系列）。
 *
 * DAG 执行链（`dagChainState`）：写入方是下面 6 个 `DAG` 函数，由 `domains\node` 把
 * `node:set-dag-chain` 等 6 条频道桥接过来。此前这 6 条 emit 全仓库无 `bus.on` 监听、
 * 且 `setDAGChain` 等写函数在 `cbb66b5` 随星图清扫被删——致工作台 DAG 卡片、状态栏计数
 * 与 DialogPanel 的 P1-24 人工暂停入口**自提交起静默失效**。本次接通（对应
 * 原 ARCHITECTURE §8.6「执行可视化链路三重断裂」（已删文档，追溯见 docs/README.md）；因星图已移除，断裂③的
 * StarMap 载荷转发不再需要）。
 */
export const useNodeStore = defineStore('nodes', () => {
  const nodes = ref<ToolNode[]>(generateAllNodes())
  const interaction = ref<InteractionState>({
    selectedNodeId: null,
    selectedRole: null
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
   * DAG 执行链状态。消费方：工作台 `RuntimePanel`（DAG 执行链卡片）、`StatusBar`（执行中
   * 计数 done/total）、`DialogPanel` P1-24（人工暂停入口——取第一个 `pending` 步骤）。
   * 写入方是下面 6 个函数（经 `domains\node` 的 6 条总线频道桥接）。
   */
  const dagChainState = ref<DagChainState>({ active: false, steps: [], dependsOnMap: {} })

  /** 建立执行链（node:set-dag-chain）。步骤/依赖做浅拷贝——避免总线载荷被后续就地改动。 */
  function setDAGChain(steps: DagStep[], dependsOnMap?: Record<number, number[]>): void {
    dagChainState.value = { active: true, steps: steps.map(s => ({ ...s })), dependsOnMap: { ...(dependsOnMap || {}) } }
  }

  /** 单步状态推进（node:update-dag-step：running/done/failed/replanned/reuse/skip）。 */
  function updateDAGStep(stepNum: number, status: DagStepStatus): void {
    const step = dagChainState.value.steps.find(s => s.stepNum === stepNum)
    if (step) step.status = status
  }

  /** 追加步骤（node:dag-chain-push-step：重规划产生的新步骤）。 */
  function pushDAGStep(step: DagStep): void {
    dagChainState.value.steps.push({ ...step })
  }

  /** 更新某步依赖（node:dag-chain-set-deps：重规划后编号重映射）。 */
  function setDAGDeps(stepNum: number, dependsOn: number[]): void {
    dagChainState.value.dependsOnMap = { ...dagChainState.value.dependsOnMap, [stepNum]: [...dependsOn] }
  }

  /**
   * 任务链收尾（node:mark-task-chain-complete，emit 点均在执行循环末尾）。
   * 把仍 `pending` 的步骤收敛为 `done`——链已结束，不应在卡片/状态栏残留"未完成"；
   * 不覆盖 `failed`/`replanned`/`reuse`/`skip` 等真实终态（不掩盖失败）。
   * 注：原实现只置一个供星图完成动画轮询的 `taskChainCompleteFlag`（与 dagChainState 无关），
   * 该轮询已随星图删除，故此处按工作台语义重新映射到链状态。
   */
  function markDAGChainComplete(): void {
    for (const s of dagChainState.value.steps) {
      if (s.status === 'pending') s.status = 'done'
    }
  }

  /** 清空执行链（node:clear-dag-chain，通常在执行收尾 3s 后）。 */
  function clearDAGChain(): void {
    dagChainState.value = { active: false, steps: [], dependsOnMap: {} }
  }

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
    setDAGChain,
    updateDAGStep,
    pushDAGStep,
    setDAGDeps,
    markDAGChainComplete,
    clearDAGChain,
    l2Manifests,
    loadL2Manifests,
    getL2Manifest,
    getAllL2Manifests,
    getVisibleL2Ids
  }
})
