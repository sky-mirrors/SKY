<template>
    <div class="holo-app">
    <div class="titlebar">
      <div class="titlebar-left">
        <span class="titlebar-text">HoloStarmap</span>
        <!-- 2026-10-01 UI 分端：探针 / 压测台 / 规则审核属开发者向，已从用户端顶栏移出，
             经导航「开发者」区（调试中心 / 压测台 / 规则审核）进入。用户端只留主题 / 通知 / 设置。 -->
        <span class="theme-toggle" @click="configStore.toggleTheme" :title="configStore.theme === 'dark' ? '切换浅色模式' : configStore.theme === 'light' ? '切换护眼模式' : configStore.theme === 'green' ? '切换到可爱模式 🌸' : '切回深色模式'">{{ configStore.theme === 'dark' ? '☀️' : configStore.theme === 'light' ? '🌿' : configStore.theme === 'green' ? '🌙' : '🌸' }}</span>
        <span class="notification-bell" @click="notificationCenterRef?.open()" title="通知中心">🔔<span class="bell-badge" v-if="notificationStore.unreadCount > 0">{{ notificationStore.unreadCount }}</span></span>
        <span class="settings-btn" @click="settingsPageRef?.open()" title="设置">⚙️</span>
      </div>
      <div class="titlebar-controls">
        <button class="tb-btn tb-minimize" @click="minimizeWindow">─</button>
        <button class="tb-btn tb-maximize" @click="maximizeWindow">□</button>
        <button class="tb-btn tb-close" @click="closeWindow">✕</button>
      </div>
    </div>
    <!-- 工作台：唯一主视图（125 节点 3D 星图视图已于 2026-09-26 删除，不再有模式开关） -->
    <WorkbenchShell
      @open-mcp="onOpenMcp"
      @open-preview="openPreview"
      @open-api-settings="apiSettingsRef?.open(apiStore.config.baseUrl)"
    />
    <!-- 公共层：预览/弹窗/设置（跨模式共享） -->
    <ResultPreviewStage
      v-if="viewMode === 'preview'"
      :message="previewMessage"
      @close="configStore.setViewMode('workbench')"
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
import ApiSettings from './components/ApiSettings.vue'
import Notification from './components/Notification.vue'
import NotificationCenter from './components/NotificationCenter.vue'
import CommandPalette from './components/CommandPalette.vue'
import SettingsPage from './components/SettingsPage.vue'
import OnboardingWizard from './components/OnboardingWizard.vue'
import WorkbenchShell from './components/workbench/WorkbenchShell.vue'
import L0Modal from './components/L0Modal.vue'
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
import { L2ToolManifest, DialogMessage, ChatMessage } from '@/models'
import { executePipeline } from '@/domains/pipeline'
import { usePipelineStore, registerPipelineExecutor } from '@/domains/pipeline'
import { buildCanvasPipeline } from '@/services/canvasRun'
import { useDebugStore } from '@/domains/debug'
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
import { pruneExpired } from '@/services/dagCheckpoint'
import { migrateKnowledgePartitions } from '@/services/knowledgeMigration'
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
const viewMode = computed(() => configStore.viewMode)
const previewMessage = ref<DialogMessage | null>(null)

const _appTimers: ReturnType<typeof setInterval>[] = []
let _memoryPressureWarned = false

// 内存压力守卫：原挂在星图的「内核状态球」上（球随星图删除）。守卫本身保留——
// 它经 dialogStore.addSystemNotice 提示，是工作台里同样该看到的信号。
function checkMemoryPressure() {
  try {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    if (perf.memory) {
      const ratio = perf.memory.usedJSHeapSize / perf.memory.jsHeapSizeLimit
      if (ratio > 0.7 && !_memoryPressureWarned) {
        _memoryPressureWarned = true
        dialogStore.addSystemNotice(`⚠️ 内存压力过高(${Math.round(ratio*100)}%)，建议保存工作并重启应用`)
      }
      if (ratio < 0.6) _memoryPressureWarned = false
    }
  } catch { /* ignore */ }
}

_appTimers.push(setInterval(checkMemoryPressure, 10000))

const l0ModalRef = ref()

