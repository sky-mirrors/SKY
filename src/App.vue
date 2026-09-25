<template>
  <div class="holo-starmap">
    <div class="titlebar">
      <div class="titlebar-left">
        <span class="titlebar-text">HoloStarmap</span>
        <span class="debug-ring" :class="{ frozen: debugStore.frozen }" @click="onOpenDebugWindow" :title="debugStore.frozen ? '探针已冻结 - 点击打开调试窗口' : `探针 ${debugStore.activeProbes.length} - 点击打开调试窗口`">🔍{{ debugStore.activeProbes.length }}<span v-if="debugStore.frozen"> ❄️</span></span>
        <span class="benchmark-btn" @click="onOpenBenchmarkWindow" title="Token优化压测台">📊</span>
        <span class="rule-review-btn" @click="onOpenRuleReviewWindow" title="规则审核">⚖️</span>
        <span class="theme-toggle" @click="configStore.toggleTheme" :title="configStore.theme === 'dark' ? '切换浅色模式' : configStore.theme === 'light' ? '切换护眼模式' : '切换深色模式'">{{ configStore.theme === 'dark' ? '☀️' : configStore.theme === 'light' ? '🌿' : '🌙' }}</span>
        <span class="notification-bell" @click="notificationCenterRef?.open()" title="通知中心">🔔<span class="bell-badge" v-if="notificationStore.unreadCount > 0">{{ notificationStore.unreadCount }}</span></span>
        <span class="settings-btn" @click="settingsPageRef?.open()" title="设置">⚙️</span>
        <span class="view-toggle" v-if="uiMode === 'starmap'" @click="toggleViewMode" :title="viewMode === 'starmap' ? '切换到结果预览' : '切换到星图'">{{ viewMode === 'starmap' ? '📊' : '🌌' }}</span>
        <span class="view-toggle" @click="toggleMainMode" :title="uiMode === 'workbench' ? '切换到星图模式' : '切换到工作台模式'">{{ uiMode === 'workbench' ? '🌌' : '🛠' }}</span>
      </div>
      <div class="titlebar-controls">
        <button class="tb-btn tb-minimize" @click="minimizeWindow">─</button>
        <button class="tb-btn tb-maximize" @click="maximizeWindow">□</button>
        <button class="tb-btn tb-close" @click="closeWindow">✕</button>
      </div>
    </div>
    <!-- R16 工作台模式（默认）：左导航 + 中对话 + 右运行时面板 + 状态栏 -->
    <WorkbenchShell
      v-if="uiMode === 'workbench'"
      @open-mcp="onOpenMcp"
      @camera-fly-to="onCameraFlyTo"
      @open-preview="openPreview"
      @open-api-settings="apiSettingsRef?.open(apiStore.config.baseUrl)"
    />
    <!-- 星图模式：原有全部悬浮层（整体门控，工作台下卸载释放 GPU） -->
    <template v-if="uiMode === 'starmap'">
    <DialogPanel @open-mcp="onOpenMcp" @camera-fly-to="onCameraFlyTo" @panel-width-changed="onPanelWidthChanged" @open-preview="openPreview" />
    <FilterBar />
    <StarMap
      v-show="viewMode === 'starmap'"
      :panel-width="dialogPanelWidth"
      @node-click="onNodeClick"
      @node-hover="onNodeHover"
      @ready="onStarMapReady"
    />
    <DebugProbePanel />
    <div class="node-tooltip" v-if="tooltipInfo" :style="{ left: tooltipInfo.screenX + 12 + 'px', top: tooltipInfo.screenY - 28 + 'px' }">
      {{ tooltipInfo.label }}
    </div>
    <button class="camera-reset-btn" @click="onCameraReset" title="重置视角 (Esc)">↺</button>
    <NodeDetailPanel
      :node="detailNode"
      :degraded="nodeStore.degraded.isDegraded"
      :circuit-breaker-open="apiStore.isCircuitOpen"
      @lock="onLockTool"
      @unlock="onUnlockTool"
      @set-gravity="onSetGravity"
      @resume-context="onResumeContext"
      @clear-context="onClearContext"
    />
    <div class="kernel-status-orb" @click="showKernelDetail = !showKernelDetail">
      <span class="orb-dot" :class="memoryWarning ? 'warning' : kernelState"></span>
      <span class="orb-label">{{ memoryWarning ? '内存!' : kernelLabel }}</span>
    </div>
    <div class="circuit-breaker-indicator" v-if="apiStore.isCircuitOpen" @click="apiStore.resetCircuitBreaker()" title="API 暂时不可用（熔断器已开启）— 点击重置">
      <span class="cb-dot"></span>
      <span class="cb-label">熔断</span>
    </div>
    <div class="kernel-detail-popup" v-if="showKernelDetail">
      <div class="kd-row"><span>嵌入模型</span><span :class="kernelState">{{ embedderStatus }}</span></div>
      <div class="kd-row"><span>检索模式</span><span>{{ retrievalMode }}</span></div>
      <div class="kd-row"><span>向量索引</span><span>{{ vectorIndexStatus }}</span></div>
      <div class="kd-row" v-if="memoryUsage"><span>内存</span><span>{{ memoryUsage }}</span></div>
    </div>
    </template>
    <!-- 公共层：预览/弹窗/设置（跨模式共享） -->
    <ResultPreviewStage
      v-if="viewMode === 'preview'"
      :message="previewMessage"
      @close="configStore.setViewMode('starmap')"
    />
    <ApiSettings ref="apiSettingsRef" @saved="onApiSaved" />
    <Notification ref="notificationRef" />
    <NotificationCenter ref="notificationCenterRef" />
    <CommandPalette ref="commandPaletteRef" />
    <SettingsPage ref="settingsPageRef" />
    <OnboardingWizard ref="onboardingWizardRef" />
    <L0Modal ref="l0ModalRef" @skill-installed="onSkillInstalled" @mcp-connected="onMcpConnected" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { defineAsyncComponent } from 'vue'
