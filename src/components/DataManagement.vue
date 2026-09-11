<template>
  <div class="data-management">
    <div class="dm-section">
      <h4 class="dm-heading">数据导出</h4>
      <p class="dm-desc">将所有配置、对话历史、知识库数据导出为JSON文件</p>
      <button class="dm-btn" @click="onExport" :disabled="exporting">
        {{ exporting ? '导出中...' : '导出数据' }}
      </button>
    </div>

    <div class="dm-section">
      <h4 class="dm-heading">数据导入</h4>
      <p class="dm-desc">从JSON文件恢复数据（将覆盖现有数据）</p>
      <button class="dm-btn dm-btn-warn" @click="onImport" :disabled="importing">
        {{ importing ? '导入中...' : '导入数据' }}
      </button>
      <div class="dm-import-preview" v-if="importPreview">
        <div class="dm-preview-title">导入预览</div>
        <div class="dm-preview-item" v-for="(count, key) in importPreview" :key="key">
          <span>{{ previewLabel(key) }}</span>
          <span>{{ count }}条</span>
        </div>
        <div class="dm-preview-actions">
          <button class="dm-btn dm-btn-confirm" @click="confirmImport">确认导入</button>
          <button class="dm-btn" @click="importPreview = null">取消</button>
        </div>
      </div>
    </div>

    <div class="dm-section">
      <h4 class="dm-heading">存储用量</h4>
      <div class="dm-storage-bar">
        <div class="dm-storage-fill" :class="storageLevel" :style="{ width: storagePercent + '%' }"></div>
      </div>
      <div class="dm-storage-text">
        {{ storageUsed }} / 5MB · {{ storageLevel === 'green' ? '正常' : storageLevel === 'orange' ? '偏高' : '警告' }}
      </div>
    </div>

    <div class="dm-section">
      <h4 class="dm-heading">数据清理</h4>
      <button class="dm-btn dm-btn-danger" @click="onClearCache">清除缓存</button>
      <button class="dm-btn dm-btn-danger" @click="onClearHistory">清除对话历史</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useConfigStore } from '@/domains/config'
import { useDialogStore } from '@/domains/dialog'
import { useNodeStore } from '@/domains/node'
import { useKnowledgeStore } from '@/domains/knowledge'
import { useMemoryStore } from '@/domains/memory'
import { useNotificationStore } from '@/domains/app'
import { buildExportData, exportToZip, parseImportPreview, applyImport } from '@/domains/data'
import { getTotalUsedMB, getUsageLevel } from '@/domains/data'

const configStore = useConfigStore()
const dialogStore = useDialogStore()
const nodeStore = useNodeStore()
const knowledgeStore = useKnowledgeStore()
const memoryStore = useMemoryStore()
const notificationStore = useNotificationStore()

const exporting = ref(false)
const importing = ref(false)
const importPreview = ref<Record<string, number> | null>(null)
const importContent = ref<string | null>(null)
const storageUsed = ref('0KB')
const storagePercent = ref(0)
const storageLevel = ref<'green' | 'orange' | 'red'>('green')

function formatMB(mb: number): string {
  if (mb < 0.01) return '0KB'
  if (mb < 1) return `${Math.round(mb * 1024)}KB`
  return `${mb.toFixed(2)}MB`
}

function updateStorage() {
  const totalMB = getTotalUsedMB()
  const maxMB = 5
  storageUsed.value = formatMB(totalMB)
  storagePercent.value = Math.min(100, (totalMB / maxMB) * 100)
  storageLevel.value = getUsageLevel(totalMB)
}

onMounted(updateStorage)

async function onExport() {
  exporting.value = true
  try {
    const allItems = ['api-config', 'knowledge', 'conversations', 'pipelines', 'skills', 'cache', 'vectors']
    await exportToZip(allItems)
    notificationStore.addNotification('tool_complete', '数据导出', '数据已成功导出')
  } catch (err) {
    notificationStore.addNotification('tool_fail', '导出失败', String(err))
  } finally {
    exporting.value = false
  }
}

