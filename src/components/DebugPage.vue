<template>
  <div v-if="debugStore.enabled" class="debug-page-overlay">
    <div class="debug-page">
      <div class="debug-page-header">
        <span class="debug-title">调试中心</span>
        <div class="debug-header-actions">
          <button class="dbg-btn" @click="onClearAll">清空全部</button>
          <button class="dbg-btn dbg-close" @click="debugStore.deactivate">关闭 [Esc]</button>
        </div>
      </div>

      <div class="debug-split">
        <div class="debug-left">
          <div class="panel-title">执行流程</div>
          <div class="time-travel-bar" v-if="debugStore.activeProbes.length > 1">
            <input type="range" class="time-slider" :min="0" :max="debugStore.activeProbes.length - 1" v-model.number="timeTravelIdx" />
            <span class="time-label">步骤 {{ timeTravelIdx + 1 }} / {{ debugStore.activeProbes.length }}</span>
          </div>
          <div class="probes-list">
            <div v-for="(probe, idx) in debugStore.activeProbes" :key="probe.id"
                 class="probe-item" :class="{ selected: debugStore.selectedProbeId === probe.id, [`source-${probe.source}`]: true, dimmed: timeTravelIdx >= 0 && idx > timeTravelIdx }"
                 @click="debugStore.selectProbe(probe.id)">
              <span class="probe-source-icon">{{ sourceIcon(probe.source) }}</span>
              <span class="probe-step">S{{ probe.stepNum }}</span>
              <span class="probe-tool">{{ probe.toolName }}</span>
              <span class="probe-duration">{{ probe.durationMs }}ms</span>
              <span class="probe-source-label">{{ sourceLabel(probe.source) }}</span>
            </div>
            <div v-if="debugStore.activeProbes.length === 0" class="empty-hint">暂无探针</div>
           </div>
           <div class="profiler-section">
             <div class="panel-title">性能剖析</div>
             <div class="profiler-summary">
               <div class="profiler-stat"><span>Total Tokens</span><span>{{ debugStore.totalTokenUsage.totalTokens }}</span></div>
               <div class="profiler-stat"><span>估算成本</span><span>{{ debugStore.totalTokenUsage.estimatedCostCny.toFixed(4) }} CNY</span></div>
             </div>
             <div class="waterfall">
               <div v-for="probe in debugStore.activeProbes" :key="'wf-'+probe.id" class="waterfall-row">
                 <span class="wf-step">S{{ probe.stepNum }}</span>
                 <div class="wf-bar-container">
                   <div class="wf-bar" :class="`bar-${probe.source}`" :style="{ width: barWidth(probe.durationMs) + '%' }"></div>
                 </div>
                 <span class="wf-ms">{{ probe.durationMs }}ms</span>
                 <span v-if="debugStore.stepCosts[probe.stepNum]" class="wf-cost">{{ debugStore.stepCosts[probe.stepNum].estimatedCostCny.toFixed(4) }}¥</span>
               </div>
             </div>
           </div>
          <div v-if="debugStore.selectedProbe" class="probe-detail">
            <div class="detail-grid">
              <div class="detail-cell"><span class="dk">来源</span><span class="dv" :class="`source-tag-${debugStore.selectedProbe.source}`">{{ sourceLabel(debugStore.selectedProbe.source) }}</span></div>
              <div v-if="debugStore.selectedProbe.modelTier" class="detail-cell"><span class="dk">Tier</span><span class="dv tier-tag">{{ debugStore.selectedProbe.modelTier }}</span></div>
              <div v-if="debugStore.selectedProbe.ruleId" class="detail-cell"><span class="dk">规则</span><span class="dv rule-tag">{{ debugStore.selectedProbe.ruleId }}</span></div>
              <div v-if="debugStore.selectedProbe.cacheFingerprint" class="detail-cell"><span class="dk">指纹</span><span class="dv mono">{{ debugStore.selectedProbe.cacheFingerprint.substring(0, 24) }}</span></div>
            </div>
            <div class="detail-section">
              <div class="detail-sublabel" @click="inputExpanded = !inputExpanded">输入 {{ inputExpanded ? '▼' : '▶' }}</div>
              <pre v-if="inputExpanded" class="detail-json">{{ formatJson(debugStore.selectedProbe.inputSnapshot) }}</pre>
            </div>
            <div class="detail-section">
              <div class="detail-sublabel" @click="outputExpanded = !outputExpanded">输出 {{ outputExpanded ? '▼' : '▶' }}</div>
              <pre v-if="outputExpanded" class="detail-json">{{ debugStore.selectedProbe.outputSnapshot }}</pre>
            </div>
            <div v-if="debugStore.selectedProbe.errorStack" class="detail-section">
              <div class="detail-sublabel error-label" @click="stackExpanded = !stackExpanded">错误堆栈 {{ stackExpanded ? '▼' : '▶' }}</div>
              <pre v-if="stackExpanded" class="detail-json error-text">{{ debugStore.selectedProbe.errorStack }}</pre>
            </div>
          </div>
        </div>

        <div class="debug-right">
          <div class="panel-title">实时控制台</div>
          <div class="console-toolbar">
            <select class="console-cat-select" v-model="debugStore.consoleFilterCategory">
              <option value="">全部分类</option>
              <option v-for="cat in categories" :key="cat" :value="cat">{{ debugStore.CATEGORY_ICONS[cat] }} {{ cat }}</option>
            </select>
            <select class="console-level-select" v-model="debugStore.consoleFilterLevel">
              <option value="">全部级别</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="log">Log</option>
              <option value="info">Info</option>
            </select>
            <input class="console-filter" v-model="debugStore.consoleFilterTag" placeholder="过滤标签..." />
            <button class="dbg-btn" @click="debugStore.clearConsoleLogs">清空</button>
            <button class="dbg-btn" @click="autoScroll = !autoScroll" :class="{ active: autoScroll }">自动滚动</button>
          </div>
          <div class="console-list" ref="consoleListEl">
            <div v-for="entry in debugStore.filteredConsoleLogs" :key="entry.id"
                 class="console-entry" :class="`level-${entry.level}`" @click="onEntryClick(entry)">
              <span class="console-time">{{ formatTime(entry.timestamp) }}</span>
              <span v-if="entry.category" class="console-cat-icon">{{ debugStore.CATEGORY_ICONS[entry.category] }}</span>
              <span class="console-level-badge" :class="`badge-${entry.level}`">{{ entry.level.toUpperCase() }}</span>
              <span v-if="entry.tag" class="console-tag">[{{ entry.tag }}]</span>
              <span class="console-text">{{ entry.text }}</span>
            </div>
            <div v-if="debugStore.filteredConsoleLogs.length === 0" class="empty-hint">等待日志...</div>
          </div>
          <div v-if="selectedDetail" class="console-detail-bar">
            <div class="detail-bar-header">
              <span>详情</span>
              <button class="dbg-btn" @click="selectedDetail = null">关闭</button>
            </div>
            <pre class="detail-bar-content">{{ selectedDetail }}</pre>
          </div>
        </div>
      </div>

      <div class="debug-footer">
        <button class="action-btn small terminate" @click="debugStore.terminateExecution">终止执行</button>
        <button class="action-btn small export" @click="onExport">导出调试包</button>
        <button class="action-btn small replay" @click="onReplay" :disabled="!debugStore.selectedProbe || replayStatus === 'replaying'">重放探针</button>
        <button class="action-btn small" @click="onBackupCreate">备份</button>
        <button class="action-btn small" @click="onBackupRestore">还原</button>
        <button class="action-btn small" @click="onResetAutoCompile">重置自编译</button>
        <div class="footer-stats">
          探针{{ debugStore.activeProbes.length }} | 异常{{ debugStore.errorProbes.length }} | 日志{{ debugStore.consoleLogs.length }}
        </div>
        <div v-if="replayStatus !== 'idle'" class="replay-status" :class="{ success: replayStatus === 'success', error: replayStatus === 'error' }">{{ replayMessage }}</div>
        <div v-if="footerMsg" class="replay-status" :class="{ success: footerMsg.includes('成功') }">{{ footerMsg }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useDebugStore } from '@/stores/debugStore'
