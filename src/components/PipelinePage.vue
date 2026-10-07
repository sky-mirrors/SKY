<template>
  <div class="pipeline-window">
    <div class="title-bar">
      <span class="title-text">🔗 流水线工作台</span>
      <div class="title-bar-right">
        <button class="tb-btn pin-btn" :class="{ pinned: floatMode }" @click="toggleFloatMode" :title="floatMode ? '取消置顶' : '置顶'">{{ floatMode ? '📌' : '🔓' }}</button>
        <button class="tb-btn" @click="minimize">─</button>
        <button class="tb-btn" @click="maximize">□</button>
        <button class="tb-btn tb-close" @click="close">✕</button>
      </div>
    </div>
    <div class="pipeline-body">
      <div class="pipeline-toolbar">
        <ToolSelector @add-node="onAddNodeFromSelector" />
        <div class="toolbar-actions">
          <button class="action-btn" @click="onAutoLayout" title="自动布局">⬡</button>
          <button class="action-btn" @click="onClearAll" title="清空画布">🗑</button>
          <button class="action-btn primary" @click="onSaveAsMacro" title="保存为宏">💾 保存为宏</button>
          <button class="action-btn primary" @click="onRunPipeline" :disabled="isRunning" title="运行当前画布">▶ 运行</button>
          <span class="run-status" v-if="runStatus">{{ runStatus }}</span>
        </div>
      </div>
      <div class="pipeline-canvas-area">
        <canvas
          ref="dagCanvas"
          @mousedown="dag.onMouseDown"
          @mousemove="dag.onMouseMove"
          @mouseup="dag.onMouseUp"
          @wheel.prevent="dag.onWheel"
        ></canvas>
      </div>
      <div class="node-property-panel" v-if="selectedNode">
        <h4>{{ selectedNode.toolName }}</h4>
        <div class="prop-row">
          <label>级别</label>
          <span :style="{ color: levelColor(selectedNode.toolLevel) }">{{ selectedNode.toolLevel }}</span>
        </div>
        <div class="prop-row">
          <label>输出键</label>
          <input v-model="selectedNode.outputKey" class="prop-input" @change="dag.scheduleRender" />
        </div>
        <div class="prop-row" v-for="(val, key) in selectedNode.params" :key="key">
          <label>{{ key }}</label>
          <input v-model="selectedNode.params[key]" class="prop-input" />
        </div>
        <button class="remove-node-btn" @click="onRemoveSelectedNode">删除此节点</button>
      </div>
    </div>
    <div class="save-macro-modal" v-if="showSaveModal">
      <div class="modal-content">
        <h3>保存为L2宏</h3>
        <div class="form-row">
          <label>宏名称</label>
          <input v-model="macroName" placeholder="例: 自定义报告生成" />
        </div>
        <div class="form-row">
          <label>关键词 (逗号分隔)</label>
          <input v-model="macroKeywords" placeholder="例: 报告,生成,分析" />
        </div>
        <div class="form-row">
          <label>检索摘要</label>
          <textarea v-model="macroSummary" rows="3" placeholder="描述此宏的用途"></textarea>
        </div>
        <div class="modal-actions">
          <button class="action-btn" @click="showSaveModal = false">取消</button>
          <button class="action-btn primary" @click="confirmSaveMacro">确认保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue'
import { useDagEngine } from '@/composables/useDagEngine'
import { DagNode, DagEdge, L2ToolManifest, L2DagStep, L2ToolIdentity, L2ToolVisual, L2ToolRouting, L2ToolExecution, L2ToolCacheMeta } from '@/models'
import ToolSelector from '@/components/ToolSelector.vue'

const dagCanvas = ref<HTMLCanvasElement | null>(null)
const dag = useDagEngine(dagCanvas)
const floatMode = ref(false)
const showSaveModal = ref(false)
const macroName = ref('')
const macroKeywords = ref('')
const macroSummary = ref('')
const isRunning = ref(false)
const runStatus = ref('')
let runStatusTimer: ReturnType<typeof setTimeout> | null = null
let runOrder: string[] = []

function showRunStatus(text: string) {
  runStatus.value = text
  if (runStatusTimer) clearTimeout(runStatusTimer)
  runStatusTimer = setTimeout(() => {
    runStatus.value = ''
    runStatusTimer = null
  }, 4000)
}

const selectedNode = computed(() => dag.getSelectedNode())

