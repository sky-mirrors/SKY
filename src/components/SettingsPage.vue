<template>
  <transition name="settings-fade">
    <div class="settings-overlay" v-if="visible" @click.self="close">
      <div class="settings-page">
        <div class="sp-header">
          <span class="sp-title">设置</span>
          <button class="sp-close" @click="close">✕</button>
        </div>
        <div class="sp-nav">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="sp-nav-btn"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >{{ tab.icon }} {{ tab.label }}</button>
        </div>
        <div class="sp-body">
          <div v-if="activeTab === 'appearance'" class="sp-section">
            <div class="sp-field">
              <label>主题</label>
              <!-- D-12：下拉框按选定值直达，不再调用循环切换的 toggleTheme -->
              <select :value="configStore.theme" @change="configStore.setTheme(($event.target as HTMLSelectElement).value as 'light' | 'green' | 'dark')">
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="green">护眼</option>
              </select>
            </div>
            <div class="sp-field">
              <label>术语风格</label>
              <select v-model="terminologyStyle" @change="configStore.setTerminologyStyle(terminologyStyle)">
                <option value="technical">专业模式</option>
                <option value="plain">轻松模式</option>
              </select>
            </div>
            <div class="sp-field">
              <label>动画</label>
              <input
                type="checkbox"
                :checked="animationEnabled"
                @change="animationEnabled = !animationEnabled; configStore.setAnimationEnabled(animationEnabled)"
              />
            </div>
          </div>

          <div v-if="activeTab === 'notifications'" class="sp-section">
            <div class="sp-field" v-for="(val, key) in notificationStore.settings" :key="key">
              <label>{{ settingLabel(key) }}</label>
              <input
                type="checkbox"
                :checked="val as boolean"
                @change="notificationStore.updateSettings({ [key]: !val })"
                v-if="key !== 'popupDuration'"
              />
              <select
                v-if="key === 'popupDuration'"
                :value="val"
                @change="notificationStore.updateSettings({ popupDuration: Number(($event.target as HTMLSelectElement).value) })"
              >
                <option :value="1000">1秒</option>
                <option :value="2000">2秒</option>
                <option :value="4000">4秒</option>
                <option :value="8000">8秒</option>
              </select>
            </div>
          </div>

          <div v-if="activeTab === 'data'" class="sp-section">
            <DataManagement ref="dataMgmtRef" />
          </div>

          <div v-if="activeTab === 'shortcuts'" class="sp-section">
            <div class="sp-shortcut-list">
              <div class="sp-shortcut-item">
                <span>命令面板</span>
                <kbd>Ctrl+P</kbd>
              </div>
              <div class="sp-shortcut-item">
                <span>重置视角</span>
                <kbd>Esc</kbd>
              </div>
              <div class="sp-shortcut-item">
                <span>发送消息</span>
                <kbd>Enter</kbd>
              </div>
              <div class="sp-shortcut-item">
                <span>多选工具 → 流水线</span>
                <kbd>Ctrl+Enter</kbd>
              </div>
              <div class="sp-shortcut-item">
                <span>切换视图</span>
                <kbd>标题栏 📊 按钮</kbd>
              </div>
            </div>
          </div>

          <div v-if="activeTab === 'about'" class="sp-section">
            <div class="sp-about-logo">🌌</div>
            <div class="sp-about-name">HoloStarmap</div>
            <div class="sp-about-version">v0.1.0</div>
            <div class="sp-about-row"><span>节点数</span><span>{{ nodeStore.nodes.length }}</span></div>
            <div class="sp-about-row"><span>L2清单</span><span>{{ nodeStore.getAllL2Manifests().length }}</span></div>
            <div class="sp-about-row"><span>模型</span><span>{{ apiStore.config.activeModel || '未配置' }}</span></div>
            <div class="sp-about-row"><span>MCP连接</span><span>{{ mcpStore.connections.length }}</span></div>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useConfigStore } from '@/domains/config'
import { useNotificationStore } from '@/domains/app'
import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useMcpStore } from '@/domains/mcp'
import DataManagement from './DataManagement.vue'