const StarMap = defineAsyncComponent({
  loader: () => import('./components/StarMap.vue'),
  delay: 300,
  timeout: 10000
})
import NodeDetailPanel from './components/NodeDetailPanel.vue'
import ApiSettings from './components/ApiSettings.vue'
import Notification from './components/Notification.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import CommandPalette from './components/CommandPalette.vue'
import SettingsPage from './components/SettingsPage.vue'
import OnboardingWizard from './components/OnboardingWizard.vue'
import DialogPanel from './components/DialogPanel.vue'
import WorkbenchShell from './components/workbench/WorkbenchShell.vue'
import L0Modal from './components/L0Modal.vue'
import FilterBar from './components/FilterBar.vue'
  import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useConfigStore } from '@/domains/config'
import { useMemoryStore } from '@/domains/memory'
import { useKnowledgeStore } from '@/domains/knowledge'
import { useSkillStore } from '@/domains/app'
import { useMcpStore } from '@/domains/mcp'
import { useDialogStore } from '@/domains/dialog'
import { useNotificationStore } from '@/domains/app'
import { useWorkflowLogStore } from '@/domains/app'
import { L2ToolManifest, DialogMessage, ChatMessage, Pipeline } from '@/models'
import { executePipeline } from '@/domains/pipeline'
import { usePipelineStore, registerPipelineExecutor } from '@/domains/pipeline'
import { useDebugStore } from '@/domains/debug'
import DebugProbePanel from '@/components/DebugProbePanel.vue'
import ResultPreviewStage from '@/components/ResultPreviewStage.vue'
import { initFileContextWatch } from '@/domains/node'
import { debugLog } from '@/domains/debug'
import { createKernel, globalBus } from '@/kernel'
import { initKernelRuntime, kernelRegistry } from '@/host/kernelRuntime'
import { initPackRuntime, packLoader } from '@/host/packRuntime'
import { initPackHookBridge } from '@/host/packHookBridge'
import { qualityEmaStore } from '@/kernel/competition'
import { registerApiHandlers } from '@/domains/api/handlers'
import { registerAppHandlers } from '@/domains/app/handlers'
import { registerConfigHandlers } from '@/domains/config/handlers'
import { shouldShowOnboarding } from '@/services/onboardingManager'
import { initPricingFromVault } from '@/services/tokenPricing'
import { registerDataHandlers } from '@/domains/data/handlers'
import { registerDebugHandlers } from '@/domains/debug/handlers'
import { registerDialogHandlers } from '@/domains/dialog/handlers'
import { registerFeedbackHandlers } from '@/domains/feedback/handlers'
import { registerKnowledgeHandlers } from '@/domains/knowledge/handlers'
import { registerMcpHandlers } from '@/domains/mcp/handlers'
import { registerMemoryHandlers } from '@/domains/memory/handlers'
import { registerNodeHandlers } from '@/domains/node/handlers'
import { registerPipelineHandlers } from '@/domains/pipeline/handlers'

const nodeStore = useNodeStore()
const apiStore = useApiStore()
const configStore = useConfigStore()
const pipelineStore = usePipelineStore()
const memoryStore = useMemoryStore()
const knowledgeStore = useKnowledgeStore()
const skillStore = useSkillStore()
const mcpStore = useMcpStore()
const dialogStore = useDialogStore()
const workflowLogStore = useWorkflowLogStore()
const debugStore = useDebugStore()
const notificationStore = useNotificationStore()

const apiSettingsRef = ref()
const notificationRef = ref()
const commandPaletteRef = ref()
const notificationCenterRef = ref()
const settingsPageRef = ref()
const onboardingWizardRef = ref()
const starMapRef = ref()
const showKernelDetail = ref(false)
const dialogPanelWidth = ref(configStore.config.dialogPanelWidth ?? 460)
const viewMode = computed(() => configStore.viewMode)
const uiMode = computed(() => configStore.uiMode)
const previewMessage = ref<DialogMessage | null>(null)

// R16：工作台↔星图主模式切换；离开星图时清 starMapRef（星图已卸载，防止探针/DAG 定时器调用失效场景 API）
watch(uiMode, mode => {
  if (mode === 'workbench') {
    starMapRef.value = undefined
  }
})

function toggleMainMode() {
  configStore.setUiMode(uiMode.value === 'workbench' ? 'starmap' : 'workbench')
}

const kernelState = ref<'loaded' | 'degraded' | 'loading'>('loading')
const embedderStatus = ref('加载中...')
const retrievalMode = ref('关键词(伪向量)')
const vectorIndexStatus = ref('未构建')
const memoryUsage = ref('')
const memoryWarning = ref(false)

function checkMemoryPressure() {
  try {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    if (perf.memory) {
      const used = Math.round(perf.memory.usedJSHeapSize / 1048576)
      const total = Math.round(perf.memory.jsHeapSizeLimit / 1048576)
      const ratio = perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit
      memoryUsage.value = `${used}MB / ${total}MB`
      if (ratio > 0.7 && !memoryWarning.value) {
        memoryWarning.value = true
        dialogStore.addSystemNotice(`⚠️ 内存压力过高(${Math.round(ratio*100)}%)，建议保存工作并重启应用`)
      }
      if (ratio < 0.6) memoryWarning.value = false
    }
  } catch { /* ignore */ }
}

