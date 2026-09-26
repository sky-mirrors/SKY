<template>
  <div class="debug-window-page">
    <div class="debug-titlebar">
      <span class="titlebar-icon">🔍</span>
      <span class="titlebar-text">调试监视器</span>
      <div class="titlebar-stats">
        探针{{ debugStore.activeProbes.length }} | 异常{{ debugStore.errorProbes.length }} | 日志{{ debugStore.consoleLogs.length }}
      </div>
      <div v-if="debugStore.frozen" class="freeze-indicator" @click="onUnfreeze" title="探针已冻结（错误上下文保留中），点击解冻">
        ❄️ 冻结中 ({{ debugStore.activeProbes.length }}/500)
      </div>
      <div class="titlebar-actions">
        <button class="tb-btn pin-btn" :class="{ pinned: isPinned }" @click="onTogglePin" :title="isPinned ? '取消置顶' : '置顶'">{{ isPinned ? '📌' : '🔓' }}</button>
        <button class="tb-btn" @click="onMinimize">—</button>
        <button class="tb-btn" @click="onMaximize">☐</button>
        <button class="tb-btn tb-close" @click="onClose">✕</button>
      </div>
    </div>

    <div class="debug-split">
      <div class="debug-left">
        <div class="panel-title">执行流程</div>
        <div class="time-travel-bar" v-if="debugStore.activeProbes.length > 1">
          <input type="range" class="time-slider" :min="-1" :max="debugStore.activeProbes.length - 1" v-model.number="timeTravelIdx" />
          <span class="time-label">{{ timeTravelIdx < 0 ? '全部' : `步骤 ${timeTravelIdx + 1}` }} / {{ debugStore.activeProbes.length }}</span>
          <button v-if="timeTravelIdx >= 0" class="tb-btn" @click="timeTravelIdx = -1" title="重置">↺</button>
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
        <div class="mech-stats-section">
          <div class="panel-title">运行统计</div>
          <template v-if="debugStore.mechanismStats.cache">
            <div class="ms-row"><span class="ms-k">语义缓存</span><span class="ms-v">{{ debugStore.mechanismStats.cache.size }} 条 · 命中 {{ (debugStore.mechanismStats.cache.savings.hitRate * 100).toFixed(0) }}% · 省 {{ debugStore.mechanismStats.cache.savings.semanticCacheSavedTokens }} tok</span></div>
            <div class="ms-row"><span class="ms-k">路由</span><span class="ms-v">{{ debugStore.mechanismStats.routing?.efficiency.totalEntries ?? 0 }} 样本 · 过度路由 {{ ((debugStore.mechanismStats.routing?.efficiency.overkillRate ?? 0) * 100).toFixed(0) }}%</span></div>
            <div class="ms-row"><span class="ms-k">预算</span><span class="ms-v">{{ debugStore.mechanismStats.budget?.mode }} · 今日 ¥{{ (debugStore.mechanismStats.budget?.daily ?? 0).toFixed(4) }} · 月 ¥{{ (debugStore.mechanismStats.budget?.monthly ?? 0).toFixed(4) }}</span></div>
            <div class="ms-row"><span class="ms-k">约束</span><span class="ms-v">激活 {{ debugStore.mechanismStats.constraints?.active ?? 0 }} / {{ debugStore.mechanismStats.constraints?.total ?? 0 }}</span></div>
          </template>
          <div v-else class="empty-hint">加载中…</div>
        </div>
        <div class="feedback-audit-section">
          <div class="panel-title">约束反馈自治</div>
          <div class="fa-hint">≥10 样本 · 误报率&gt;30% 自动禁用 / &gt;20% 自动降级</div>
          <div v-if="debugStore.constraintFeedbackStats.length === 0" class="empty-hint">暂无约束反馈</div>
          <div v-else class="fa-list">
            <div v-for="s in debugStore.constraintFeedbackStats" :key="s.constraintId"
                 class="fa-row"
                 :title="`累计评估 ${s.totalEvaluations} 次（窗口 ${s.recentEvaluations}）· 累计误报率 ${(s.falsePositiveRate * 100).toFixed(1)}% · 状态 ${s.status}`">
              <span class="fa-id">{{ s.constraintId }}</span>
              <span class="fa-rate" :class="{ 'fa-warn': s.recentFalsePositiveRate > 0.2, 'fa-danger': s.recentFalsePositiveRate > 0.3 }">{{ (s.recentFalsePositiveRate * 100).toFixed(1) }}%</span>
              <span class="fa-autonomy" :class="`fa-auto-${s.autonomy}`">{{ autonomyLabel(s.autonomy) }}</span>
            </div>
          </div>
        </div>
        <div v-if="debugStore.selectedProbe" class="probe-detail">
          <div class="detail-grid">
            <div class="detail-cell"><span class="dk">来源</span><span class="dv" :class="`source-tag-${debugStore.selectedProbe.source}`">{{ sourceLabel(debugStore.selectedProbe.source) }}</span></div>
            <div v-if="debugStore.selectedProbe.modelTier" class="detail-cell"><span class="dk">Tier</span><span class="dv tier-tag">{{ debugStore.selectedProbe.modelTier }}</span></div>
            <div v-if="debugStore.selectedProbe.ruleId" class="detail-cell"><span class="dk">规则</span><span class="dv rule-tag">{{ debugStore.selectedProbe.ruleId }}</span></div>
            <div v-if="debugStore.selectedProbe.cacheFingerprint" class="detail-cell"><span class="dk">指纹</span><span class="dv mono">{{ debugStore.selectedProbe.cacheFingerprint.substring(0, 24) }}</span></div>
            <div v-if="debugStore.selectedProbe.tokenUsage" class="detail-cell"><span class="dk">Tokens</span><span class="dv mono">{{ debugStore.selectedProbe.tokenUsage.totalTokens }} (¥{{ debugStore.selectedProbe.tokenUsage.estimatedCostCny.toFixed(4) }})</span></div>
          </div>
          <div class="detail-section">
            <div class="detail-sublabel" @click="inputExpanded = !inputExpanded">输入 {{ inputExpanded ? '▼' : '▶' }}</div>
            <pre v-if="inputExpanded" class="detail-json">{{ formatJson(debugStore.selectedProbe.inputSnapshot) }}</pre>
          </div>
          <div class="detail-section">
            <div class="detail-sublabel" @click="outputExpanded = !outputExpanded">输出 {{ outputExpanded ? '▼' : '▶' }}</div>
            <pre v-if="outputExpanded" class="detail-json">{{ formatOutput(debugStore.selectedProbe.outputSnapshot) }}</pre>
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
      <button class="action-btn small replay" @click="onReplay" :disabled="!debugStore.selectedProbe || debugStore.selectedProbe.manifestId.startsWith('pipeline-') || replayStatus === 'replaying'">重放探针</button>
      <button class="action-btn small" @click="onResetAutoCompile">重置自编译</button>
      <div class="footer-stats">
        Tokens {{ debugStore.totalTokenUsage.totalTokens }} | 成本 ¥{{ debugStore.totalTokenUsage.estimatedCostCny.toFixed(4) }}
      </div>
      <div v-if="replayStatus !== 'idle'" class="replay-status" :class="{ success: replayStatus === 'success', error: replayStatus === 'error' }">{{ replayMessage }}</div>
      <div v-if="footerMsg" class="replay-status" :class="{ success: footerMsg.includes('成功') }">{{ footerMsg }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useDebugStore } from '@/domains/debug'
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
const isPinned = ref(true)

