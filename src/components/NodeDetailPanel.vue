<template>
  <transition name="panel-slide">
    <div class="detail-panel" v-if="node">
      <div class="scan-line"></div>
      <div class="panel-header">
        <span class="level-badge" :class="levelClass">{{ node.level }}</span>
        <h3 class="tool-name">{{ node.name }}</h3>
      </div>

      <div class="panel-body">
        <div class="info-row">
          <span class="label">节点ID</span>
          <span class="value mono">{{ node.id }}</span>
        </div>

        <div class="info-row" v-if="node.position">
          <span class="label">空间坐标</span>
          <span class="value mono">({{ node.position.x.toFixed(1) }}, {{ node.position.y.toFixed(1) }}, {{ node.position.z.toFixed(1) }})</span>
        </div>

        <div class="info-row" v-if="node.apiRole">
          <span class="label">API角色</span>
          <span class="value mono">{{ node.apiRole }}</span>
        </div>

        <div class="info-row" v-if="node.parentL1Id">
          <span class="label">关联核心</span>
          <span class="value">{{ parentL1Name }}</span>
        </div>

        <div class="info-row" v-if="node.locked !== undefined">
          <span class="label">锁定状态</span>
          <span class="value" :class="node.locked ? 'locked' : 'unlocked'">{{ node.locked ? '已锁定(用户自选)' : '未锁定(系统填充)' }}</span>
        </div>

        <div class="info-row" v-if="node.communityHeat !== undefined">
          <span class="label">社区热度</span>
          <span class="value">
            <span class="heat-bar">
              <span class="heat-fill" :style="{ width: node.communityHeat + '%' }"></span>
            </span>
            {{ Math.round(node.communityHeat) }}
          </span>
        </div>

        <div class="info-row" v-if="node.level === 'L0'">
          <span class="label">优先级</span>
          <span class="value">
            <input
              type="range"
              min="0.1"
              max="5"
              step="0.1"
              :value="node.gravityWeight ?? 1"
              @input="onGravityChange(($event.target as HTMLInputElement).value)"
              class="gravity-slider"
            />
            <span class="mono">{{ (node.gravityWeight ?? 1).toFixed(1) }}</span>
          </span>
          <span class="hint">值越高，工具在编排队列中越优先执行</span>
        </div>

        <div class="info-row" v-if="contextCacheInfo">
          <span class="label">上下文缓存</span>
          <span class="value cache-info">
            <span class="cache-text">{{ contextCacheInfo }}</span>
            <button class="btn-tiny" @click="$emit('resumeContext', node.id)">恢复</button>
            <button class="btn-tiny btn-tiny-danger" @click="$emit('clearContext', node.id)">清除</button>
          </span>
        </div>

        <div class="info-row" v-if="circuitBreakerInfo">
          <span class="label">熔断状态</span>
          <span class="value" :class="circuitBreakerInfo.isOpen ? 'cb-open' : 'cb-closed'">
            {{ circuitBreakerInfo.isOpen ? '已熔断(冷却中)' : '正常' }}
          </span>
        </div>

        <div class="divider"></div>

        <div class="description">
          <span class="label">工具介绍</span>
          <p v-if="isDegradedNode && degraded">需连接 AI 大脑后激活</p>
          <p v-else>{{ node.description }}</p>
        </div>

        <div class="combo-section" v-if="node.comboToolIds && node.comboToolIds.length > 0 && !(isDegradedNode && degraded)">
          <span class="label">组合工具链</span>
          <div class="combo-chain">
            <span v-for="(tid, idx) in node.comboToolIds" :key="tid" class="combo-item">
              {{ getToolName(tid) }}
              <span v-if="idx < node.comboToolIds!.length - 1" class="combo-arrow">→</span>
            </span>
          </div>
        </div>

        <div class="schema-section" v-if="node.outputSchema && node.outputSchema.length > 0">
          <span class="label">输出 Schema</span>
          <div class="schema-fields">
            <span v-for="f in node.outputSchema" :key="f.name" class="schema-field" :class="{ required: f.required }">
              {{ f.name }}:{{ f.type }}
            </span>
          </div>
        </div>

        <div class="decay-warning" v-if="decayInfo" :class="decayInfo.type">
          <span class="label">状态</span>
          <span class="value decay-text">{{ decayInfo.text }}</span>
        </div>

        <div class="drag-hint" v-if="node.level !== 'L0'">
          <span class="hint-text">Ctrl + 鼠标左键可多选星节点，选中后可在筛选栏加入流水线/编排</span>
        </div>
      </div>

      <div class="panel-actions" v-if="node.level !== 'L0'">
        <button class="btn-orchestrate" @click="onAddToOrchestration">加入编排</button>
        <button class="btn-pipeline" @click="onAddToPipeline">加入流水线</button>
        <button v-if="node.level === 'L2' && !node.locked" class="btn-lock" @click="$emit('lock', node.id)">锁定到我的配置</button>
        <button v-if="node.level === 'L2' && node.locked" class="btn-unlock" @click="$emit('unlock', node.id)">取消锁定</button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ToolNode } from '@/models'