async function updateKernelStatus() {
  try {
    const { isEmbedderReady } = await import('@/domains/knowledge')
    if (isEmbedderReady()) {
      kernelState.value = 'loaded'
      embedderStatus.value = '已加载'
      retrievalMode.value = '精确向量'
    } else {
      kernelState.value = 'degraded'
      embedderStatus.value = '降级(伪向量)'
      retrievalMode.value = '关键词(伪向量)'
    }
  } catch {
    kernelState.value = 'degraded'
    embedderStatus.value = '降级(伪向量)'
  }
  try {
    const { getKnowledgeEntries } = await import('@/services/knowledgeBase')
    vectorIndexStatus.value = `${getKnowledgeEntries().length} 条目`
  } catch { /* ignore */ }
  try {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    if (perf.memory) {
      const used = Math.round(perf.memory.usedJSHeapSize / 1048576)
      const total = Math.round(perf.memory.jsHeapSizeLimit / 1048576)
      memoryUsage.value = `${used}MB / ${total}MB`
    }
  } catch { /* ignore */ }
  checkMemoryPressure()
}

const _appTimers: ReturnType<typeof setInterval>[] = []
_appTimers.push(setInterval(updateKernelStatus, 10000))
setTimeout(updateKernelStatus, 5000)

const kernelLabel = computed(() => {
  switch (kernelState.value) {
    case 'loaded': return '精确'
    case 'degraded': return '降级'
    case 'loading': return '...'
  }
})
const l0ModalRef = ref()

const detailNode = computed(() => {
  const hovered = nodeStore.hoveredNode
  const selected = nodeStore.selectedNode
  return hovered || selected
})

function minimizeWindow() {
  window.electronAPI?.windowMinimize()
}

function onOpenDebugWindow() {
  window.electronAPI?.openDebugWindow()
}

function onOpenBenchmarkWindow() {
  window.electronAPI?.openBenchmarkWindow()
}

function onOpenRuleReviewWindow() {
  window.electronAPI?.openRuleReviewWindow()
}

function maximizeWindow() {
  window.electronAPI?.windowMaximize()
}

function closeWindow() {
  window.electronAPI?.windowClose()
}

function onStarMapReady(api: any) {
  starMapRef.value = api
  if (api.hoveredNodeInfo) {
    watch(api.hoveredNodeInfo, (val) => {
      tooltipInfo.value = val
    })
  }
  if (configStore.isFirstLaunch && shouldShowOnboarding()) {
    api.startOnboarding()
    onboardingWizardRef.value?.open()
  }
}

function onNodeClick(nodeId: string, ctrlKey: boolean) {
  const node = nodeStore.nodes.find(n => n.id === nodeId)
  if (!node) return

  if (ctrlKey && node.level !== 'L0') {
    nodeStore.toggleNodeSelection(nodeId)
    return
  }

  if (node.level === 'L0') {
    l0ModalRef.value?.open()
    nodeStore.selectNode(nodeId)
    return
  }

  if (node.id === 'l1-model-gateway') {
    apiSettingsRef.value?.open(apiStore.config.baseUrl)
    nodeStore.selectNode(nodeId)
    return
  }

  nodeStore.selectNode(nodeId)
}

function onNodeHover(_nodeId: string | null) {
}

function checkContextResume(toolId: string) {
  const cache = nodeStore.loadContextCache(toolId)
  if (cache && cache.stepIndex < cache.totalSteps) {
    notificationRef.value?.show(`检测到未完成的上下文碎片(${cache.stepIndex}/${cache.totalSteps})，可从断点恢复`, 4000)
  }
}

function onLockTool(nodeId: string) {
  nodeStore.lockL2Tool(nodeId)
  configStore.addSelectedL2(nodeId)
  notificationRef.value?.show('已锁定到你的配置', 2000)
}

function onUnlockTool(nodeId: string) {
  nodeStore.unlockL2Tool(nodeId)
  configStore.removeSelectedL2(nodeId)
  notificationRef.value?.show('已取消锁定', 2000)
}

function onSetGravity(nodeId: string, weight: number) {
  nodeStore.setGravityWeight(nodeId, weight)
  starMapRef.value?.rebuildNode(nodeId)
}

function onResumeContext(nodeId: string) {
  const cache = nodeStore.loadContextCache(nodeId)
  if (cache) {
    notificationRef.value?.show(`已从碎片恢复: 步骤 ${cache.stepIndex}/${cache.totalSteps}`, 3000)
  } else {
    notificationRef.value?.show('未找到可恢复的上下文碎片', 2000)
  }
}

function onClearContext(nodeId: string) {
  nodeStore.clearContextCache(nodeId)
  notificationRef.value?.show('上下文缓存已清除', 2000)
}

function onApiSaved() {
  apiStore.checkConnection().then((ok) => {
    if (ok) {
      apiStore.saveToStorage()
      notificationRef.value?.show('模型网关已连接', 2000)
      if (nodeStore.degraded.isDegraded) {
        nodeStore.setDegradedState({
          isDegraded: false,
          unavailableToolIds: [],
          reason: ''
        })
        starMapRef.value?.setDegradedVisuals(false)
      }
      nodeStore.setL0RedFlash(false)
      nodeStore.updateCircuitBreaker({ isOpen: false, failureCount: 0, retryCount: 0 })
    } else {
      notificationRef.value?.show('AI 大脑离线，已切换本地规则模式', 3000)
      nodeStore.setDegradedState({
        isDegraded: true,
        unavailableToolIds: nodeStore.nodes
          .filter(n => n.apiRole && n.apiRole !== 'renderer' && n.apiRole !== 'context_preparer')
          .map(n => n.id),
        reason: 'API不可达'
      })
      starMapRef.value?.setDegradedVisuals(true)
    }
  }).catch(() => {})
}