import type { ProbeSource, ConsoleLogEntry, ConsoleCategory } from '@/models'

const debugStore = useDebugStore()
const inputExpanded = ref(false)
const outputExpanded = ref(false)
const stackExpanded = ref(false)
const replayStatus = ref<'idle' | 'replaying' | 'success' | 'error'>('idle')
const replayMessage = ref('')
const autoScroll = ref(true)
const consoleListEl = ref<HTMLElement | null>(null)
const selectedDetail = ref<string | null>(null)
const footerMsg = ref('')
const timeTravelIdx = ref(-1)

watch(timeTravelIdx, (idx) => {
  if (idx >= 0 && idx < debugStore.activeProbes.length) {
    debugStore.selectProbe(debugStore.activeProbes[idx].id)
  }
})

const categories: ConsoleCategory[] = ['system', 'raap', 'llm', 'shell', 'cache', 'rule', 'dialog', 'feedback', 'factguard', 'tool', 'schedule']

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && debugStore.enabled) {
    debugStore.deactivate()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

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
  const icons: Record<ProbeSource, string> = { rule: '📋', cache: '♻️', llm: '🤖', mcp: '🔌', shell: '💻', read_file: '📄', knowledge: '📚', skip: '⏭️', error: '❌' }
  return icons[source] || '❓'
}

