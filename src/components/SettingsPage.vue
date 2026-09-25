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

          <div v-if="activeTab === 'perf'" class="sp-section">
            <div class="sp-field">
              <label>LLM 超时倍率</label>
              <!-- P0-B4：CPU 慢机可调大超时（乘各档基准阶梯，绝对上限 10 分钟不变） -->
              <select
                :value="configStore.config.llmTimeoutScale ?? 1"
                @change="configStore.setLlmTimeoutScale(Number(($event.target as HTMLSelectElement).value))"
              >
                <option :value="0.5">0.5x（快机）</option>
                <option :value="1">1x（默认）</option>
                <option :value="2">2x</option>
                <option :value="3">3x（慢机）</option>
                <option :value="5">5x</option>
              </select>
            </div>
          </div>

          <!-- 2026-09-25（机制体检）：用户计价层的可读写面——此前全仓无计价 UI（写而不读） -->
          <div v-if="activeTab === 'pricing'" class="sp-section">
            <div class="sp-field">
              <label>输入单价（元 / 千 tokens）</label>
              <input type="number" step="0.0001" min="0" v-model.number="pricing.inputPricePer1k" />
            </div>
            <div class="sp-field">
              <label>输出单价（元 / 千 tokens）</label>
              <input type="number" step="0.0001" min="0" v-model.number="pricing.outputPricePer1k" />
            </div>
            <div class="sp-field">
              <label>缓存命中折扣（0~1）</label>
              <input type="number" step="0.05" min="0" max="1" v-model.number="pricing.cacheHitDiscount" />
            </div>
            <div class="sp-field">
              <label>估算预览（1k 输入 + 1k 输出）</label>
              <span class="sp-hint">¥{{ estimateCny.toFixed(4) }}</span>
            </div>
            <div class="sp-actions">
              <button class="sp-btn" @click="savePricing">保存</button>
              <button class="sp-btn sp-btn-ghost" @click="resetPricing">恢复默认</button>
            </div>
            <div class="sp-hint">单价用于估算对话成本（调试台「估算成本」与 Token 预算）。</div>
          </div>

          <!-- HANDOFF 下一步 4 续：会话记忆的跨重启策略开关 -->
          <div v-if="activeTab === 'memory'" class="sp-section">
            <div class="sp-field">
              <label>跨重启记住上一段对话</label>
              <input
                type="checkbox"
                :checked="configStore.config.restoreSessionMemoryOnStartup === true"
                @change="configStore.setRestoreSessionMemoryOnStartup(($event.target as HTMLInputElement).checked)"
              />
            </div>
            <div class="sp-hint">
              关闭（默认）：一次运行一个会话——重启后不把上一段对话带入新会话（旧会话仍归档保留在 holo-session-archive）。
              开启：启动时恢复上一次运行的会话记忆，让助手继续记得上一段对话的内容。
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
import { ref, computed } from 'vue'
import { useConfigStore } from '@/domains/config'
import { useNotificationStore } from '@/domains/app'
import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useMcpStore } from '@/domains/mcp'
import DataManagement from './DataManagement.vue'
import { getUserPricing, setUserPricing, resetUserPricing } from '@/services/tokenPricing'

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

// 用户计价（设置 → 计价）：打开设置时从服务读回，保存写回（此前该层全仓无 UI）
const pricing = ref({ ...getUserPricing() })
const estimateCny = computed(() => Number(pricing.value.inputPricePer1k || 0) + Number(pricing.value.outputPricePer1k || 0))

const tabs = [
  { id: 'appearance', icon: '🎨', label: '外观' },
  { id: 'perf', icon: '⚡', label: '性能' },
  { id: 'pricing', icon: '💰', label: '计价' },
  { id: 'memory', icon: '🧠', label: '记忆' },
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
  pricing.value = { ...getUserPricing() }
}

function close() {
  visible.value = false
}

function savePricing() {
  setUserPricing({
    inputPricePer1k: Math.max(0, Number(pricing.value.inputPricePer1k) || 0),
    outputPricePer1k: Math.max(0, Number(pricing.value.outputPricePer1k) || 0),
    cacheHitDiscount: Math.min(1, Math.max(0, Number(pricing.value.cacheHitDiscount) || 0))
  })
  pricing.value = { ...getUserPricing() }
}

function resetPricing() {
  resetUserPricing()
  pricing.value = { ...getUserPricing() }
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

/* 设置 → 计价（2026-09-25 机制体检：用户计价层的可读写面） */
.sp-field input[type="number"] {
  width: 150px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(100, 180, 255, 0.2);
  background: rgba(10, 20, 40, 0.6);
  color: #c0d8f0;
  font-size: 12px;
  outline: none;
}

.sp-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}

.sp-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid rgba(100, 180, 255, 0.3);
  background: rgba(80, 160, 255, 0.2);
  color: #88bbff;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.sp-btn:hover {
  background: rgba(80, 160, 255, 0.35);
}

.sp-btn-ghost {
  background: transparent;
  color: rgba(130, 170, 220, 0.7);
}

.sp-hint {
  font-size: 12px;
  color: rgba(130, 170, 220, 0.5);
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
