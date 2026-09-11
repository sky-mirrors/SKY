<template>
  <div v-if="debugStore.enabled" class="debug-probe-panel" :class="{ collapsed: isCollapsed }">
    <div class="probe-header" @click="isCollapsed = !isCollapsed">
      <span class="header-icon">🔍</span>
      <span class="header-title">调试探针</span>
      <span class="probe-count">{{ debugStore.activeProbes.length }}</span>
      <span v-if="debugStore.errorProbes.length > 0" class="error-badge">{{ debugStore.errorProbes.length }}❌</span>
      <span v-if="debugStore.frozen" class="freeze-badge" @click.stop="onUnfreeze" title="探针已冻结，点击解冻">❄️ 冻结</span>
      <span v-if="debugStore.consoleLogs.length > 0" class="log-badge">📋{{ debugStore.consoleLogs.length }}</span>
      <span class="collapse-icon">{{ isCollapsed ? '◀' : '▶' }}</span>
    </div>

    <div v-if="!isCollapsed" class="probe-body">
      <div class="tab-bar">
        <button class="tab-btn" :class="{ active: activeTab === 'probes' }" @click="activeTab = 'probes'">探针</button>
        <button class="tab-btn" :class="{ active: activeTab === 'console' }" @click="activeTab = 'console'">控制台</button>
      </div>

      <template v-if="activeTab === 'probes'">
        <div class="probe-actions">
          <button class="probe-btn terminate-btn" @click="debugStore.terminateExecution" title="立即终止当前执行">⏹ 终止</button>
          <button class="probe-btn export-btn" @click="onExport" title="导出调试包">📦 导出</button>
          <button class="probe-btn replay-btn" @click="onReplay" :disabled="!debugStore.selectedProbe || debugStore.selectedProbe.manifestId.startsWith('pipeline-') || replayStatus === 'replaying'" title="从选中探针点重新执行">🔄 {{ replayStatus === 'replaying' ? '重放中...' : '重放' }}</button>
        </div>
        <div v-if="replayStatus !== 'idle'" class="replay-status" :class="{ success: replayStatus === 'success', error: replayStatus === 'error' }">{{ replayMessage }}</div>

        <div v-if="debugStore.errorProbes.length > 0" class="error-section">
          <div class="section-label">❌ 异常堆栈</div>
          <div v-for="err in debugStore.errorProbes" :key="err.id" class="error-item" @click="debugStore.selectProbe(err.id)">
            <div class="error-step">步骤{{ err.stepNum }} · {{ err.toolName }}</div>
            <div class="error-msg">{{ err.sourceDetail }}</div>
            <pre v-if="err.errorStack" class="error-stack">{{ err.errorStack }}</pre>
          </div>
        </div>

        <div class="probes-list">
          <div class="section-label">📡 探针时间线 ({{ debugStore.activeProbes.length }})</div>
          <div v-for="probe in debugStore.activeProbes" :key="probe.id"
               class="probe-item"
               :class="{ selected: debugStore.selectedProbeId === probe.id, [`source-${probe.source}`]: true }"
               @click="debugStore.selectProbe(probe.id)">
            <span class="probe-source-icon">{{ sourceIcon(probe.source) }}</span>
            <span class="probe-step">S{{ probe.stepNum }}</span>
            <span class="probe-tool">{{ probe.toolName }}</span>
            <span class="probe-duration">{{ probe.durationMs }}ms</span>
          </div>
        </div>

        <div v-if="debugStore.selectedProbe" class="probe-detail">
          <div class="section-label">🔎 探针详情</div>
          <div class="detail-row">
            <span class="detail-key">调度来源</span>
            <span class="detail-value" :class="`source-tag-${debugStore.selectedProbe.source}`">
              {{ sourceLabel(debugStore.selectedProbe.source) }}
            </span>
          </div>
          <div v-if="debugStore.selectedProbe.modelTier" class="detail-row">
            <span class="detail-key">模型Tier</span>
            <span class="detail-value tier-tag">{{ debugStore.selectedProbe.modelTier }}</span>
          </div>
          <div v-if="debugStore.selectedProbe.modelParams" class="detail-row">
            <span class="detail-key">模型参数</span>
            <span class="detail-value">temp={{ debugStore.selectedProbe.modelParams.temperature }} maxTokens={{ debugStore.selectedProbe.modelParams.maxTokens }}</span>
          </div>
          <div v-if="debugStore.selectedProbe.ruleId" class="detail-row">
            <span class="detail-key">命中规则</span>
            <span class="detail-value rule-tag">{{ debugStore.selectedProbe.ruleId }}</span>
          </div>
          <div v-if="debugStore.selectedProbe.cacheFingerprint" class="detail-row">
            <span class="detail-key">缓存指纹</span>
            <span class="detail-value mono">{{ debugStore.selectedProbe.cacheFingerprint.substring(0, 24) }}...</span>
          </div>
          <div v-if="debugStore.selectedProbe.tokenUsage" class="detail-row">
            <span class="detail-key">Tokens</span>
            <span class="detail-value mono">{{ debugStore.selectedProbe.tokenUsage.totalTokens }} (¥{{ debugStore.selectedProbe.tokenUsage.estimatedCostCny.toFixed(4) }})</span>
          </div>

          <div class="detail-section">
            <div class="detail-sublabel" @click="toggleInput">📥 输入快照 {{ inputExpanded ? '▼' : '▶' }}</div>
            <pre v-if="inputExpanded" class="detail-json">{{ formatJson(debugStore.selectedProbe.inputSnapshot) }}</pre>
          </div>

          <div class="detail-section">
            <div class="detail-sublabel" @click="toggleOutput">📤 输出快照 {{ outputExpanded ? '▼' : '▶' }}</div>
            <pre v-if="outputExpanded" class="detail-json">{{ formatOutput(debugStore.selectedProbe.outputSnapshot) }}</pre>
          </div>

          <div v-if="debugStore.selectedProbe.errorStack" class="detail-section">
            <div class="detail-sublabel error-label" @click="toggleStack">💥 错误堆栈 {{ stackExpanded ? '▼' : '▶' }}</div>
            <pre v-if="stackExpanded" class="detail-json error-text">{{ debugStore.selectedProbe.errorStack }}</pre>
          </div>
        </div>
      </template>

      <template v-if="activeTab === 'console'">
        <div class="console-toolbar">
          <input class="console-filter" v-model="debugStore.consoleFilterTag" placeholder="过滤标签 (如 RaaP, Dialog)" />
          <select class="console-level-select" v-model="debugStore.consoleFilterLevel">
            <option value="">全部</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="log">Log</option>
            <option value="info">Info</option>
          </select>
          <button class="probe-btn" @click="debugStore.clearConsoleLogs" title="清空日志">🗑️</button>
          <button class="probe-btn" @click="autoScroll = !autoScroll" :class="{ active: autoScroll }" title="自动滚动">⬇️</button>
        </div>
        <div class="console-list" ref="consoleListEl">
          <div v-for="entry in debugStore.filteredConsoleLogs" :key="entry.id"
               class="console-entry" :class="`level-${entry.level}`">
            <span class="console-time">{{ formatTime(entry.timestamp) }}</span>
            <span class="console-level-badge" :class="`badge-${entry.level}`">{{ entry.level.toUpperCase() }}</span>
            <span v-if="entry.tag" class="console-tag">[{{ entry.tag }}]</span>
            <span class="console-text">{{ entry.text }}</span>
          </div>
          <div v-if="debugStore.filteredConsoleLogs.length === 0" class="console-empty">暂无日志</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useDebugStore } from '@/domains/debug'