function sourceLabel(source: ProbeSource): string {
  const labels: Record<ProbeSource, string> = { rule: '规则', cache: '缓存', llm: 'LLM', mcp: 'MCP', shell: 'Shell', read_file: '文件', knowledge: '知识', skip: '跳过', error: '错误' }
  return labels[source] || source
}

function formatJson(obj: Record<string, unknown>): string {
  try { return JSON.stringify(obj, null, 2) } catch { return String(obj) }
}

function onEntryClick(entry: ConsoleLogEntry) {
  selectedDetail.value = entry.detail || entry.text
}

function barWidth(ms: number): number {
  const maxMs = Math.max(...debugStore.activeProbes.map(p => p.durationMs), 1)
  return Math.max(2, (ms / maxMs) * 100)
}

function onClearAll() {
  debugStore.clearConsoleLogs()
  footerMsg.value = ''
}

async function onExport() {
  const path = await debugStore.exportDebugPackage()
  if (path) alert(`调试包已导出: ${path}`)
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

async function onBackupCreate() {
  try {
    const result = await window.electronAPI.backupCreate()
    footerMsg.value = result.success ? `备份成功: ${result.path}` : result.error || '失败'
  } catch (e) { footerMsg.value = (e as Error).message }
  setTimeout(() => { footerMsg.value = '' }, 5000)
}

async function onBackupRestore() {
  try {
    const result = await window.electronAPI.backupRestore()
    footerMsg.value = result.success ? '还原成功，请重启' : result.error || '失败'
  } catch (e) { footerMsg.value = (e as Error).message }
  setTimeout(() => { footerMsg.value = '' }, 5000)
}

async function onResetAutoCompile() {
  try {
    const { resetManifestStats } = await import('@/services/scheduleOptimizer')
    resetManifestStats()
    footerMsg.value = '自编译统计已重置'
  } catch (e) { footerMsg.value = (e as Error).message }
  setTimeout(() => { footerMsg.value = '' }, 5000)
}
</script>

<style scoped>
.debug-page-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(12px);
  display: flex; align-items: center; justify-content: center;
  animation: fadeIn 0.2s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.debug-page {
  width: 95vw; max-width: 1600px; height: 90vh;
  background: #0a0c14; border: 1px solid rgba(255, 50, 50, 0.3);
  border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 0 60px rgba(255, 30, 30, 0.15);
}
.debug-page-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid rgba(255, 50, 50, 0.2);
  background: rgba(255, 20, 20, 0.05);
}
.debug-title { font-size: 15px; font-weight: 700; color: #ff6666; letter-spacing: 1px; }
.debug-header-actions { display: flex; gap: 6px; }
.dbg-btn {
  padding: 4px 10px; border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px; background: rgba(255, 255, 255, 0.05);
  color: #aaa; cursor: pointer; font-size: 11px; transition: all 0.15s;
}
.dbg-btn:hover { background: rgba(255, 255, 255, 0.12); color: #ddd; }
.dbg-btn.active { background: rgba(100, 200, 255, 0.2); color: #88ccff; border-color: rgba(100, 200, 255, 0.4); }
.dbg-btn:disabled { opacity: 0.3; cursor: default; }
.dbg-close { border-color: rgba(255, 50, 50, 0.5); color: #ff6666; }
.dbg-close:hover { background: rgba(255, 30, 30, 0.3); }

.debug-split {
  flex: 1; display: flex; overflow: hidden;
}
.debug-left {
  width: 280px; min-width: 200px; border-right: 1px solid rgba(255, 50, 50, 0.15);
  display: flex; flex-direction: column; overflow: hidden;
}
.debug-right {
  flex: 1; display: flex; flex-direction: column; overflow: hidden;
}
.panel-title {
  font-size: 11px; color: #ff6666; font-weight: bold; padding: 6px 12px;
  border-bottom: 1px solid rgba(255, 50, 50, 0.1); background: rgba(0,0,0,0.3);
  text-transform: uppercase; letter-spacing: 1px;
}

.probes-list {
  flex: 1; overflow-y: auto; padding: 4px;
}
.probe-item {
  display: flex; align-items: center; gap: 4px; padding: 4px 6px;
  border-radius: 3px; cursor: pointer; margin-bottom: 1px; font-size: 11px;
}
.probe-item:hover { background: rgba(255, 255, 255, 0.05); }
.probe-item.selected { background: rgba(255, 50, 50, 0.15); border: 1px solid rgba(255, 50, 50, 0.3); }
.probe-item.dimmed { opacity: 0.25; }

.time-travel-bar {
  padding: 4px 8px; border-bottom: 1px solid rgba(255,50,50,0.1);
  display: flex; align-items: center; gap: 6px;
}
.time-slider {
  flex: 1; height: 4px; -webkit-appearance: none; background: rgba(255,255,255,0.1);
  border-radius: 2px; outline: none;
}
.time-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px;
  border-radius: 50%; background: #ff6666; cursor: pointer;
}
.time-label { font-size: 10px; color: #888; white-space: nowrap; }
.probe-source-icon { font-size: 12px; }
.probe-step { font-weight: bold; color: #888; min-width: 22px; }
.probe-tool { flex: 1; color: #bbb; }
.probe-duration { color: #555; font-size: 10px; }
.probe-source-label { color: #666; font-size: 10px; }
.source-error { border-left: 2px solid #ff4444; }
.source-llm { border-left: 2px solid #6688ff; }
.source-rule { border-left: 2px solid #44ff88; }
.source-cache { border-left: 2px solid #ffaa44; }

.probe-detail {
  border-top: 1px solid rgba(255, 50, 50, 0.15); padding: 8px; overflow-y: auto; max-height: 300px;
}
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 8px; }
.detail-cell { display: flex; justify-content: space-between; padding: 2px 6px; background: rgba(0,0,0,0.3); border-radius: 3px; }
.dk { color: #666; font-size: 11px; }
.dv { color: #ccc; font-size: 11px; }
.dv.mono { font-family: monospace; font-size: 10px; }
.source-tag-rule { color: #44ff88; }
.source-tag-cache { color: #ffaa44; }
.source-tag-llm { color: #6688ff; }
.source-tag-error { color: #ff4444; }
.tier-tag { color: #cc88ff; }
.rule-tag { color: #44ff88; }

.profiler-section {
  border-top: 1px solid rgba(255,50,50,0.15); padding: 8px;
}
.profiler-summary {
  display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 8px;
}
.profiler-stat {
  display: flex; justify-content: space-between; padding: 3px 6px;
  background: rgba(0,0,0,0.3); border-radius: 3px; font-size: 11px;
}
.profiler-stat span:first-child { color: #666; }
.profiler-stat span:last-child { color: #ccc; font-family: monospace; }

.waterfall { font-size: 10px; }
.waterfall-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
.wf-step { color: #888; min-width: 22px; font-weight: bold; }
.wf-bar-container { flex: 1; height: 8px; background: rgba(255,255,255,0.05); border-radius: 2px; overflow: hidden; }
.wf-bar { height: 100%; border-radius: 2px; transition: width 0.3s; }
.bar-llm { background: linear-gradient(90deg, #6688ff, #88aaff); }
.bar-shell { background: linear-gradient(90deg, #44ff88, #88ffbb); }
.bar-rule { background: linear-gradient(90deg, #ffaa44, #ffcc88); }
.bar-cache { background: linear-gradient(90deg, #ff8844, #ffaa88); }
.bar-error { background: linear-gradient(90deg, #ff4444, #ff8888); }
.bar-tool, .bar-mcp, .bar-read_file, .bar-knowledge { background: linear-gradient(90deg, #88aacc, #aaccdd); }
.wf-ms { color: #888; min-width: 40px; text-align: right; }
.wf-cost { color: #ffaa44; min-width: 45px; text-align: right; }
.detail-section { margin-top: 4px; }
.detail-sublabel { font-size: 11px; color: #666; cursor: pointer; user-select: none; padding: 2px 0; }
.detail-sublabel:hover { color: #aaa; }
.error-label { color: #ff6666; }
.detail-json {
  background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 3px; padding: 6px; font-size: 10px; max-height: 150px;
  overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 2px;
  font-family: 'Consolas', 'Monaco', monospace; color: #aaa;
}
.error-text { color: #ff4444; border-color: rgba(255, 50, 50, 0.3); }

.console-toolbar { display: flex; gap: 4px; padding: 4px 8px; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); }
.console-filter {
  flex: 1; padding: 4px 8px; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 3px; background: rgba(0,0,0,0.4); color: #ccc; font-size: 11px; outline: none;
}
.console-filter::placeholder { color: #444; }
.console-filter:focus { border-color: rgba(100, 200, 255, 0.5); }
.console-cat-select, .console-level-select {
  padding: 4px 6px; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 3px; background: rgba(0,0,0,0.4); color: #ccc; font-size: 11px; outline: none;
}
.console-cat-select option, .console-level-select option { background: #0a0c14; }

.console-list {
  flex: 1; overflow-y: auto; padding: 4px;
  font-family: 'Consolas', 'Monaco', monospace; font-size: 11px;
}
.console-entry {
  display: flex; align-items: flex-start; gap: 4px;
  padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.02);
  line-height: 1.4; cursor: pointer;
}
.console-entry:hover { background: rgba(255,255,255,0.03); }
.console-entry.level-error { background: rgba(255,0,0,0.08); border-left: 2px solid #ff4444; }
.console-entry.level-warn { background: rgba(255,170,0,0.05); border-left: 2px solid #ffaa00; }
.console-time { color: #444; white-space: nowrap; min-width: 80px; }
.console-cat-icon { font-size: 11px; min-width: 14px; }
.console-level-badge { padding: 0 3px; border-radius: 2px; font-size: 8px; font-weight: bold; white-space: nowrap; }
.badge-error { background: rgba(255,0,0,0.4); color: #ff4444; }
.badge-warn { background: rgba(255,170,0,0.3); color: #ffaa00; }
.badge-log { background: rgba(100,200,255,0.15); color: #88ccff; }
.badge-info { background: rgba(100,255,100,0.15); color: #88ff88; }
.console-tag { color: #cc88ff; white-space: nowrap; font-weight: bold; }
.console-text { color: #bbb; word-break: break-all; flex: 1; }

.console-detail-bar {
  border-top: 1px solid rgba(255,50,50,0.2); max-height: 200px; overflow-y: auto;
  background: rgba(0,0,0,0.4);
}
.detail-bar-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; font-size: 11px; color: #888; }
.detail-bar-content { padding: 6px 8px; font-size: 10px; color: #aaa; white-space: pre-wrap; word-break: break-all; font-family: monospace; margin: 0; }

.empty-hint { color: #444; text-align: center; padding: 20px; font-size: 12px; }

.debug-footer {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-top: 1px solid rgba(255,50,50,0.15); background: rgba(0,0,0,0.3);
  flex-wrap: wrap;
}
.action-btn.small {
  padding: 4px 10px; border: 1px solid rgba(255,255,255,0.1);
  border-radius: 4px; background: rgba(255,255,255,0.04);
  color: #999; cursor: pointer; font-size: 11px; transition: all 0.15s;
}
.action-btn.small:hover { background: rgba(255,255,255,0.08); color: #ddd; }
.action-btn.small:disabled { opacity: 0.3; cursor: default; }
.action-btn.small.terminate { border-color: rgba(255,50,50,0.4); }
.action-btn.small.terminate:hover { background: rgba(255,30,30,0.2); color: #ff4444; }
.action-btn.small.export { border-color: rgba(100,200,255,0.3); }
.action-btn.small.export:hover { background: rgba(100,200,255,0.1); color: #88ccff; }
.action-btn.small.replay { border-color: rgba(100,255,100,0.3); }
.action-btn.small.replay:hover { background: rgba(100,255,100,0.1); color: #88ff88; }
.footer-stats { font-size: 10px; color: #555; margin-left: auto; }
.replay-status { font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(100,100,100,0.3); color: #aaa; }
.replay-status.success { background: rgba(0,80,0,0.3); color: #88ff88; }
.replay-status.error { background: rgba(80,0,0,0.3); color: #ff8888; }

:root[data-theme="light"] .debug-page { background: #f0f0f5; }
:root[data-theme="light"] .debug-page-overlay { background: rgba(240,240,245,0.9); }
:root[data-theme="light"] .debug-page-header { background: rgba(255,20,20,0.05); }
:root[data-theme="light"] .debug-title { color: #cc3333; }
:root[data-theme="light"] .console-filter { background: #fff; color: #333; border-color: #ccc; }
:root[data-theme="light"] .console-cat-select, :root[data-theme="light"] .console-level-select { background: #fff; color: #333; border-color: #ccc; }
:root[data-theme="light"] .console-entry { color: #333; }
:root[data-theme="light"] .console-text { color: #333; }
:root[data-theme="light"] .console-time { color: #999; }
</style>