function onOpenMcp() {
  l0ModalRef.value?.open()
}

function onCameraFlyTo(nodeId: string) {
  if (starMapRef.value?.flyToNode) {
    starMapRef.value.flyToNode(nodeId)
  }
}

function onCameraReset() {
  if (starMapRef.value?.resetCamera) {
    starMapRef.value.resetCamera()
  }
  nodeStore.selectNode(null)
}

function onPanelWidthChanged(width: number) {
  dialogPanelWidth.value = width
  configStore.setDialogPanelWidth(width)
}

function toggleViewMode() {
  configStore.setViewMode(viewMode.value === 'starmap' ? 'preview' : 'starmap')
}

function openPreview(msg: DialogMessage) {
  previewMessage.value = msg
  configStore.setViewMode('preview')
}

const tooltipInfo = ref<{ screenX: number; screenY: number; label: string } | null>(null)

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'p' && e.ctrlKey && !e.shiftKey) {
    e.preventDefault()
    // D-11：唯一 Ctrl+P 监听改为 toggle——原与 CommandPalette 内部监听冲突，
    // 子组件先关、父组件随即强制重开，面板无法用快捷键关闭
    if (commandPaletteRef.value?.visible) {
      commandPaletteRef.value?.close()
    } else {
      commandPaletteRef.value?.open()
    }
    return
  }
  if (e.key === 'Escape') {
    if (commandPaletteRef.value?.visible) {
      commandPaletteRef.value?.close()
      return
    }
    if (settingsPageRef.value?.visible) {
      settingsPageRef.value?.close()
      return
    }
    if (notificationCenterRef.value?.visible) {
      notificationCenterRef.value?.close()
      return
    }
    // P1-47：补齐 L0 / API 设置弹层的 Esc 关闭（此前 Esc 会穿透到相机重置）
    if (l0ModalRef.value?.visible) {
      l0ModalRef.value?.close()
      return
    }
    if (apiSettingsRef.value?.visible) {
      apiSettingsRef.value?.close()
      return
    }
    if (viewMode.value === 'preview') {
      configStore.setViewMode('starmap')
      return
    }
    onCameraReset()
  }
  if (e.key === 'Enter' && e.ctrlKey && nodeStore.selectedNodeIds.length > 0) {
    // D-17：焦点在输入类控件内时组合键应交给控件本身，
    // 否则文本框内 Ctrl+Enter 会误开流水线窗口并清空当前选择
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
      return
    }
    const nodes = nodeStore.addSelectedToDialog()
    if (nodes.length > 0) {
      window.electronAPI?.openPipelineWindow?.()
      for (const n of nodes) {
        window.electronAPI?.pipelineAddNode?.({
          toolId: n.id,
          toolName: n.name,
          toolLevel: n.level
        })
      }
      nodeStore.clearNodeSelection()
    }
  }
}

function onSkillInstalled(skillId: string) {
  dialogStore.insertSystemMessage(`新技能已安装，可在星图上使用`)
  notificationRef.value?.show('技能安装成功', 2000)
}

function onMcpConnected(mcpId: string) {
  const conn = mcpStore.connections.find(c => c.id === mcpId)
  if (conn) {
    dialogStore.insertSystemMessage(`已连接 MCP: ${conn.name}，${conn.tools.length} 个工具可用`)
    notificationRef.value?.show(`MCP ${conn.name} 已连接`, 2000)
  }
}

function onHoloOpenSettings() {
  settingsPageRef.value?.open()
}

function onHoloToggleMode() {
  toggleViewMode()
}