import { useNodeStore } from '@/domains/node'
import { useDialogStore } from '@/domains/dialog'

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
}

const props = defineProps<{
  node: ToolNode | null
  degraded?: boolean
  circuitBreakerOpen?: boolean
}>()

defineEmits<{
  lock: [nodeId: string]
  unlock: [nodeId: string]
  setGravity: [nodeId: string, weight: number]
  resumeContext: [nodeId: string]
  clearContext: [nodeId: string]
}>()

const nodeStore = useNodeStore()
const dialogStore = useDialogStore()

function onAddToOrchestration() {
  if (!props.node) return
  nodeStore.toggleNodeSelection(props.node.id)
}

function onAddToPipeline() {
  if (!props.node) return
  window.electronAPI?.openPipelineWindow?.()
  window.electronAPI?.pipelineAddNode?.({
    toolId: props.node.id,
    toolName: props.node.name,
    toolLevel: props.node.level
  })
}

const levelClass = computed(() => {
  if (!props.node) return ''
  return `level-${props.node.level.toLowerCase()}`
})

const isDegradedNode = computed(() => {
  if (!props.node) return false
  return props.node.level === 'L2' && !!props.node.apiRole && props.node.apiRole !== 'renderer' && props.node.apiRole !== 'context_preparer'
})

const parentL1Name = computed(() => {
  if (!props.node?.parentL1Id) return ''
  return nodeStore.nodes.find(n => n.id === props.node!.parentL1Id)?.name ?? props.node.parentL1Id
})

const contextCacheInfo = computed(() => {
  if (!props.node) return null
  const cache = props.node.contextCache
  if (!cache) return null
  return `碎片(${cache.stepIndex}/${cache.totalSteps}) ${timeAgo(cache.savedAt)}`
})

const circuitBreakerInfo = computed(() => {
  if (!props.node || props.node.level !== 'L0') return null
  return { isOpen: props.circuitBreakerOpen ?? false }
})

const decayInfo = computed(() => {
  if (!props.node || props.node.level !== 'L3') return null
  const state = nodeStore.l3DecayStates.find(s => s.nodeId === props.node!.id)
  if (!state) return null
  if (state.isCollapsed) return { text: '星云残骸（左键点击可复活）', type: 'collapsed' }
  if (state.daysUntilCollapse <= 7) return { text: `即将退潮（${Math.ceil(state.daysUntilCollapse)}天后坍缩，左键锚定可永久保留）`, type: 'warning' }
  return null
})

function onGravityChange(val: string) {
  if (!props.node) return
  const weight = parseFloat(val)
  if (!isNaN(weight)) {
    nodeStore.setGravityWeight(props.node.id, weight)
  }
}

function getToolName(toolId: string): string {
  const tool = nodeStore.nodes.find(n => n.id === toolId)
  return tool?.name ?? toolId
}
</script>