const configStore = useConfigStore()
const notificationStore = useNotificationStore()
const nodeStore = useNodeStore()
const apiStore = useApiStore()
const mcpStore = useMcpStore()

const visible = ref(false)
const activeTab = ref('appearance')
const terminologyStyle = ref<'technical' | 'plain'>(configStore.terminologyStyle as 'technical' | 'plain')
const animationEnabled = ref(configStore.animationEnabled)
const dataMgmtRef = ref()

const tabs = [
  { id: 'appearance', icon: '🎨', label: '外观' },
  { id: 'notifications', icon: '🔔', label: '通知' },
  { id: 'data', icon: '💾', label: '数据' },
  { id: 'shortcuts', icon: '⌨', label: '快捷键' },
  { id: 'about', icon: 'ℹ', label: '关于' }
]

const SETTING_LABELS: Record<string, string> = {
  auditBlock: '审计阻断通知',
  apiDegrade: 'API降级通知',
  toolComplete: '工具完成通知',
  toolFail: '工具失败通知',
  cacheHit: '缓存命中通知',
  knowledgeIngest: '知识库导入通知',
  storageWarning: '存储空间警告',
  popupDuration: '弹窗持续时间'
}

function settingLabel(key: string): string {
  return SETTING_LABELS[key] || key
}

function open(tab?: string) {
  visible.value = true
  activeTab.value = tab || 'appearance'
  terminologyStyle.value = configStore.terminologyStyle as 'technical' | 'plain'
  animationEnabled.value = configStore.animationEnabled
}

function close() {
  visible.value = false
}

// P1-47：暴露 visible 供 App.vue Esc 链判断弹层是否打开
defineExpose({ open, close, visible })
</script>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 4500;
}

.settings-page {
  width: 560px;
  max-height: 70vh;
  background: rgba(10, 16, 32, 0.96);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.1);
}

.sp-title {
  font-size: 16px;
  font-weight: 600;
  color: #c0d8f0;
}

.sp-close {
  background: none;
  border: none;
  color: rgba(130, 170, 220, 0.5);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.sp-close:hover {
  color: #ff8888;
  background: rgba(255, 60, 60, 0.1);
}

.sp-nav {
  display: flex;
  gap: 0;
  padding: 0 20px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
}

.sp-nav-btn {
  padding: 10px 14px;
  border: none;
  background: none;
  color: rgba(130, 170, 220, 0.5);
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  white-space: nowrap;
}

.sp-nav-btn.active {
  color: #88bbff;
  border-bottom-color: #88bbff;
}

.sp-nav-btn:hover {
  color: #a0ccff;
}

.sp-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.sp-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.sp-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sp-field label {
  font-size: 13px;
  color: #a0b8d0;
}

.sp-field select {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(100, 180, 255, 0.2);
  background: rgba(10, 20, 40, 0.6);
  color: #c0d8f0;
  font-size: 12px;
  outline: none;
}

.sp-field input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #4488ff;
  cursor: pointer;
}

.sp-shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 13px;
  color: #a0b8d0;
}

.sp-shortcut-item kbd {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(100, 180, 255, 0.08);
  border: 1px solid rgba(100, 180, 255, 0.15);
  font-size: 11px;
  color: #88bbff;
  font-family: monospace;
}

.sp-about-logo {
  font-size: 48px;
  text-align: center;
  margin-bottom: 8px;
}

.sp-about-name {
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: #c0d8f0;
  margin-bottom: 4px;
}

.sp-about-version {
  text-align: center;
  font-size: 12px;
  color: rgba(130, 170, 220, 0.4);
  margin-bottom: 16px;
}

.sp-about-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
}

.sp-about-row span:first-child { color: #7a90a8; }
.sp-about-row span:last-child { color: #c0d8f0; font-family: monospace; }

.settings-fade-enter-active { transition: opacity 0.15s; }
.settings-fade-leave-active { transition: opacity 0.1s; }
.settings-fade-enter-from, .settings-fade-leave-to { opacity: 0; }
</style>