function onHoloOpenNotifications() {
  notificationCenterRef.value?.open()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('holo-open-settings', onHoloOpenSettings)
  window.addEventListener('holo-toggle-mode', onHoloToggleMode)
  window.addEventListener('holo-open-notifications', onHoloOpenNotifications)

  configStore.loadFromStorage()
  apiStore.loadFromStorage()
  pipelineStore.loadFromStorage()
  registerPipelineExecutor(executePipeline)

  // P1-26：接收流水线窗口"运行当前画布"请求——内核/LLM 网关只在主窗口注册，画布执行必须由主窗口代跑。
  // 节点顺序即拓扑序（流水线窗口发送前已排序），executePipeline 按 serial 链式执行；进度事件回传流水线窗口。
  window.electronAPI?.onPipelineRunRequest?.((data) => {
    const nodes = data.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return
    const transientPipeline: Pipeline = {
      id: `canvas-run-${Date.now()}`,
      name: '画布运行',
      steps: nodes.map(n => ({ toolId: n.toolId, params: n.params, outputKey: n.outputKey })),
      mode: 'serial',
      createdAt: Date.now(),
      attachedEntryIds: []
    }
    executePipeline(transientPipeline, (stepId, msg) => {
      window.electronAPI?.pipelineRunProgress?.({ type: 'progress', stepId, msg })
    })
      .then((results) => {
        window.electronAPI?.pipelineRunProgress?.({ type: 'done', results })
      })
      .catch((err) => {
        window.electronAPI?.pipelineRunProgress?.({ type: 'error', error: String(err) })
      })
  })

  nodeStore.loadHistory()
  memoryStore.loadFromStorage()
  knowledgeStore.loadFromStorage()
  skillStore.loadFromStorage()
  mcpStore.loadFromStorage()
  dialogStore.loadFromStorage()
  dialogStore.initSession()
  workflowLogStore.loadFromStorage()

  // 2026-09-25（机制体检）：把持久化的用户计价读回来——此前 setUserPricing 会落盘，
  // 但全仓没有任何 load 被调用（写而不读），重启即丢。设置在「设置 → 计价」。
  initPricingFromVault().catch(err => console.warn('[pricing] 用户计价装载失败:', err))

  const kernel = createKernel()
  // A2-9：pack veto 钩子桥在内核与 pack 运行时均就绪后启动（桥内部 fail-open，失败不阻塞启动）
  Promise.all([initKernelRuntime(), initPackRuntime()])
    .then(() => { initPackHookBridge() })
    .catch(err => console.error('[kernel-runtime] 初始化失败:', err))
  // M16：质量 EMA 存储装载（main.ts syncFromVault 已在 mount 前完成；读不到的键回退 1.0）
  qualityEmaStore.load().catch(err => console.warn('[competition] EMA 存储装载失败:', err))

  // P3.6 手动 dev 演练入口：控制台经 window.__holoHotplug 操作换内核 / pack 热重载 / override 演示
  if (import.meta.env.DEV) {
    ;(window as unknown as { __holoHotplug: unknown }).__holoHotplug = { kernelRegistry, packLoader }
  }
  registerApiHandlers(globalBus)
  registerAppHandlers(globalBus)
  registerConfigHandlers(globalBus)
  // R16：工作台模式下 StarMap 不挂载，首启引导由工作台直接打开（星图模式的引导仍由 onStarMapReady 触发）
  // 2026-09-25（机制体检）：改用 onboardingManager.shouldShowOnboarding()——须在 registerConfigHandlers 之后调用
  // （该函数经 bus.request 读取，处理器未注册时会抛）。
  if (configStore.isFirstLaunch && shouldShowOnboarding() && configStore.uiMode === 'workbench') {
    onboardingWizardRef.value?.open()
  }
  registerDataHandlers(globalBus)
  registerDebugHandlers(globalBus)
  registerDialogHandlers(globalBus)
  registerFeedbackHandlers(globalBus)
  registerKnowledgeHandlers(globalBus)
  registerMcpHandlers(globalBus)
  registerMemoryHandlers(globalBus)
  registerNodeHandlers(globalBus)
  registerPipelineHandlers(globalBus)
  kernel.registerLLM({
    chatCompletion: async (messages, options) => {
      const chatMessages: ChatMessage[] = messages.map(m => ({ role: m.role as ChatMessage['role'], content: m.content, timestamp: Date.now() }))
      // S-6（2026-09-24）：取消信号进适配器——原第 5 参（externalSignal）写死 undefined，
      // 内核取消链到此断开；现按 LLMCallOptions.signal 透传。
      const result = await apiStore.chatCompletion(chatMessages, true, undefined, options?.maxTokens, options?.signal, { taskType: options?.taskType, domain: options?.domain, callerId: options?.callerId, traceId: options?.traceId })
      return {
        content: result.content,
        tier: options?.tier ?? 'standard',
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      }
    },
    chatCompletionStream: async (messages, options) => {
      const chatMessages: ChatMessage[] = messages.map(m => ({ role: m.role as ChatMessage['role'], content: m.content, timestamp: Date.now() }))
      const chunks: string[] = []
      let resolveNext: (() => void) | null = null
      let finished = false
      let streamError: Error | null = null
      await apiStore.chatCompletionStream(chatMessages, {
        onChunk: (chunk) => {
          if (chunk.delta) {
            chunks.push(chunk.delta)
            resolveNext?.()
          }
        },
        onDone: () => {
          finished = true
          resolveNext?.()
        },
        onError: (err) => {
          streamError = err
          finished = true
          resolveNext?.()
        }
      }, undefined, undefined, options?.signal, { taskType: options?.taskType, domain: options?.domain, callerId: options?.callerId, traceId: options?.traceId })
      async function* stream(): AsyncGenerator<string> {
        while (true) {
          if (chunks.length > 0) {
            yield chunks.shift()!
            continue
          }
          if (finished) {
            if (streamError) throw streamError
            return
          }
          await new Promise<void>((resolve) => { resolveNext = resolve })
        }
      }
      return stream()
    },
    listModels: async () => apiStore.config.models.map(m => ({ id: m.id, name: m.name }))
  })
  // P0-7：vault 同步已前移至 main.ts（mount 之前），此处不再重复同步

  window._holoStarMapDblClickCommand = (command: string) => {
    dialogStore.sendMessage(command)
  }

  debugStore.activate()
  try {
    const { initSemanticCache } = await import('@/services/semanticCache')
    initSemanticCache()
  } catch { /* non-critical */ }
  try {
    const { initSmartRouter } = await import('@/services/smartRouter')
    initSmartRouter()
  } catch { /* non-critical */ }
  debugStore.updateEnvironment({
    model: apiStore.config.activeModel || '',
    provider: apiStore.config.activeProviderId || '',
    apiReachable: apiStore.isReady,
    nodeCount: nodeStore.nodes.length,
    manifestCount: nodeStore.getAllL2Manifests().length
  })
  debugStore.emitEvent('info', 'system', '[App] 应用启动完成，调试中心已自动激活')

  initFileContextWatch()

  let lastProbeCount = 0
  watch(() => debugStore.activeProbes.length, (newLen) => {
    if (newLen > lastProbeCount && starMapRef.value?.triggerProbeFlash) {
      const latestProbe = debugStore.activeProbes[debugStore.activeProbes.length - 1]
      if (latestProbe) {
        const l2Nodes = nodeStore.nodes.filter(n => n.level === 'L2')
        const matchedNode = l2Nodes.find(n => n.id === latestProbe.manifestId)
        if (matchedNode) {
          starMapRef.value.triggerProbeFlash(matchedNode.id)
        } else {
          starMapRef.value.triggerProbeFlash('l1-model-gateway')
        }
      }
    }
    lastProbeCount = newLen
  })

  // Load L2 manifests from bundled data
  let l2Manifests: any[] = []
  try {
    const { default: loaded } = await import('@/data/l2Manifests')
    l2Manifests = loaded || []
    if (l2Manifests.length > 0) {
      nodeStore.loadL2Manifests(l2Manifests)
      dialogStore.insertSystemMessage(`📦 已加载${l2Manifests.length}个L2宏模板`)
    }
  } catch { /* manifests not available yet */ }

  // Pre-build L2 vector index in background (non-blocking)
  if (l2Manifests.length > 0) {
    const lazyBuild = () => {
      import('@/domains/node').then(({ buildL2Index }) => {
        buildL2Index(l2Manifests).then(() => {
          debugLog(`[App] L2向量索引预构建完成 (${l2Manifests.length}个清单)`)
        }).catch(() => {})
      }).catch(() => {})
    }
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback!(lazyBuild, { timeout: 3000 })
    } else {
      setTimeout(lazyBuild, 2000)
    }
  }

  // Self-test: verify IPC vector read/write roundtrip
  try {
    if (window.electronAPI?.vectorWriteBin && window.electronAPI?.vectorReadBin) {
      const testVec = new Float32Array([1.5, -2.3, 0.0, 4.1, -0.5])
      const buf = new ArrayBuffer(testVec.byteLength)
      new Float32Array(buf).set(testVec)
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const b64 = btoa(binary)
      const wOk = await window.electronAPI.vectorWriteBin('_selftest', b64)
      if (wOk) {
        const raw = await window.electronAPI.vectorReadBin('_selftest')
        if (raw) {
          const ab = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw
          const readBack = new Float32Array(ab)
          let match = readBack.length === testVec.length
          if (match) {
            for (let i = 0; i < testVec.length; i++) {
              if (Math.abs(readBack[i] - testVec[i]) > 0.001) { match = false; break }
            }
          }
          if (match) {
            debugLog('[SelfTest] ✅ IPC vector read/write roundtrip OK')
          } else {
            console.warn('[SelfTest] ❌ IPC vector roundtrip mismatch', testVec, readBack)
            debugStore.emitEvent('warn', 'system', '向量存储自检：读写数据不一致，请检查IPC通道')
          }
        }
      }
    }
  } catch (e) {
    console.warn('[SelfTest] vector IPC test failed:', e)
  }

  // Migrate localStorage to file store
  try {
    const { migrateFromLocalStorage } = await import('@/services/secureStore')
    const count = await migrateFromLocalStorage(['api-config'])
    if (count > 0) {
      dialogStore.insertSystemMessage(`🔒 已迁移${count}项配置到安全存储`)
    }
  } catch { /* migration not critical */ }

  nodeStore.initL3DecayStates()

  for (const node of nodeStore.l1Nodes) {
    checkContextResume(node.id)
  }

  if (apiStore.isReady) {
    dialogStore.insertSystemMessage(`已连接模型引擎: ${apiStore.config.activeModel}`)
  } else if (apiStore.config.activeProviderId && apiStore.config.activeModel) {
    apiStore.checkConnection().then(ok => {
      if (ok) {
        dialogStore.insertSystemMessage(`已连接模型引擎: ${apiStore.config.activeModel}`)
      }
    }).catch(() => {})
  }

  setTimeout(() => {
    mcpStore.autoRestartCatalogMcp()
  }, 2000)

  let dagChainTriggered = false

  _appTimers.push(setInterval(() => {
    if (!starMapRef.value) return
    const flashes = nodeStore.consumeL1Flashes()
    for (const nodeId of flashes) {
      starMapRef.value.triggerL1Flash(nodeId)
    }
    if (nodeStore.consumeTaskChainComplete()) {
      starMapRef.value.triggerConvergenceBeam()
    }
    const l2Candidates = nodeStore.consumeL2Highlights()
    if (l2Candidates.length > 0) {
      starMapRef.value.highlightL2Candidates(l2Candidates)
    }
    // Sync DAG chain state to 3D scene
    if (nodeStore.dagChainState.active && starMapRef.value.triggerDAGChain) {
      if (!dagChainTriggered) {
        const dagSteps = nodeStore.dagChainState.steps
        const dependsOnMap = nodeStore.dagChainState.dependsOnMap
        if (dagSteps.length > 0) {
          const fullSteps = dagSteps.map(s => ({
            nodeId: s.nodeId,
            stepNum: s.stepNum,
            dependsOn: dependsOnMap[s.stepNum] || []
          }))
          starMapRef.value.triggerDAGChain(fullSteps)
          dagChainTriggered = true
        }
      }
      for (const step of nodeStore.dagChainState.steps) {
        if (starMapRef.value.setDAGStepStatus) {
          starMapRef.value.setDAGStepStatus(step.stepNum, step.status)
        }
      }
    }
    if (!nodeStore.dagChainState.active && dagChainTriggered) {
      if (starMapRef.value.clearDAGChain) starMapRef.value.clearDAGChain()
      dagChainTriggered = false
    }
  }, 100))

  const proactiveMod = await import('@/services/proactiveScheduler')
  proactiveMod.loadPersistedState()
  const scheduleMod = await import('@/services/scheduleOptimizer')
  scheduleMod.loadPersistedFingerprints().catch(() => {})
  const l2Mod = await import('@/data/l2Manifests')
  l2Mod.initCustomManifests()

  if (window.electronAPI?.onWatchfsChanged) {
    window.electronAPI.onWatchfsChanged((data: { event: string; filename: string; path: string }) => {
      debugStore.emitEvent('info', 'system', `文件变更: ${data.path}`)
    })
  }
  if (window.electronAPI?.onGlobalQuickInput) {
    window.electronAPI.onGlobalQuickInput(() => {
      const input = document.querySelector('.chat-input textarea') as HTMLTextAreaElement | null
      if (input) input.focus()
    })
  }
})