<style scoped>
.detail-panel {
  position: fixed;
  right: 24px;
  top: 50%;
  transform: translateY(-50%);
  width: 300px;
  background: rgba(5, 8, 18, 0.75);
  border: 1px solid rgba(80, 160, 255, 0.18);
  border-radius: 10px;
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  z-index: 500;
  color: #c0d8ff;
  box-shadow:
    0 4px 32px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(50, 100, 200, 0.06),
    inset 0 0 60px rgba(10, 20, 40, 0.3),
    inset 0 1px 0 rgba(100, 180, 255, 0.08);
  overflow: hidden;
}

.detail-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  background-size: 100px 100px;
  pointer-events: none;
  z-index: 1;
  opacity: 0.5;
}

.detail-panel::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(80,160,255,0.12) 0%, transparent 40%, transparent 60%, rgba(80,160,255,0.06) 100%);
  pointer-events: none;
  z-index: 0;
}

.scan-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(80,180,255,0.15) 30%, rgba(80,180,255,0.25) 50%, rgba(80,180,255,0.15) 70%, transparent 100%);
  z-index: 2;
  animation: scanMove 6s linear infinite;
  pointer-events: none;
}

@keyframes scanMove {
  0% { top: -2px; opacity: 0; }
  5% { opacity: 1; }
  95% { opacity: 1; }
  100% { top: calc(100% + 2px); opacity: 0; }
}

.panel-header {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
}