function levelColor(level: string): string {
  switch (level) {
    case 'L1': return '#44aaff'
    case 'L2': return '#00e5ff'
    case 'L3': return '#ff66aa'
    case 'skill': return '#ffaa44'
    case 'mcp': return '#aa66ff'
    default: return '#667788'
  }
}

function minimize() {
  window.electronAPI?.pipelineWindowMinimize?.()
}

function maximize() {
  window.electronAPI?.pipelineWindowMaximize?.()
}

function close() {
  window.electronAPI?.pipelineWindowClose?.()
}

function toggleFloatMode() {
  floatMode.value = !floatMode.value
  window.electronAPI?.pipelineToggleFloat?.(floatMode.value)
}

function onAddNodeFromSelector(data: { toolId: string; toolName: string; toolLevel: string }) {
  const node: DagNode = {
    id: `dag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    toolId: data.toolId,
    toolName: data.toolName,
    toolLevel: data.toolLevel as DagNode['toolLevel'],
    position: { x: 100 + dag.nodes.value.length * 40, y: 100 + dag.nodes.value.length * 30 },
    params: {},
    outputKey: data.toolId.replace(/[^a-zA-Z0-9]/g, '_') + '_out',
    status: 'pending'
  }
  dag.addNode(node)
}

function onAutoLayout() {
  dag.autoLayout()
}

function onClearAll() {
  // D-11：破坏性操作需确认且不可撤销
  if (dag.nodes.value.length === 0 && dag.edges.value.length === 0) return
  if (!window.confirm(`确定清空画布？将删除 ${dag.nodes.value.length} 个节点和 ${dag.edges.value.length} 条连线（不可撤销）`)) return
  dag.clearAll()
}

function onRemoveSelectedNode() {
  if (dag.selectedNodeId.value) {
    dag.removeNode(dag.selectedNodeId.value)
  }
}

function onSaveAsMacro() {
  if (dag.nodes.value.length === 0) return
  macroName.value = ''
  macroKeywords.value = ''
  macroSummary.value = ''
  showSaveModal.value = true
}

function dagToManifest(
  name: string,
  keywords: string[],
  summary: string,
  dagNodes: DagNode[],
  dagEdges: DagEdge[]
): L2ToolManifest {
  const sorted = dag.topologicalSort()
  const nodeIndex: Record<string, number> = {}
  sorted.forEach((n, i) => { nodeIndex[n.id] = i + 1 })

  const steps: L2DagStep[] = sorted.map((node, i) => ({
    step: i + 1,
    description: node.toolName,
    tool: node.toolId,
    depends_on: dagEdges
      .filter(e => e.targetNodeId === node.id)
      .map(e => nodeIndex[e.sourceNodeId] || 0)
      .filter(d => d > 0),
    params: node.params as Record<string, unknown>,
    expectedOutput: node.outputKey || node.toolName + '输出',
    modelTier: node.modelTier as 'nano' | 'mini' | 'standard' | 'pro' | undefined
  }))

  return {
    identity: {
      id: `custom-${Date.now()}`,
      name,
      version: '1.0.0',
      author: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      templateId: ''
    } as L2ToolIdentity,
    visual: {
      baseColor: '#44aaff',
      ringStyle: 'solid',
      badges: ['chain'] as ('sparkle' | 'chain' | 'lightning')[],
      hoverLabel: name,
      anchorGlow: '',
      upgradeGlow: ''
    } as L2ToolVisual,
    routing: {
      keywords,
      targetRoles: [],
      requiredL1: [],
      inputType: 'text',
      retrievalSummary: summary,
      userSummary: summary,
      confidenceThreshold: 0.5
    } as L2ToolRouting,
    execution: {
      mode: 'macro',
      paramMapping: { slots: [], bindings: [] },
      dagPlan: {
        steps,
        fallbackStrategy: 'retry' as const,
        maxRetries: 2
      }
    } as L2ToolExecution,
    cacheMeta: {
      estimatedTokenSaving: 0,
      avgExecutionTime: 0,
      cacheable: false,
      cacheKeyTemplate: '',
      cacheTTL: 0
    } as L2ToolCacheMeta
  }
}

async function confirmSaveMacro() {
  if (!macroName.value.trim()) return
  // D-10：保存前检测循环依赖——原实现环上节点被 topologicalSort 静默丢弃
  // 且 `nodeIndex[...] || 0` + `filter(d=>d>0)` 把环边无声过滤，用户毫无感知
  const sortedCheck = dag.topologicalSort()
  if (sortedCheck.length < dag.nodes.value.length) {
    showRunStatus(`检测到循环依赖：${dag.nodes.value.length - sortedCheck.length} 个节点不在拓扑序内，请先解除环路再保存`)
    return
  }
  const manifest = dagToManifest(
    macroName.value.trim(),
    macroKeywords.value.split(',').map(k => k.trim()).filter(Boolean),
    macroSummary.value.trim() || macroName.value.trim(),
    dag.nodes.value,
    dag.edges.value
  )
  try {
    const { saveCustomManifest } = await import('@/data/l2Manifests')
    saveCustomManifest(manifest)
  } catch {
    const customs = JSON.parse(localStorage.getItem('holo-custom-manifests') || '[]')
    customs.push(manifest)
    localStorage.setItem('holo-custom-manifests', JSON.stringify(customs))
  }
  showSaveModal.value = false
  dag.clearAll()
}

function onRunPipeline() {
  // P1-26：执行当前画布（拓扑序节点 → 主窗口代跑），而非存储的历史 pipeline
  if (isRunning.value) return
  if (dag.nodes.value.length === 0) {
    showRunStatus('画布为空，请先添加节点')
    return
  }
  const sorted = dag.topologicalSort()
  if (sorted.length < dag.nodes.value.length) {
    showRunStatus('检测到循环依赖，环中节点将被跳过')
  }
  for (const n of dag.nodes.value) {
    n.status = 'pending'
  }
  dag.scheduleRender()
  runOrder = sorted.map(n => n.id)
  isRunning.value = true
  showRunStatus('已提交主窗口执行…')
  window.electronAPI?.pipelineRunRequest?.({
    nodes: sorted.map(n => ({
      id: n.id,
      toolId: n.toolId,
      toolName: n.toolName,
      params: n.params,
      outputKey: n.outputKey
    })),
    edges: dag.edges.value
  })
}

function onRunEvent(data: { type: 'progress' | 'done' | 'error'; stepId?: string; msg?: string; results?: Record<string, string>; error?: string }) {
  if (data.type === 'progress' && data.stepId) {
    const idx = parseInt(data.stepId.replace(/^step-/, ''), 10)
    const nodeId = runOrder[idx]
    const node = nodeId ? dag.nodes.value.find(n => n.id === nodeId) : null
    if (node) {
      const msg = data.msg || ''
      if (msg.startsWith('✓')) node.status = 'done'
      else if (msg.startsWith('✗')) node.status = 'failed'
      else node.status = 'running'
      dag.scheduleRender()
    }
    if (data.msg) showRunStatus(data.msg)
  } else if (data.type === 'done') {
    isRunning.value = false
    for (const n of dag.nodes.value) {
      if (n.status === 'running') n.status = 'done'
      else if (n.status === 'pending') n.status = 'skipped'
    }
    dag.scheduleRender()
    showRunStatus('执行完成')
  } else if (data.type === 'error') {
    isRunning.value = false
    for (const n of dag.nodes.value) {
      if (n.status === 'running') n.status = 'failed'
      else if (n.status === 'pending') n.status = 'skipped'
    }
    dag.scheduleRender()
    showRunStatus(`执行失败: ${data.error || '未知错误'}`)
  }
}

function onResize() {
  dag.resize()
}

let unsubNodeAdded: (() => void) | null = null
let unsubRunEvent: (() => void) | null = null

onMounted(() => {
  dag.resize()
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', dag.onKeyDown)

  if (window.electronAPI?.onPipelineNodeAdded) {
    unsubNodeAdded = window.electronAPI.onPipelineNodeAdded((data: { toolId: string; toolName: string; toolLevel: string }) => {
      onAddNodeFromSelector(data)
    })
  }
  if (window.electronAPI?.onPipelineRunEvent) {
    unsubRunEvent = window.electronAPI.onPipelineRunEvent(onRunEvent)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', dag.onKeyDown)
  // A6-2(c)：IPC 监听随组件卸载注销，避免跨 mount 累积
  unsubNodeAdded?.()
  unsubRunEvent?.()
  if (runStatusTimer) clearTimeout(runStatusTimer)
})
</script>

<style scoped>
.pipeline-window {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #050510;
  color: #e0e0e0;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 8px;
  background: rgba(5, 5, 16, 0.6);
  backdrop-filter: blur(8px);
  -webkit-app-region: drag;
  border-bottom: 1px solid rgba(80, 120, 180, 0.15);
  flex-shrink: 0;
}

.title-text {
  font-size: 12px;
  color: rgba(130, 170, 220, 0.5);
  letter-spacing: 1px;
  font-weight: 300;
}

.title-bar-right {
  -webkit-app-region: no-drag;
  display: flex;
  gap: 2px;
}

.tb-btn {
  width: 36px;
  height: 28px;
  border: none;
  background: transparent;
  color: rgba(130, 170, 220, 0.4);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.15s;
}
.tb-btn:hover {
  background: rgba(80, 140, 220, 0.15);
  color: rgba(180, 210, 255, 0.8);
}
.pin-btn.pinned {
  color: #ffcc44;
  background: rgba(255, 200, 60, 0.15);
  box-shadow: 0 0 8px rgba(255, 200, 60, 0.3);
}
.tb-close:hover {
  background: rgba(220, 60, 60, 0.25);
  color: rgba(255, 120, 120, 0.9);
}

.pipeline-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pipeline-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(10, 15, 30, 0.8);
  border-bottom: 1px solid rgba(80, 120, 180, 0.1);
  flex-shrink: 0;
  gap: 8px;
}

.toolbar-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.run-status {
  font-size: var(--font-sm);
  color: #8cffb0;
  background: rgba(60, 160, 100, 0.12);
  border: 1px solid rgba(80, 200, 140, 0.25);
  border-radius: 4px;
  padding: 2px 8px;
  white-space: nowrap;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action-btn {
  padding: 4px 12px;
  background: rgba(40, 70, 110, 0.3);
  border: 1px solid rgba(80, 120, 180, 0.2);
  border-radius: 4px;
  color: #8ab4ff;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.action-btn:hover {
  background: rgba(60, 100, 160, 0.4);
  border-color: rgba(100, 160, 240, 0.4);
}
.action-btn.primary {
  background: rgba(40, 120, 200, 0.3);
  border-color: rgba(80, 160, 240, 0.4);
  color: #aaccff;
}

.pipeline-canvas-area {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.pipeline-canvas-area canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.node-property-panel {
  position: absolute;
  right: 12px;
  top: 80px;
  width: 220px;
  background: rgba(10, 15, 30, 0.95);
  border: 1px solid rgba(80, 120, 180, 0.2);
  border-radius: 6px;
  padding: 12px;
  font-size: 11px;
  z-index: 100;
}
.node-property-panel h4 {
  color: #aaccff;
  font-size: 13px;
  margin-bottom: 8px;
  font-weight: 500;
}
.prop-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.prop-row label {
  color: #5a7a9a;
  min-width: 50px;
  font-size: var(--font-sm);
}
.prop-input {
  flex: 1;
  background: rgba(15, 25, 45, 0.8);
  border: 1px solid rgba(80, 120, 180, 0.2);
  border-radius: 3px;
  padding: 3px 6px;
  color: #c0d0e0;
  font-size: 11px;
  outline: none;
}
.prop-input:focus {
  border-color: rgba(100, 160, 240, 0.5);
}
.remove-node-btn {
  width: 100%;
  margin-top: 8px;
  padding: 4px;
  background: rgba(220, 60, 60, 0.15);
  border: 1px solid rgba(220, 60, 60, 0.3);
  border-radius: 3px;
  color: #ff8888;
  font-size: var(--font-sm);
  cursor: pointer;
}
.remove-node-btn:hover {
  background: rgba(220, 60, 60, 0.25);
}

.save-macro-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}
.modal-content {
  background: rgba(10, 15, 30, 0.96);
  border: 1px solid rgba(80, 120, 180, 0.3);
  border-radius: 8px;
  padding: 20px;
  width: 360px;
}
.modal-content h3 {
  color: #aaccff;
  font-size: 14px;
  margin-bottom: 12px;
}
.form-row {
  margin-bottom: 10px;
}
.form-row label {
  display: block;
  color: #5a7a9a;
  font-size: var(--font-sm);
  margin-bottom: 3px;
}
.form-row input,
.form-row textarea {
  width: 100%;
  background: rgba(15, 25, 45, 0.8);
  border: 1px solid rgba(80, 120, 180, 0.2);
  border-radius: 4px;
  padding: 6px 8px;
  color: #c0d0e0;
  font-size: 11px;
  outline: none;
  resize: vertical;
}
.form-row input:focus,
.form-row textarea:focus {
  border-color: rgba(100, 160, 240, 0.5);
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
