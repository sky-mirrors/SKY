<template>
  <div class="tool-selector" ref="selectorRef">
    <div class="selector-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key && showDropdown }"
        @click="onTabClick(tab.key)"
      >{{ tab.label }}</button>
    </div>
    <div class="selector-list" v-if="showDropdown && activeTab === 'L1'">
      <div
        v-for="node in l1Nodes"
        :key="node.id"
        class="tool-item"
        @click="addNode(node)"
      >
        <span class="tool-badge l1">L1</span>
        <span class="tool-name">{{ node.name }}</span>
      </div>
    </div>
    <div class="selector-list" v-if="showDropdown && activeTab === 'L2'">
      <div
        v-for="node in l2Nodes"
        :key="node.id"
        class="tool-item"
        @click="addNode(node)"
      >
        <span class="tool-badge l2">L2</span>
        <span class="tool-name">{{ node.name }}</span>
      </div>
    </div>
    <div class="selector-list" v-if="showDropdown && activeTab === 'L3'">
      <div
        v-for="node in l3Nodes"
        :key="node.id"
        class="tool-item"
        @click="addNode(node)"
      >
        <span class="tool-badge l3">L3</span>
        <span class="tool-name">{{ node.name }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useNodeStore } from '@/domains/node'
import { ToolNode } from '@/models'

const emit = defineEmits<{
  'add-node': [data: { toolId: string; toolName: string; toolLevel: string }]
}>()

const nodeStore = useNodeStore()
const activeTab = ref<'L1' | 'L2' | 'L3'>('L1')
const showDropdown = ref(false)
const selectorRef = ref<HTMLElement | null>(null)

const tabs = [
  { key: 'L1' as const, label: 'L1工具' },
  { key: 'L2' as const, label: 'L2宏' },
  { key: 'L3' as const, label: 'L3/MCP' }
]

const l1Nodes = computed(() => nodeStore.l1Nodes)
const l2Nodes = computed(() => nodeStore.l2Nodes)
const l3Nodes = computed(() => nodeStore.l3Nodes)

function onTabClick(tab: 'L1' | 'L2' | 'L3') {
  if (activeTab.value === tab && showDropdown.value) {
    showDropdown.value = false
  } else {
    activeTab.value = tab
    showDropdown.value = true
  }
}

function addNode(node: ToolNode) {
  emit('add-node', {
    toolId: node.id,
    toolName: node.name,
    toolLevel: node.level
  })
  showDropdown.value = false
}

function onDocumentClick(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    showDropdown.value = false
  }
}

onMounted(() => { document.addEventListener('click', onDocumentClick) })
onUnmounted(() => { document.removeEventListener('click', onDocumentClick) })
</script>

<style scoped>
.tool-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.selector-tabs {
  display: flex;
  gap: 2px;
}

.tab-btn {
  padding: 3px 10px;
  background: rgba(30, 50, 80, 0.3);
  border: 1px solid rgba(80, 120, 180, 0.15);
  border-radius: 3px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.tab-btn.active {
  background: rgba(40, 100, 180, 0.3);
  border-color: rgba(80, 160, 240, 0.4);
  color: #aaccff;
}
.tab-btn:hover {
  background: rgba(50, 90, 150, 0.3);
}

.selector-list {
  position: absolute;
  top: 32px;
  left: 0;
  background: rgba(8, 14, 28, 0.96);
  border: 1px solid rgba(80, 120, 180, 0.25);
  border-radius: 6px;
  padding: 4px;
  min-width: 220px;
  max-height: 300px;
  overflow-y: auto;
  z-index: 200;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.1s;
}
.tool-item:hover {
  background: rgba(40, 80, 140, 0.3);
}

.tool-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 2px;
  letter-spacing: 0.5px;
}
.tool-badge.l1 { background: rgba(68, 170, 255, 0.2); color: #44aaff; }
.tool-badge.l2 { background: rgba(0, 229, 255, 0.2); color: #00e5ff; }
.tool-badge.l3 { background: rgba(255, 102, 170, 0.2); color: #ff66aa; }

.tool-name {
  font-size: 11px;
  color: #c0d0e0;
}
</style>