.level-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 3px;
  letter-spacing: 0.5px;
}
.level-l0 { background: rgba(255,255,255,0.12); color: #fff; }
.level-l1 { background: rgba(255,215,0,0.15); color: #ffd700; }
.level-l2 { background: rgba(0,255,255,0.12); color: #00ffff; }
.level-l3 { background: rgba(140,100,200,0.12); color: #b088e0; }

.tool-name {
  font-size: 15px;
  font-weight: 600;
  color: #e0eaff;
  margin: 0;
}

.panel-body {
  position: relative;
  z-index: 3;
  padding: 14px 18px;
  max-height: 60vh;
  overflow-y: auto;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-size: 12px;
}

.label {
  color: #5a7a9a;
  font-size: 11px;
  flex-shrink: 0;
  margin-right: 12px;
}

.value {
  color: #a0c0e8;
  text-align: right;
  display: flex;
  align-items: center;
  gap: 6px;
}
.value.mono {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 11px;
  color: #7a9cc6;
}
.value.locked { color: #00ffff; }
.value.unlocked { color: #5a7a9a; }
.value.cb-open { color: #ff4444; }
.value.cb-closed { color: #44ff88; }

.heat-bar {
  display: inline-block;
  width: 60px;
  height: 4px;
  background: rgba(100, 180, 255, 0.1);
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: middle;
}
.heat-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #00ff88, #8800ff);
}

.gravity-slider {
  width: 80px;
  height: 3px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(100, 180, 255, 0.15);
  border-radius: 2px;
  outline: none;
}
.gravity-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #88ccff;
  cursor: pointer;
}
.hint {
  display: block;
  font-size: 9px;
  color: #445;
  margin-top: 2px;
}

.mode-btn {
  padding: 2px 8px;
  background: rgba(100, 180, 255, 0.08);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 3px;
  color: #7a9cc6;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.mode-btn.active {
  background: rgba(100, 180, 255, 0.2);
  border-color: rgba(100, 180, 255, 0.4);
  color: #aaccff;
}

.cache-info {
  gap: 4px;
}
.cache-text {
  font-size: 10px;
  color: #ffaa44;
}
.btn-tiny {
  padding: 1px 6px;
  background: rgba(100, 180, 255, 0.1);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 2px;
  color: #8ab4ff;
  font-size: 9px;
  cursor: pointer;
}
.btn-tiny-danger {
  color: #ff6a6a;
  border-color: rgba(255, 100, 100, 0.15);
}

.divider {
  height: 1px;
  background: rgba(100, 180, 255, 0.06);
  margin: 10px 0;
}

.description {
  margin-bottom: 8px;
}
.description p {
  font-size: 12px;
  color: #8aacc8;
  line-height: 1.6;
  margin: 6px 0 0;
}

.combo-section {
  margin-top: 4px;
}
.combo-chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 6px;
}
.combo-item {
  font-size: 11px;
  color: #7a9cc6;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.combo-arrow {
  color: #4a6a8a;
  margin: 0 4px;
}

.schema-section {
  margin-top: 6px;
}
.schema-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.schema-field {
  font-size: 9px;
  padding: 1px 5px;
  background: rgba(100, 180, 255, 0.06);
  border-radius: 2px;
  color: #7a9cc6;
  font-family: 'Consolas', monospace;
}
.schema-field.required {
  border-left: 2px solid #ffaa44;
}

.decay-warning {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
}
.decay-warning.warning .decay-text { color: #ff6644; }
.decay-warning.collapsed .decay-text { color: #555577; }

.drag-hint {
  margin-top: 10px;
  padding: 6px 8px;
  background: rgba(80, 160, 255, 0.06);
  border-radius: 3px;
  text-align: center;
}
.drag-hint .hint-text {
  font-size: 10px;
  color: #5a8aaa;
}

.panel-actions {
  position: relative;
  z-index: 3;
  padding: 12px 18px 16px;
  border-top: 1px solid rgba(100, 180, 255, 0.08);
  display: flex;
  gap: 8px;
}

.btn-orchestrate {
  padding: 7px 12px;
  background: rgba(160, 80, 220, 0.2);
  border: 1px solid rgba(180, 120, 255, 0.2);
  border-radius: 4px;
  color: #b888e0;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-orchestrate:hover {
  background: rgba(160, 80, 220, 0.35);
  border-color: rgba(180, 120, 255, 0.35);
}

.btn-pipeline {
  padding: 7px 12px;
  background: rgba(0, 180, 140, 0.2);
  border: 1px solid rgba(0, 220, 180, 0.2);
  border-radius: 4px;
  color: #44ddbb;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-pipeline:hover {
  background: rgba(0, 180, 140, 0.35);
  border-color: rgba(0, 220, 180, 0.35);
}

.btn-lock {
  padding: 7px 12px;
  background: rgba(0, 200, 200, 0.12);
  border: 1px solid rgba(0, 255, 255, 0.15);
  border-radius: 4px;
  color: #00dddd;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-lock:hover { background: rgba(0, 200, 200, 0.25); }

.btn-unlock {
  padding: 7px 12px;
  background: transparent;
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 4px;
  color: #5a7a9a;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-unlock:hover { border-color: rgba(100, 180, 255, 0.25); }

.btn-borrow {
  padding: 7px 12px;
  background: rgba(255, 170, 0, 0.12);
  border: 1px solid rgba(255, 200, 50, 0.2);
  border-radius: 4px;
  color: #ffaa44;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-borrow:hover { background: rgba(255, 170, 0, 0.25); }

.panel-slide-enter-active { transition: all 0.25s ease-out; }
.panel-slide-leave-active { transition: all 0.15s ease-in; }
.panel-slide-enter-from { opacity: 0; transform: translateY(-50%) translateX(20px); }
.panel-slide-leave-to { opacity: 0; transform: translateY(-50%) translateX(20px); }

:root[data-theme="green"] .detail-panel { background: rgba(26,42,26,0.95); border-color: rgba(80,160,80,0.2); color: #a8c8a8; }
:root[data-theme="green"] .detail-panel .tool-name { color: #88cc88; }
:root[data-theme="green"] .detail-panel .label { color: #7aaa7a; }
:root[data-theme="green"] .detail-panel .value { color: #a8c8a8; }
:root[data-theme="green"] .detail-panel .btn-orchestrate { background: rgba(80,160,80,0.2); border-color: rgba(80,160,80,0.2); color: #88cc88; }
:root[data-theme="green"] .detail-panel .btn-pipeline { background: rgba(0,180,80,0.2); border-color: rgba(0,180,80,0.2); color: #44bb66; }
</style>
