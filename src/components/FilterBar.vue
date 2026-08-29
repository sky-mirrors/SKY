<template>
  <div class="filter-bar">
    <div class="filter-section">
      <span class="filter-label">层级</span>
      <button
        v-for="lv in levels"
        :key="lv.key"
        class="filter-tag"
        :class="{ active: nodeStore.levelFilter.includes(lv.key) }"
        :style="{ borderColor: lv.color, color: nodeStore.levelFilter.includes(lv.key) ? lv.color : '#667' }"
        @click="nodeStore.toggleLevelFilter(lv.key)"
      >{{ lv.label }}</button>
    </div>
    <button v-if="hasFilters" class="clear-btn" @click="nodeStore.clearFilters()">清除筛选</button>
    <div class="selection-info" v-if="nodeStore.selectedNodeIds.length > 0">
      <span class="sel-count">已选 {{ nodeStore.selectedNodeIds.length }} 个</span>
      <button class="sel-btn" @click="onDropToDialog">加入编排</button>
      <button class="sel-btn sel-pipeline" @click="onAddToPipeline">加入流水线</button>
      <button class="sel-btn sel-clear" @click="nodeStore.clearNodeSelection()">取消</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useNodeStore } from '@/stores/nodeStore'
import { useDialogStore } from '@/stores/dialogStore'

const nodeStore = useNodeStore()
const dialogStore = useDialogStore()

const emit = defineEmits<{
  filterChanged: []
}>()

const levels = [
  { key: 'L0', label: 'L0 用户核心', color: '#ffffff' },
  { key: 'L1', label: 'L1 核心工具', color: '#ffd700' },
  { key: 'L2', label: 'L2 角色工具', color: '#00ffff' },
  { key: 'L3', label: 'L3 社区工具', color: '#88aacc' }
]

const roles = [
  { key: 'finance', label: '财务' },
  { key: 'legal', label: '法务' },
  { key: 'hr', label: 'HR' },
  { key: 'sales', label: '销售' },
  { key: 'general', label: '通用' }
]

const hasFilters = computed(() => nodeStore.levelFilter.length > 0)

function onDropToDialog() {
  const nodes = nodeStore.addSelectedToDialog()
  if (nodes.length === 0) return
  const names = nodes.map(n => n.name).join(' + ')
  dialogStore.addSystemNotice(`已将 ${nodes.length} 个工具加入编排: ${names}`)
  for (let i = 0; i < nodes.length - 1; i++) {
    nodeStore.addFlowPath(nodes[i].id, nodes[i + 1].id)
  }
  for (const n of nodes) {
    dialogStore.addToolLogMessage({ toolName: n.name, steps: [{ toolId: n.id, toolName: n.name, action: '加入编排', result: '待执行', durationMs: 0 }], totalTimeMs: 0 })
  }
  nodeStore.clearNodeSelection()
}

function onAddToPipeline() {
  const nodes = nodeStore.addSelectedToDialog()
  if (nodes.length === 0) return
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
</script>

<style scoped>
.filter-bar {
  position: fixed;
  top: 28px;
  left: var(--dialog-panel-width, 460px);
  right: 12px;
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  background: rgba(5, 8, 18, 0.82);
  border-bottom: 1px solid rgba(80, 160, 255, 0.1);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  flex-wrap: wrap;
}
.filter-section {
  display: flex;
  align-items: center;
  gap: 4px;
}
.filter-label {
  font-size: 11px;
  color: #556;
  margin-right: 4px;
  white-space: nowrap;
}
.filter-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #334;
  background: rgba(10, 14, 28, 0.6);
  color: #667;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.filter-tag:hover {
  background: rgba(30, 40, 70, 0.8);
}
.filter-tag.active {
  background: rgba(30, 60, 120, 0.5);
  border-color: currentColor;
}
.role-tag.active {
  background: rgba(20, 80, 60, 0.5);
}
.clear-btn {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 10px;
  border: 1px solid #644;
  background: rgba(80, 30, 30, 0.3);
  color: #c88;
  cursor: pointer;
}
.clear-btn:hover {
  background: rgba(120, 40, 40, 0.5);
}
.selection-info {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.sel-count {
  font-size: 11px;
  color: #8cf;
}
.sel-btn {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 10px;
  border: 1px solid #48a;
  background: rgba(30, 60, 120, 0.4);
  color: #8cf;
  cursor: pointer;
}
.sel-btn:hover {
  background: rgba(40, 80, 160, 0.6);
}
.sel-clear {
  border-color: #654;
  background: rgba(80, 50, 30, 0.3);
  color: #ca8;
}
.sel-pipeline {
  border-color: #574;
  background: rgba(40, 80, 40, 0.4);
  color: #8c8;
}
.sel-pipeline:hover {
  background: rgba(50, 110, 50, 0.6);
}
</style>