onUnmounted(() => {
  for (const t of _appTimers) clearInterval(t)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('holo-open-settings', onHoloOpenSettings)
  window.removeEventListener('holo-toggle-mode', onHoloToggleMode)
  window.removeEventListener('holo-open-notifications', onHoloOpenNotifications)
})</script>

<style>
html, body, #app {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #050510;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  color: #e0e0e0;
}

.holo-starmap {
  position: relative;
  width: 100%;
  height: 100%;
}

.titlebar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 28px;
  z-index: 2000;
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(5, 5, 16, 0.4);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: drag;
}

.titlebar-text {
  font-size: 11px;
  color: rgba(130, 170, 220, 0.35);
  padding-left: 12px;
  letter-spacing: 1.5px;
  font-weight: 300;
  user-select: none;
}

.titlebar-controls {
  -webkit-app-region: no-drag;
  display: flex;
  height: 100%;
}

.tb-btn {
  width: 40px;
  height: 28px;
  border: none;
  background: transparent;
  color: rgba(130, 170, 220, 0.4);
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.tb-btn:hover {
  background: rgba(80, 140, 220, 0.15);
  color: rgba(180, 210, 255, 0.8);
}
.tb-close:hover {
  background: rgba(220, 60, 60, 0.25);
  color: rgba(255, 120, 120, 0.9);
}

.debug-ring {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  height: 22px;
  border-radius: 10px;
  border: 2px solid rgba(100, 180, 255, 0.7);
  cursor: pointer;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.5px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(100, 180, 255, 0.2);
  color: #88ccff;
  padding: 0 8px;
  transition: all 0.2s;
  text-shadow: 0 0 6px rgba(100, 180, 255, 0.6);
  box-shadow: 0 0 4px rgba(100, 180, 255, 0.3);
}
.debug-ring:hover {
  background: rgba(100, 180, 255, 0.35);
  color: #aaddff;
}
.debug-ring.frozen {
  border-color: rgba(255, 80, 80, 0.9);
  background: rgba(255, 40, 40, 0.4);
  color: #ff4444;
  text-shadow: 0 0 6px rgba(255, 50, 50, 0.8);
  box-shadow: 0 0 4px rgba(255, 50, 50, 0.5);
  animation: debug-pulse 2s ease-in-out infinite;
}
.debug-ring.frozen:hover {
  background: rgba(255, 30, 30, 0.5);
  color: #ff2222;
}
.benchmark-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 10px;
  border: 1px solid rgba(255, 200, 50, 0.5);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(255, 200, 50, 0.1);
  transition: all 0.2s;
}
.benchmark-btn:hover {
  background: rgba(255, 200, 50, 0.25);
  border-color: rgba(255, 200, 50, 0.8);
}
.rule-review-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 10px;
  border: 1px solid rgba(0, 204, 255, 0.5);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(0, 204, 255, 0.1);
  transition: all 0.2s;
}
.rule-review-btn:hover {
  background: rgba(0, 204, 255, 0.25);
  border-color: rgba(0, 204, 255, 0.8);
}