debugStore.activate()

watch(timeTravelIdx, (idx) => {
  if (idx >= 0 && idx < debugStore.activeProbes.length) {
    debugStore.selectProbe(debugStore.activeProbes[idx].id)
  }
})

const categories: ConsoleCategory[] = ['system', 'raap', 'llm', 'shell', 'cache', 'rule', 'dialog', 'feedback', 'factguard', 'tool', 'schedule']

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

function formatOutput(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function onEntryClick(entry: ConsoleLogEntry) {
  selectedDetail.value = entry.detail || entry.text
}

function barWidth(ms: number): number {
  const maxMs = Math.max(...debugStore.activeProbes.map(p => p.durationMs), 1)
  return Math.max(2, (ms / maxMs) * 100)
}

async function onExport() {
  const path = await debugStore.exportDebugPackage()
  if (path) footerMsg.value = `调试包已导出: ${path}`
  setTimeout(() => { footerMsg.value = '' }, 5000)
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

async function onResetAutoCompile() {
  try {
    const { resetManifestStats } = await import('@/services/scheduleOptimizer')
    resetManifestStats()
    footerMsg.value = '自编译统计已重置'
  } catch (e) { footerMsg.value = (e as Error).message }
  setTimeout(() => { footerMsg.value = '' }, 5000)
}

function onMinimize() { window.electronAPI?.debugWindowMinimize() }
function onMaximize() { window.electronAPI?.debugWindowMaximize() }
function onClose() { window.electronAPI?.debugWindowClose() }
function onTogglePin() {
  isPinned.value = !isPinned.value
  window.electronAPI?.debugToggleFloat(isPinned.value)
}
function onUnfreeze() {
  debugStore.unfreezeBuffer()
}

/** 自治动作的中文短标签（审计面板） */
function autonomyLabel(a: 'none' | 'disable' | 'downgrade'): string {
  return a === 'disable' ? '禁用' : a === 'downgrade' ? '降级' : '—'
}

</script>

<style scoped>
.debug-window-page {
  width: 100%; height: 100vh;
  background: #0a0c14; display: flex; flex-direction: column; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #ccc;
}
.debug-titlebar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-bottom: 1px solid rgba(255, 50, 50, 0.2);
  background: rgba(255, 20, 20, 0.05); -webkit-app-region: drag; user-select: none;
}
.titlebar-icon { font-size: 13px; }
.titlebar-text { font-size: 13px; font-weight: 700; color: #ff6666; letter-spacing: 1px; }
.titlebar-stats { font-size: 10px; color: #555; flex: 1; text-align: center; }
.freeze-indicator {
  font-size: 10px; color: #88ccff; background: rgba(100, 180, 255, 0.12);
  padding: 1px 8px; border-radius: 3px; cursor: pointer;
  border: 1px solid rgba(100, 180, 255, 0.3); white-space: nowrap;
  animation: freeze-pulse 2s ease-in-out infinite; -webkit-app-region: no-drag;
}
.freeze-indicator:hover { background: rgba(100, 180, 255, 0.25); color: #aaddff; }
@keyframes freeze-pulse {
  0%, 100% { border-color: rgba(100, 180, 255, 0.3); }
  50% { border-color: rgba(100, 180, 255, 0.7); }
}
.titlebar-actions { display: flex; gap: 2px; -webkit-app-region: no-drag; }
.tb-btn {
  width: 24px; height: 24px; border: none; border-radius: 3px;
  background: transparent; color: #888; cursor: pointer; font-size: 12px;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.tb-btn:hover { background: rgba(255,255,255,0.1); color: #ddd; }
.tb-close:hover { background: rgba(255,30,30,0.5); color: #fff; }
.pin-btn.pinned { color: #ff6666; background: rgba(255,60,60,0.15); box-shadow: 0 0 8px rgba(255,60,60,0.3); }

.debug-split { flex: 1; display: flex; overflow: hidden; }
.debug-left { width: 240px; min-width: 160px; border-right: 1px solid rgba(255, 50, 50, 0.15); display: flex; flex-direction: column; overflow: hidden; }
.debug-right { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.panel-title { font-size: 10px; color: #ff6666; font-weight: bold; padding: 5px 10px; border-bottom: 1px solid rgba(255, 50, 50, 0.1); background: rgba(0,0,0,0.3); text-transform: uppercase; letter-spacing: 1px; }

.probes-list { flex: 1; overflow-y: auto; padding: 3px; }
.probe-item { display: flex; align-items: center; gap: 3px; padding: 3px 5px; border-radius: 3px; cursor: pointer; margin-bottom: 1px; font-size: 10px; }
.probe-item:hover { background: rgba(255, 255, 255, 0.05); }
.probe-item.selected { background: rgba(255, 50, 50, 0.15); border: 1px solid rgba(255, 50, 50, 0.3); }
.probe-item.dimmed { opacity: 0.25; }

.time-travel-bar { padding: 3px 6px; border-bottom: 1px solid rgba(255,50,50,0.1); display: flex; align-items: center; gap: 4px; }
.time-slider { flex: 1; height: 3px; -webkit-appearance: none; background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; }
.time-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #ff6666; cursor: pointer; }
.time-label { font-size: 9px; color: #888; white-space: nowrap; }
.probe-source-icon { font-size: 10px; }
.probe-step { font-weight: bold; color: #888; min-width: 20px; }
.probe-tool { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-duration { color: #555; font-size: 9px; }
.probe-source-label { color: #666; font-size: 9px; }
.source-error { border-left: 2px solid #ff4444; }
.source-llm { border-left: 2px solid #6688ff; }
.source-rule { border-left: 2px solid #44ff88; }
.source-cache { border-left: 2px solid #ffaa44; }

/* 运行统计（2026-09-26 机制体检 Wave1「上屏」：把未上屏的机制 getter 聚合展示） */
.mech-stats-section { border-top: 1px solid rgba(255,50,50,0.15); padding: 6px; }
.ms-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; padding: 2px 0; }
.ms-k { color: #7a90a8; flex: none; }
.ms-v { color: #c0d8f0; font-family: monospace; text-align: right; }

/* 约束反馈自治审计面板（2026-09-25 机制体检） */
.feedback-audit-section { border-top: 1px solid rgba(255,50,50,0.15); padding: 6px; max-height: 160px; overflow-y: auto; }
.fa-hint { font-size: 9px; color: #666; padding: 0 2px 4px; }
.fa-list { display: flex; flex-direction: column; gap: 2px; }
.fa-row { display: flex; align-items: center; gap: 4px; padding: 2px 4px; background: rgba(0,0,0,0.3); border-radius: 3px; font-size: 10px; }
.fa-id { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 9px; }
.fa-rate { font-family: monospace; font-size: 9px; color: #888; min-width: 38px; text-align: right; }
.fa-warn { color: #ffaa44; }
.fa-danger { color: #ff5555; font-weight: bold; }
.fa-autonomy { font-size: 9px; min-width: 28px; text-align: center; }
.fa-auto-none { color: #555; }
.fa-auto-downgrade { color: #ffaa44; }
.fa-auto-disable { color: #ff5555; font-weight: bold; }

.probe-detail { border-top: 1px solid rgba(255, 50, 50, 0.15); padding: 6px; overflow-y: auto; max-height: 250px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 6px; }
.detail-cell { display: flex; justify-content: space-between; padding: 2px 5px; background: rgba(0,0,0,0.3); border-radius: 3px; }
.dk { color: #666; font-size: 10px; }
.dv { color: #ccc; font-size: 10px; }
.dv.mono { font-family: monospace; font-size: 9px; }
.source-tag-rule { color: #44ff88; }
.source-tag-cache { color: #ffaa44; }
.source-tag-llm { color: #6688ff; }
.source-tag-error { color: #ff4444; }
.tier-tag { color: #cc88ff; }
.rule-tag { color: #44ff88; }

.profiler-section { border-top: 1px solid rgba(255,50,50,0.15); padding: 6px; }
.profiler-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 6px; }
.profiler-stat { display: flex; justify-content: space-between; padding: 2px 5px; background: rgba(0,0,0,0.3); border-radius: 3px; font-size: 10px; }
.profiler-stat span:first-child { color: #666; }
.profiler-stat span:last-child { color: #ccc; font-family: monospace; }

.waterfall { font-size: 9px; }
.waterfall-row { display: flex; align-items: center; gap: 3px; padding: 1px 0; }
.wf-step { color: #888; min-width: 20px; font-weight: bold; }
.wf-bar-container { flex: 1; height: 6px; background: rgba(255,255,255,0.05); border-radius: 2px; overflow: hidden; }
.wf-bar { height: 100%; border-radius: 2px; transition: width 0.3s; }
.bar-llm { background: linear-gradient(90deg, #6688ff, #88aaff); }
.bar-shell { background: linear-gradient(90deg, #44ff88, #88ffbb); }
.bar-rule { background: linear-gradient(90deg, #ffaa44, #ffcc88); }
.bar-cache { background: linear-gradient(90deg, #ff8844, #ffaa88); }
.bar-error { background: linear-gradient(90deg, #ff4444, #ff8888); }
.bar-tool, .bar-mcp, .bar-read_file, .bar-knowledge { background: linear-gradient(90deg, #88aacc, #aaccdd); }
.wf-ms { color: #888; min-width: 35px; text-align: right; }
.wf-cost { color: #ffaa44; min-width: 40px; text-align: right; }
.detail-section { margin-top: 3px; }
.detail-sublabel { font-size: 10px; color: #666; cursor: pointer; user-select: none; padding: 1px 0; }
.detail-sublabel:hover { color: #aaa; }
.error-label { color: #ff6666; }
.detail-json { background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 5px; font-size: 9px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 2px; font-family: 'Consolas', 'Monaco', monospace; color: #aaa; }
.error-text { color: #ff4444; border-color: rgba(255, 50, 50, 0.3); }

.console-toolbar { display: flex; gap: 3px; padding: 3px 6px; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); }
.console-filter { flex: 1; padding: 3px 6px; border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; background: rgba(0,0,0,0.4); color: #ccc; font-size: 10px; outline: none; }
.console-filter::placeholder { color: #444; }
.console-filter:focus { border-color: rgba(100, 200, 255, 0.5); }
.console-cat-select, .console-level-select { padding: 3px 4px; border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; background: rgba(0,0,0,0.4); color: #ccc; font-size: 10px; outline: none; }
.console-cat-select option, .console-level-select option { background: #0a0c14; }

.console-list { flex: 1; overflow-y: auto; padding: 3px; font-family: 'Consolas', 'Monaco', monospace; font-size: 10px; }
.console-entry { display: flex; align-items: flex-start; gap: 3px; padding: 2px 3px; border-bottom: 1px solid rgba(255,255,255,0.02); line-height: 1.3; cursor: pointer; }
.console-entry:hover { background: rgba(255,255,255,0.03); }
.console-entry.level-error { background: rgba(255,0,0,0.08); border-left: 2px solid #ff4444; }
.console-entry.level-warn { background: rgba(255,170,0,0.05); border-left: 2px solid #ffaa00; }
.console-time { color: #444; white-space: nowrap; min-width: 72px; }
.console-cat-icon { font-size: 10px; min-width: 12px; }
.console-level-badge { padding: 0 2px; border-radius: 2px; font-size: 7px; font-weight: bold; white-space: nowrap; }
.badge-error { background: rgba(255,0,0,0.4); color: #ff4444; }
.badge-warn { background: rgba(255,170,0,0.3); color: #ffaa00; }
.badge-log { background: rgba(100,200,255,0.15); color: #88ccff; }
.badge-info { background: rgba(100,255,100,0.15); color: #88ff88; }
.console-tag { color: #cc88ff; white-space: nowrap; font-weight: bold; }
.console-text { color: #bbb; word-break: break-all; flex: 1; }

.console-detail-bar { border-top: 1px solid rgba(255,50,50,0.2); max-height: 150px; overflow-y: auto; background: rgba(0,0,0,0.4); }
.detail-bar-header { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px; font-size: 10px; color: #888; }
.detail-bar-content { padding: 4px 6px; font-size: 9px; color: #aaa; white-space: pre-wrap; word-break: break-all; font-family: monospace; margin: 0; }

.empty-hint { color: #444; text-align: center; padding: 15px; font-size: 11px; }

.debug-footer { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-top: 1px solid rgba(255,50,50,0.15); background: rgba(0,0,0,0.3); flex-wrap: wrap; }
.action-btn.small { padding: 3px 8px; border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; background: rgba(255,255,255,0.04); color: #999; cursor: pointer; font-size: 10px; transition: all 0.15s; }
.action-btn.small:hover { background: rgba(255,255,255,0.08); color: #ddd; }
.action-btn.small:disabled { opacity: 0.3; cursor: default; }
.action-btn.small.terminate { border-color: rgba(255,50,50,0.4); }
.action-btn.small.terminate:hover { background: rgba(255,30,30,0.2); color: #ff4444; }
.action-btn.small.export { border-color: rgba(100,200,255,0.3); }
.action-btn.small.export:hover { background: rgba(100,200,255,0.1); color: #88ccff; }
.action-btn.small.replay { border-color: rgba(100,255,100,0.3); }
.action-btn.small.replay:hover { background: rgba(100,255,100,0.1); color: #88ff88; }
.footer-stats { font-size: 9px; color: #555; margin-left: auto; }
.replay-status { font-size: 9px; padding: 1px 6px; border-radius: 3px; background: rgba(100,100,100,0.3); color: #aaa; }
.replay-status.success { background: rgba(0,80,0,0.3); color: #88ff88; }
.replay-status.error { background: rgba(80,0,0,0.3); color: #ff8888; }

.dbg-btn { padding: 3px 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; background: rgba(255,255,255,0.05); color: #aaa; cursor: pointer; font-size: 10px; transition: all 0.15s; }
.dbg-btn:hover { background: rgba(255,255,255,0.12); color: #ddd; }
.dbg-btn.active { background: rgba(100, 200, 255, 0.2); color: #88ccff; border-color: rgba(100, 200, 255, 0.4); }
</style>