function minimizeWindow() {
  window.electronAPI?.windowMinimize()
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

function checkContextResume(toolId: string) {
  const cache = nodeStore.loadContextCache(toolId)
  if (cache && cache.stepIndex < cache.totalSteps) {
    notificationRef.value?.show(`检测到未完成的上下文碎片(${cache.stepIndex}/${cache.totalSteps})，可从断点恢复`, 4000)
  }
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
      }
    } else {
      notificationRef.value?.show('AI 大脑离线，已切换本地规则模式', 3000)
      nodeStore.setDegradedState({
        isDegraded: true,
        unavailableToolIds: nodeStore.nodes
          .filter(n => n.apiRole && n.apiRole !== 'renderer' && n.apiRole !== 'context_preparer')
          .map(n => n.id),
        reason: 'API不可达'
      })
    }
  }).catch(() => {})
}

function onOpenMcp() {
  l0ModalRef.value?.open()
}

// 预览浮层开关（原「星图↔结果预览」切换；星图删除后只剩「预览 / 主视图」两态，
// 由命令面板的 holo-toggle-mode 事件触发）
function togglePreview() {
    configStore.setViewMode(viewMode.value === 'preview' ? 'workbench' : 'preview')
}

function openPreview(msg: DialogMessage) {
  previewMessage.value = msg
  configStore.setViewMode('preview')
}

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
      configStore.setViewMode('workbench')
    }
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
  dialogStore.insertSystemMessage(`新技能已安装，可在工作台使用`)
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
  togglePreview()
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
  // H-1：改经 buildCanvasPipeline —— 它把画布的 dagNodes/dagEdges 一并带上，
  // executePipeline 才会按用户连的依赖边做拓扑排序（原实现只映射 steps、丢弃 edges，
  // 执行器里那段 dagEdges 分支因此永不可达）。
  window.electronAPI?.onPipelineRunRequest?.((data) => {
    const transientPipeline = buildCanvasPipeline({ nodes: data.nodes, edges: data.edges })
    if (!transientPipeline) return
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

  // 2026-10-01（用户反馈「小模型应该随着应用启动提前冷启动」）：把 embedder 的模型下载+
  // onnx 初始化从「首次提问」挪到「启动后台」。首次要下 21.9MB（实测 26.5s），不预热就会
  // 压在第一轮对话上、且受加载超时限制而失败降级。有意不 await —— 启动不被它拖住。
  void import('@/services/embedder').then(m => m.prewarmEmbedder()).catch(() => {})

  // 2026-09-25（机制体检）：DAG 检查点过期回收——此前 pruneExpired 零消费者，
  // 过期检查点只能靠 saveCheckpoint 的 MAX=20 上限顺带淘汰。读侧 resume 候选见 DialogPanel。
  pruneExpired().catch(err => console.warn('[checkpoint] 过期检查点回收失败:', err))

  // 2026-09-26（机制体检 Wave1）：M12 knowledge partition 回填——此前整个模块零生产调用方（休眠模块）。
  // 模块自带版本守卫（命中即 skipped）+ 全量备份 + 计数对账，幂等，故按既有启动钩子惯例接上跑。
  migrateKnowledgePartitions()
    .then(r => { if (!r.skipped) console.log('[knowledge-migration] partition 回填:', r) })
    .catch(err => console.warn('[knowledge-migration] 迁移失败:', err))

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
  // 2026-09-25（机制体检）：改用 onboardingManager.shouldShowOnboarding()——须在 registerConfigHandlers 之后调用
  // （该函数经 bus.request 读取，处理器未注册时会抛）。星图删除后工作台是唯一视图，不再有模式条件。
  if (configStore.isFirstLaunch && shouldShowOnboarding()) {
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

.holo-app {
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
  font-size: var(--font-xs);
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
:root[data-theme="light"] .dialog-panel {
  background: rgba(240, 244, 250, 0.95) !important;
  color: #333 !important;
  border-color: rgba(0, 0, 0, 0.1) !important;
}
:root[data-theme="light"] .dialog-panel .mode-btn {
  color: #555 !important;
}

:root[data-theme="green"] .titlebar {
  background: rgba(26, 42, 26, 0.95);
  border-bottom-color: rgba(80, 160, 80, 0.2);
}
:root[data-theme="green"] .titlebar-text {
  color: rgba(120, 180, 120, 0.4);
}
:root[data-theme="green"] .dialog-panel {
  background: rgba(26, 42, 26, 0.95) !important;
  color: #a8c8a8 !important;
  border-color: rgba(80, 160, 80, 0.2) !important;
}
:root[data-theme="green"] .dialog-panel .mode-btn {
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

</style>