@keyframes debug-pulse {
  0%, 100% { box-shadow: 0 0 8px rgba(255, 30, 30, 0.3); }
  50% { box-shadow: 0 0 20px rgba(255, 30, 30, 0.6); }
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(220, 200, 80, 0.7);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(200, 180, 60, 0.1);
  transition: all 0.2s;
}
.theme-toggle:hover {
  border-color: #ffcc44;
  background: rgba(255, 200, 50, 0.25);
}
.view-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(80, 180, 220, 0.7);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(60, 140, 200, 0.1);
  transition: all 0.2s;
}
.view-toggle:hover {
  border-color: #44ccff;
  background: rgba(50, 180, 255, 0.25);
}
.notification-bell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(255, 150, 50, 0.7);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(255, 150, 50, 0.1);
  transition: all 0.2s;
  position: relative;
}
.notification-bell:hover {
  border-color: #ffaa44;
  background: rgba(255, 150, 50, 0.25);
}
.bell-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: #ff4444;
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  line-height: 1;
}
.settings-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(150, 150, 200, 0.5);
  cursor: pointer;
  font-size: 12px;
  -webkit-app-region: no-drag;
  user-select: none;
  background: rgba(150, 150, 200, 0.08);
  transition: all 0.2s;
}
.settings-btn:hover {
  border-color: #aaaadd;
  background: rgba(150, 150, 200, 0.2);
}

:root[data-theme="light"] .titlebar {
  background: rgba(230, 235, 245, 0.95);
  border-bottom-color: rgba(0, 0, 0, 0.1);
}
:root[data-theme="light"] .titlebar-text {
  color: #222;
}
:root[data-theme="light"] .dialog-panel,
:root[data-theme="light"] .filter-bar,
:root[data-theme="light"] .node-detail-panel,
:root[data-theme="light"] .debug-probe-panel {
  background: rgba(240, 244, 250, 0.95) !important;
  color: #333 !important;
  border-color: rgba(0, 0, 0, 0.1) !important;
}
:root[data-theme="light"] .debug-probe-panel .section-label,
:root[data-theme="light"] .dialog-panel .mode-btn,
:root[data-theme="light"] .filter-bar span {
  color: #555 !important;
}