async function onImport() {
  if (importPreview.value) {
    importPreview.value = null
    return
  }
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      const preview = parseImportPreview(text)
      if (preview) {
        const map: Record<string, number> = {}
        for (const item of preview.items) {
          map[item.category] = item.count
        }
        importPreview.value = map
        importContent.value = text
      } else {
        notificationStore.addNotification('tool_fail', '导入失败', '文件格式不正确')
      }
    }
    input.click()
  } catch (err) {
    notificationStore.addNotification('tool_fail', '导入失败', String(err))
  }
}

async function confirmImport() {
  if (!importPreview.value || !importContent.value) return
  importing.value = true
  try {
    const preview = parseImportPreview(importContent.value)
    if (preview) {
      applyImport(importContent.value, preview)
    }
    notificationStore.addNotification('tool_complete', '数据导入', '数据已成功导入，部分设置需重启生效')
    importPreview.value = null
    importContent.value = null
  } catch (err) {
    notificationStore.addNotification('tool_fail', '导入失败', String(err))
  } finally {
    importing.value = false
    updateStorage()
  }
}

const PREVIEW_LABELS: Record<string, string> = {
  'api-config': 'API配置',
  knowledge: '知识库',
  conversations: '对话历史',
  pipelines: '流水线配置',
  skills: '技能配置',
  cache: '路由历史与缓存',
  vectors: '向量索引'
}

function previewLabel(key: string): string {
  return PREVIEW_LABELS[key] || key
}

function onClearCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('holo-') && !k.includes('config') && !k.includes('history'))
  for (const k of keys) localStorage.removeItem(k)
  notificationStore.addNotification('tool_complete', '缓存已清除', `已清除 ${keys.length} 项缓存`)
  updateStorage()
}

function onClearHistory() {
  if (!confirm('确定要清除所有对话历史吗？此操作不可撤销。')) return
  dialogStore.clearCurrentSession()
  notificationStore.addNotification('tool_complete', '历史已清除', '对话历史已清除')
  updateStorage()
}
</script>

<style scoped>
.data-management {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.dm-section {
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
}

.dm-section:last-child {
  border-bottom: none;
}

.dm-heading {
  font-size: 13px;
  font-weight: 600;
  color: #c0d8f0;
  margin: 0 0 4px;
}

.dm-desc {
  font-size: 11px;
  color: rgba(130, 170, 220, 0.4);
  margin: 0 0 10px;
}

.dm-btn {
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid rgba(100, 180, 255, 0.2);
  background: rgba(100, 180, 255, 0.1);
  color: #88bbff;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.dm-btn:hover:not(:disabled) {
  background: rgba(100, 180, 255, 0.2);
}

.dm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dm-btn-warn {
  border-color: rgba(255, 200, 50, 0.3);
  color: #ddaa44;
  background: rgba(255, 200, 50, 0.08);
}

.dm-btn-warn:hover:not(:disabled) {
  background: rgba(255, 200, 50, 0.2);
}

.dm-btn-confirm {
  border-color: rgba(80, 220, 120, 0.3);
  color: #55cc77;
  background: rgba(80, 220, 120, 0.08);
}

.dm-btn-confirm:hover:not(:disabled) {
  background: rgba(80, 220, 120, 0.2);
}

.dm-btn-danger {
  border-color: rgba(255, 80, 80, 0.3);
  color: #ff7777;
  background: rgba(255, 80, 80, 0.06);
  margin-right: 8px;
  margin-bottom: 4px;
}

.dm-btn-danger:hover:not(:disabled) {
  background: rgba(255, 80, 80, 0.15);
}

.dm-import-preview {
  margin-top: 12px;
  padding: 12px;
  border-radius: 6px;
  background: rgba(100, 180, 255, 0.04);
  border: 1px solid rgba(100, 180, 255, 0.12);
}

.dm-preview-title {
  font-size: 12px;
  font-weight: 600;
  color: #c0d8f0;
  margin-bottom: 8px;
}

.dm-preview-item {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 12px;
  color: #a0b8d0;
}

.dm-preview-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.dm-storage-bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
  margin-bottom: 4px;
}

.dm-storage-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}

.dm-storage-fill.green { background: #44cc66; }
.dm-storage-fill.orange { background: #ddaa44; }
.dm-storage-fill.red { background: #ff4444; }

.dm-storage-text {
  font-size: 11px;
  color: rgba(130, 170, 220, 0.4);
}
</style>