import type { ProbeSource } from '@/models'

const debugStore = useDebugStore()
const isCollapsed = ref(true)
const inputExpanded = ref(false)
const outputExpanded = ref(false)
const stackExpanded = ref(false)
const replayStatus = ref<'idle' | 'replaying' | 'success' | 'error'>('idle')
const replayMessage = ref('')
const activeTab = ref<'probes' | 'console'>('probes')
const autoScroll = ref(true)
const consoleListEl = ref<HTMLElement | null>(null)

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

watch(() => debugStore.filteredConsoleLogs.length, async () => {
  if (autoScroll.value && consoleListEl.value) {
    await nextTick()
    consoleListEl.value.scrollTop = consoleListEl.value.scrollHeight
  }
})

function sourceIcon(source: ProbeSource): string {
  const icons: Record<ProbeSource, string> = {
    rule: '📋',
    cache: '♻️',
    llm: '🤖',
    mcp: '🔌',
    shell: '💻',
    read_file: '📄',
    knowledge: '📚',
    skip: '⏭️',
    error: '❌'
  }
  return icons[source] || '❓'
}

function sourceLabel(source: ProbeSource): string {
  const labels: Record<ProbeSource, string> = {
    rule: '规则引擎',
    cache: '缓存复用',
    llm: '大模型',
    mcp: 'MCP工具',
    shell: 'Shell执行',
    read_file: '文件读取',
    knowledge: '知识检索',
    skip: '条件跳过',
    error: '执行错误'
  }
  return labels[source] || source
}

function formatJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

function formatOutput(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function toggleInput() { inputExpanded.value = !inputExpanded.value }
function toggleOutput() { outputExpanded.value = !outputExpanded.value }
function toggleStack() { stackExpanded.value = !stackExpanded.value }
function onUnfreeze() { debugStore.unfreezeBuffer() }

async function onExport() {
  const path = await debugStore.exportDebugPackage()
  if (path) {
    alert(`调试包已导出: ${path}`)
  }
}

async function onReplay() {
  const probe = debugStore.selectedProbe
  if (!probe) return
  replayStatus.value = 'replaying'
  const result = await debugStore.replayFromProbe(probe)
  replayStatus.value = result.success ? 'success' : 'error'
  replayMessage.value = result.message
  setTimeout(() => { replayStatus.value = 'idle' }, 5000)
}
</script>

<style scoped>
.debug-probe-panel {
  position: fixed;
  right: 8px;
  top: 40px;
  width: 340px;
  max-height: calc(100vh - 60px);
  background: rgba(10, 12, 20, 0.95);
  border: 1px solid rgba(255, 50, 50, 0.4);
  border-radius: 8px;
  font-size: 12px;
  color: #c8c8d0;
  z-index: 9999;
  overflow-y: auto;
  backdrop-filter: blur(8px);
}
.debug-probe-panel.collapsed {
  width: auto;
  max-height: none;
}
.probe-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 50, 50, 0.2);
  user-select: none;
}
.header-icon { font-size: 14px; }
.header-title { font-weight: bold; color: #ff6666; }
.probe-count {
  background: rgba(255, 50, 50, 0.3);
  color: #ff8888;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
}
.error-badge {
  background: rgba(255, 0, 0, 0.4);
  color: #ff4444;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
}
.freeze-badge {
  background: rgba(100, 180, 255, 0.3);
  color: #88ccff;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
  cursor: pointer;
  animation: freeze-pulse-sm 2s ease-in-out infinite;
}
.freeze-badge:hover { background: rgba(100, 180, 255, 0.5); color: #aaddff; }
@keyframes freeze-pulse-sm {
  0%, 100% { background: rgba(100, 180, 255, 0.3); }
  50% { background: rgba(100, 180, 255, 0.5); }
}
.collapse-icon { margin-left: auto; font-size: 10px; }
.probe-body { padding: 6px 8px; }
.probe-actions {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.probe-btn {
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: #ccc;
  cursor: pointer;
  font-size: 11px;
}
.probe-btn:hover { background: rgba(255, 255, 255, 0.12); }
.probe-btn:disabled { opacity: 0.3; cursor: default; }
.terminate-btn { border-color: rgba(255, 50, 50, 0.5); color: #ff6666; }
.export-btn { border-color: rgba(100, 200, 255, 0.5); color: #88ccff; }
.replay-btn { border-color: rgba(100, 255, 100, 0.5); color: #88ff88; }
.replay-status {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  margin: 4px 0;
  background: rgba(100, 100, 100, 0.3);
  color: #aaa;
}
.replay-status.success { background: rgba(0, 80, 0, 0.4); color: #88ff88; }
.replay-status.error { background: rgba(80, 0, 0, 0.4); color: #ff8888; }
.section-label {
  font-size: 11px;
  color: #888;
  margin: 6px 0 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.error-section { margin-bottom: 6px; }
.error-item {
  background: rgba(255, 0, 0, 0.1);
  border: 1px solid rgba(255, 50, 50, 0.3);
  border-radius: 4px;
  padding: 4px 6px;
  margin-bottom: 4px;
  cursor: pointer;
}
.error-item:hover { background: rgba(255, 0, 0, 0.2); }
.error-step { font-weight: bold; color: #ff6666; }
.error-msg { font-size: 11px; color: #ff8888; margin-top: 2px; }
.error-stack {
  font-size: 10px;
  color: #ff4444;
  max-height: 80px;
  overflow-y: auto;
  margin-top: 2px;
  white-space: pre-wrap;
}
.probes-list { margin-bottom: 6px; max-height: 200px; overflow-y: auto; }
.probe-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
  margin-bottom: 1px;
}
.probe-item:hover { background: rgba(255, 255, 255, 0.06); }
.probe-item.selected { background: rgba(255, 50, 50, 0.15); border: 1px solid rgba(255, 50, 50, 0.3); }
.probe-source-icon { font-size: 12px; }
.probe-step { font-weight: bold; color: #aaa; min-width: 24px; }
.probe-tool { flex: 1; color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-duration { font-size: 10px; color: #666; }
.source-error { border-left: 2px solid #ff4444; }
.source-llm { border-left: 2px solid #6688ff; }
.source-rule { border-left: 2px solid #44ff88; }
.source-cache { border-left: 2px solid #ffaa44; }
.source-shell { border-left: 2px solid #ff88cc; }
.probe-detail {
  border-top: 1px solid rgba(255, 50, 50, 0.2);
  padding-top: 6px;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
}
.detail-key { color: #888; font-size: 11px; }
.detail-value { color: #ccc; font-size: 11px; }
.detail-value.mono { font-family: monospace; font-size: 10px; }
.source-tag-rule { color: #44ff88; }
.source-tag-cache { color: #ffaa44; }
.source-tag-llm { color: #6688ff; }
.source-tag-error { color: #ff4444; }
.tier-tag { color: #cc88ff; }
.rule-tag { color: #44ff88; }
.detail-section { margin-top: 4px; }
.detail-sublabel {
  font-size: 11px;
  color: #888;
  cursor: pointer;
  user-select: none;
}
.detail-sublabel:hover { color: #bbb; }
.error-label { color: #ff6666; }
.detail-json {
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  padding: 4px;
  font-size: 10px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 2px;
  font-family: monospace;
}
.error-text { color: #ff4444; border-color: rgba(255, 50, 50, 0.3); }
.log-badge {
  background: rgba(100, 200, 255, 0.3);
  color: #88ccff;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
}
.tab-bar {
  display: flex;
  gap: 0;
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(255, 50, 50, 0.2);
}
.tab-btn {
  flex: 1;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: #888;
  cursor: pointer;
  font-size: 12px;
  border-bottom: 2px solid transparent;
}
.tab-btn:hover { color: #ccc; }
.tab-btn.active { color: #ff6666; border-bottom-color: #ff6666; }
.console-toolbar {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
  align-items: center;
}
.console-filter {
  flex: 1;
  padding: 3px 6px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.3);
  color: #ccc;
  font-size: 11px;
  outline: none;
}
.console-filter::placeholder { color: #555; }
.console-filter:focus { border-color: rgba(100, 200, 255, 0.5); }
.console-level-select {
  padding: 3px 4px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.3);
  color: #ccc;
  font-size: 11px;
  outline: none;
}
.console-level-select option { background: #1a1a2e; }
.console-list {
  max-height: 400px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 10px;
}
.console-entry {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 2px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  line-height: 1.4;
}
.console-entry:hover { background: rgba(255, 255, 255, 0.04); }
.console-entry.level-error { background: rgba(255, 0, 0, 0.08); }
.console-entry.level-warn { background: rgba(255, 170, 0, 0.06); }
.console-time { color: #555; white-space: nowrap; min-width: 82px; }
.console-level-badge {
  padding: 0 3px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: bold;
  white-space: nowrap;
}
.badge-error { background: rgba(255, 0, 0, 0.4); color: #ff4444; }
.badge-warn { background: rgba(255, 170, 0, 0.3); color: #ffaa00; }
.badge-log { background: rgba(100, 200, 255, 0.2); color: #88ccff; }
.badge-info { background: rgba(100, 255, 100, 0.2); color: #88ff88; }
.console-tag { color: #cc88ff; white-space: nowrap; }
.console-text { color: #ccc; word-break: break-all; }
.console-empty { color: #555; text-align: center; padding: 20px; }
</style>