:root[data-theme="green"] .titlebar {
  background: rgba(26, 42, 26, 0.95);
  border-bottom-color: rgba(80, 160, 80, 0.2);
}
:root[data-theme="green"] .titlebar-text {
  color: rgba(120, 180, 120, 0.4);
}
:root[data-theme="green"] .dialog-panel,
:root[data-theme="green"] .filter-bar,
:root[data-theme="green"] .node-detail-panel,
:root[data-theme="green"] .debug-probe-panel {
  background: rgba(26, 42, 26, 0.95) !important;
  color: #a8c8a8 !important;
  border-color: rgba(80, 160, 80, 0.2) !important;
}
:root[data-theme="green"] .debug-probe-panel .section-label,
:root[data-theme="green"] .dialog-panel .mode-btn,
:root[data-theme="green"] .filter-bar span {
  color: #7aaa7a !important;
}

:root[data-theme="dark"] ::-webkit-scrollbar { width: 6px; height: 6px; }
:root[data-theme="dark"] ::-webkit-scrollbar-track { background: rgba(5, 5, 16, 0.4); }
:root[data-theme="dark"] ::-webkit-scrollbar-thumb { background: rgba(80, 160, 255, 0.25); border-radius: 3px; }
:root[data-theme="dark"] ::-webkit-scrollbar-thumb:hover { background: rgba(80, 160, 255, 0.4); }
:root[data-theme="dark"] select { background: #0a0f1e; color: #c0d0e0; border-color: rgba(80, 160, 255, 0.2); }

:root[data-theme="light"] ::-webkit-scrollbar { width: 6px; height: 6px; }
:root[data-theme="light"] ::-webkit-scrollbar-track { background: rgba(230, 235, 245, 0.5); }
:root[data-theme="light"] ::-webkit-scrollbar-thumb { background: rgba(80, 80, 100, 0.2); border-radius: 3px; }
:root[data-theme="light"] ::-webkit-scrollbar-thumb:hover { background: rgba(80, 80, 100, 0.35); }
:root[data-theme="light"] select { background: #f0f0f5; color: #333; border-color: rgba(0, 0, 0, 0.15); }
:root[data-theme="light"] select option { background: #fff; color: #333; }

:root[data-theme="green"] ::-webkit-scrollbar { width: 6px; height: 6px; }
:root[data-theme="green"] ::-webkit-scrollbar-track { background: rgba(26, 42, 26, 0.5); }
:root[data-theme="green"] ::-webkit-scrollbar-thumb { background: rgba(80, 160, 80, 0.25); border-radius: 3px; }
:root[data-theme="green"] ::-webkit-scrollbar-thumb:hover { background: rgba(80, 160, 80, 0.4); }
:root[data-theme="green"] select { background: #1a2a1a; color: #a8c8a8; border-color: rgba(80, 160, 80, 0.2); }
:root[data-theme="green"] select option { background: #1a2a1a; color: #a8c8a8; }

.kernel-status-orb {
  position: fixed; bottom: 12px; right: 12px; z-index: 9000;
  display: flex; align-items: center; gap: 4px; padding: 4px 10px;
  border-radius: 12px; background: rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.1); cursor: pointer;
  font-size: 10px; color: #888; user-select: none;
}
.orb-dot {
  width: 8px; height: 8px; border-radius: 50%; transition: background 0.3s;
}
.orb-dot.loaded { background: #44ff88; box-shadow: 0 0 6px #44ff88; }
.orb-dot.degraded { background: #ffaa44; box-shadow: 0 0 6px #ffaa44; }
.orb-dot.loading { background: #888; animation: orb-pulse 1s infinite; }
.orb-dot.warning { background: #ff4444; box-shadow: 0 0 6px #ff4444; animation: orb-pulse 0.5s infinite; }
@keyframes orb-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.orb-label { font-family: monospace; }
.kernel-detail-popup {
  position: fixed; bottom: 36px; right: 12px; z-index: 9001;
  background: rgba(10,12,20,0.95); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 8px 12px; min-width: 180px;
  font-size: 11px;
}
.kd-row { display: flex; justify-content: space-between; padding: 3px 0; }
.kd-row span:first-child { color: #666; }
.kd-row span:last-child { color: #ccc; font-family: monospace; }
.kd-row span.loaded { color: #44ff88; }
.kd-row span.degraded { color: #ffaa44; }
.circuit-breaker-indicator {
  position: fixed; bottom: 12px; right: 90px; z-index: 9000;
  display: flex; align-items: center; gap: 4px; padding: 4px 10px;
  border-radius: 12px; background: rgba(180,0,0,0.5);
  border: 1px solid rgba(255,60,60,0.3); cursor: pointer;
  font-size: 10px; color: #ff6666; user-select: none;
}
.cb-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #ff3333;
  box-shadow: 0 0 6px #ff3333; animation: cb-blink 0.8s infinite;
}
@keyframes cb-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
.cb-label { font-family: monospace; }
.node-tooltip {
  position: fixed; z-index: 1500; pointer-events: none;
  padding: 3px 8px; border-radius: 4px;
  background: rgba(0,0,0,0.75); border: 1px solid rgba(255,255,255,0.15);
  color: #ddd; font-size: 11px; font-family: 'Segoe UI', sans-serif;
  white-space: nowrap;
}
.camera-reset-btn {
  position: fixed; top: 34px; right: 12px; z-index: 1500;
  width: 28px; height: 28px; border-radius: 50%;
  background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);
  color: #888; font-size: 16px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.2s, color 0.2s;
}
.camera-reset-btn:hover { background: rgba(60,60,120,0.5); color: #ccddff; }
</style>
