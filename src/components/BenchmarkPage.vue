<template>
  <div class="benchmark-page">
    <div class="bm-titlebar">
      <span class="titlebar-icon">📊</span>
      <span class="titlebar-text">Token优化压测台</span>
      <div class="titlebar-model">模型: {{ apiStore.config.activeModel || '未配置' }}</div>
      <div class="titlebar-actions">
        <button class="tb-btn" @click="onMinimize">—</button>
        <button class="tb-btn" @click="onMaximize">☐</button>
        <button class="tb-btn tb-close" @click="onClose">✕</button>
      </div>
    </div>

    <div class="bm-body">
      <div v-if="!apiStore.isReady" class="bm-warning">
        <div class="warn-icon">⚠️</div>
        <div class="warn-text">API未配置或不可用。请先在主窗口配置DeepSeek模型网关。</div>
      </div>

      <div class="bm-controls" v-if="apiStore.isReady">
        <div class="control-row">
          <label class="ctrl-label">请求间隔(ms)</label>
          <input type="number" class="ctrl-input" v-model.number="sleepMs" min="500" max="30000" step="500" />
        </div>
        <div class="control-row">
          <label class="ctrl-label">测试用例数</label>
          <span class="ctrl-value">{{ totalCases }}</span>
        </div>
        <div class="control-row" v-if="progress.phase === 'idle'">
          <button class="bm-btn run" @click="onRun">🚀 开始压测</button>
        </div>
        <div class="control-row" v-if="progress.phase !== 'idle' && progress.phase !== 'done' && progress.phase !== 'error'">
          <button class="bm-btn cancel" @click="onCancel">⏹ 取消</button>
        </div>
        <div class="control-row" v-if="progress.phase === 'done' && progress.report">
          <button class="bm-btn export" @click="onExport">💾 导出报告</button>
        </div>
      </div>

      <div class="bm-progress" v-if="progress.phase !== 'idle'">
        <div class="phase-label" :class="`phase-${progress.phase}`">
          {{ phaseLabel }}
        </div>
        <div class="progress-bar-container" v-if="progress.phase === 'baseline' || progress.phase === 'optimized'">
          <div class="progress-bar" :style="{ width: progressPercent + '%' }"></div>
        </div>
        <div class="progress-detail" v-if="progress.currentLabel">
          {{ progress.currentCase }}/{{ progress.totalCases }} — {{ progress.currentLabel }}
        </div>
        <div class="error-msg" v-if="progress.phase === 'error'">
          ❌ {{ progress.errorMessage }}
        </div>
      </div>

      <div class="bm-results" v-if="progress.baselineStats || progress.optimizedStats">
        <table class="results-table">
          <thead>
            <tr>
              <th>指标</th>
              <th>基线(无优化)</th>
              <th>优化后</th>
              <th>节省</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>LLM调用次数</td>
              <td>{{ progress.baselineStats?.llmCalls ?? '-' }}</td>
              <td>{{ progress.optimizedStats?.llmCalls ?? '-' }}</td>
              <td :class="savingsClass('llmCalls')">{{ savingsPercent('llmCalls') }}</td>
            </tr>
            <tr>
              <td>总Token数</td>
              <td>{{ totalTokens(progress.baselineStats) }}</td>
              <td>{{ totalTokens(progress.optimizedStats) }}</td>
              <td :class="savingsClass('tokens')">{{ progress.report?.improvement.tokenSavedPercent ?? '-' }}</td>
            </tr>
            <tr>
              <td>总费用(¥)</td>
              <td>{{ (progress.baselineStats?.totalCostCNY ?? 0).toFixed(4) }}</td>
              <td>{{ (progress.optimizedStats?.totalCostCNY ?? 0).toFixed(4) }}</td>
              <td :class="savingsClass('cost')">{{ progress.report?.improvement.costSavedPercent ?? '-' }}</td>
            </tr>
            <tr>
              <td>平均延迟(ms)</td>
              <td>{{ avgLatency(progress.baselineStats) }}</td>
              <td>{{ avgLatency(progress.optimizedStats) }}</td>
              <td :class="savingsClass('latency')">{{ progress.report?.improvement.latencySavedPercent ?? '-' }}</td>
            </tr>
            <tr>
              <td>缓存命中数</td>
              <td>{{ progress.baselineStats?.cacheHits ?? 0 }}</td>
              <td>{{ progress.optimizedStats?.cacheHits ?? 0 }}</td>
              <td>-</td>
            </tr>
            <tr>
              <td>L0命中数</td>
              <td>-</td>
              <td>{{ progress.optimizedStats?.l0Hits ?? 0 }}</td>
              <td>{{ progress.report?.improvement.l0HitRate ?? '-' }}</td>
            </tr>
            <tr>
              <td>L0.5命中数</td>
              <td>-</td>
              <td>{{ progress.optimizedStats?.l05Hits ?? 0 }}</td>
              <td>{{ progress.report?.improvement.l05HitRate ?? '-' }}</td>
            </tr>
            <tr>
              <td>指纹缓存命中</td>
              <td>-</td>
              <td>{{ progress.optimizedStats?.fingerprintHits ?? 0 }}</td>
              <td>{{ progress.report?.improvement.fingerprintHitRate ?? '-' }}</td>
            </tr>
            <tr>
              <td>总请求错误</td>
              <td>{{ progress.baselineStats?.errors ?? 0 }}</td>
              <td>{{ progress.optimizedStats?.errors ?? 0 }}</td>
              <td>-</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="bm-log" v-if="logLines.length > 0">
        <div class="panel-title">执行日志</div>
        <div class="log-list">
          <div v-for="(line, idx) in logLines" :key="idx" class="log-line" :class="`log-${line.level}`">{{ line.text }}</div>
        </div>
      </div>
    </div>

    <div class="bm-footer">
      <span class="footer-note">DeepSeek V4 Flash | ¥1.0/1M input | ¥0.02/1M cached | ¥2.0/1M output</span>
      <span v-if="exportPath" class="footer-export">📄 {{ exportPath }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { useApiStore } from '@/stores/apiStore'
import { createBenchmarkRunner, type BenchmarkProgress } from '@/benchmark/benchmarkRunner'
import { getTestCases } from '@/benchmark/testCases'
import { debugLog } from '@/services/debugLog'
import type { BenchmarkStats } from '@/benchmark/statsTracker'

const apiStore = useApiStore()
const runner = createBenchmarkRunner()
const progress = reactive(runner.progress) as BenchmarkProgress

const sleepMs = ref(2000)
const exportPath = ref<string | null>(null)
const logLines = ref<{ level: 'info' | 'warn' | 'error'; text: string }[]>([])

const totalCases = computed(() => getTestCases().length)

const phaseLabel = computed(() => {
  switch (progress.phase) {
    case 'baseline': return '🔄 基线测试 (无优化)'
    case 'optimized': return '⚡ 优化测试 (L0/L0.5/缓存/级联)'
    case 'report': return '📊 生成报告...'
    case 'done': return '✅ 压测完成'
    case 'error': return '❌ 错误'
    default: return ''
  }
})

const progressPercent = computed(() => {
  if (progress.totalCases === 0) return 0
  return Math.round((progress.currentCase / progress.totalCases) * 100)
})

function totalTokens(stats: BenchmarkStats | null): string {
  if (!stats) return '-'
  return String(stats.totalInputTokens + stats.totalOutputTokens)
}

function avgLatency(stats: BenchmarkStats | null): string {
  if (!stats || stats.totalRequests === 0) return '-'
  return Math.round(stats.totalLatencyMs / stats.totalRequests) + 'ms'
}

function savingsClass(type: 'llmCalls' | 'tokens' | 'cost' | 'latency'): string {
  if (!progress.baselineStats || !progress.optimizedStats) return ''
  if (type === 'llmCalls') {
    if (!progress.baselineStats.llmCalls) return ''
    const pct = ((progress.baselineStats.llmCalls - progress.optimizedStats.llmCalls) / progress.baselineStats.llmCalls) * 100
    return pct > 0 ? 'savings-good' : 'savings-bad'
  }
  return ''
}

function savingsPercent(type: 'llmCalls'): string {
  if (!progress.baselineStats || !progress.optimizedStats) return '-'
  if (!progress.baselineStats[type]) return '-'
  const pct = ((progress.baselineStats[type] - progress.optimizedStats[type]) / progress.baselineStats[type]) * 100
  return pct.toFixed(1) + '%'
}

const origConsoleLog = console.log
const origConsoleWarn = console.warn
const origConsoleError = console.error

function installLogCapture(): void {
  console.log = (...args: unknown[]) => {
    origConsoleLog(...args)
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (text.startsWith('[Benchmark]')) {
      logLines.value.push({ level: 'info', text })
      if (logLines.value.length > 200) logLines.value.splice(0, logLines.value.length - 200)
    }
  }
  console.warn = (...args: unknown[]) => {
    origConsoleWarn(...args)
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (text.startsWith('[Benchmark]')) {
      logLines.value.push({ level: 'warn', text })
      if (logLines.value.length > 200) logLines.value.splice(0, logLines.value.length - 200)
    }
  }
  console.error = (...args: unknown[]) => {
    origConsoleError(...args)
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (text.startsWith('[Benchmark]')) {
      logLines.value.push({ level: 'error', text })
      if (logLines.value.length > 200) logLines.value.splice(0, logLines.value.length - 200)
    }
  }
}

function restoreLogCapture(): void {
  console.log = origConsoleLog
  console.warn = origConsoleWarn
  console.error = origConsoleError
}

async function onRun(): Promise<void> {
  logLines.value = []
  exportPath.value = null
  installLogCapture()
  try {
    await runner.run(sleepMs.value)
  } finally {
    restoreLogCapture()
  }
}

function onCancel(): void {
  runner.cancel()
}

async function onExport(): Promise<string | null> {
  const path = await runner.exportReport()
  exportPath.value = path
  return path
}

function onMinimize(): void { window.electronAPI?.benchmarkWindowMinimize() }
function onMaximize(): void { window.electronAPI?.benchmarkWindowMaximize() }
function onClose(): void { window.electronAPI?.benchmarkWindowClose() }
</script>

<style scoped>
.benchmark-page {
  width: 100%; height: 100vh;
  background: #0a0c14; display: flex; flex-direction: column; overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #ccc;
}
.bm-titlebar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-bottom: 1px solid rgba(100, 200, 255, 0.2);
  background: rgba(50, 120, 200, 0.05); -webkit-app-region: drag; user-select: none;
}
.titlebar-icon { font-size: 13px; }
.titlebar-text { font-size: 13px; font-weight: 700; color: #66bbff; letter-spacing: 1px; }
.titlebar-model { font-size: 10px; color: #555; flex: 1; text-align: center; }
.titlebar-actions { display: flex; gap: 2px; -webkit-app-region: no-drag; }
.tb-btn {
  width: 24px; height: 24px; border: none; border-radius: 3px;
  background: transparent; color: #888; cursor: pointer; font-size: 12px;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.tb-btn:hover { background: rgba(255,255,255,0.1); color: #ddd; }
.tb-close:hover { background: rgba(255,30,30,0.5); color: #fff; }

.bm-body { flex: 1; overflow-y: auto; padding: 12px; }

.bm-warning {
  background: rgba(255, 170, 0, 0.1); border: 1px solid rgba(255, 170, 0, 0.3);
  border-radius: 6px; padding: 16px; display: flex; align-items: center; gap: 12px;
}
.warn-icon { font-size: 24px; }
.warn-text { color: #ffaa44; font-size: 13px; }

.bm-controls {
  background: rgba(0,0,0,0.3); border: 1px solid rgba(100,200,255,0.15);
  border-radius: 6px; padding: 12px; margin-bottom: 12px;
}
.control-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ctrl-label { font-size: 11px; color: #888; min-width: 100px; }
.ctrl-input {
  padding: 4px 8px; border: 1px solid rgba(255,255,255,0.12); border-radius: 3px;
  background: rgba(0,0,0,0.4); color: #ccc; font-size: 11px; width: 100px; outline: none;
}
.ctrl-input:focus { border-color: rgba(100, 200, 255, 0.5); }
.ctrl-value { font-size: 11px; color: #ccc; font-family: monospace; }

.bm-btn {
  padding: 6px 16px; border: 1px solid rgba(100,200,255,0.3); border-radius: 4px;
  background: rgba(50, 120, 200, 0.15); color: #88ccff; cursor: pointer;
  font-size: 12px; transition: all 0.2s;
}
.bm-btn:hover { background: rgba(50, 120, 200, 0.3); border-color: rgba(100,200,255,0.5); }
.bm-btn.run { border-color: rgba(100, 255, 100, 0.3); color: #88ff88; background: rgba(50, 200, 100, 0.1); }
.bm-btn.run:hover { background: rgba(50, 200, 100, 0.2); border-color: rgba(100, 255, 100, 0.5); }
.bm-btn.cancel { border-color: rgba(255, 100, 100, 0.3); color: #ff8888; background: rgba(200, 50, 50, 0.1); }
.bm-btn.cancel:hover { background: rgba(200, 50, 50, 0.2); }
.bm-btn.export { border-color: rgba(255, 200, 50, 0.3); color: #ffcc66; background: rgba(200, 150, 50, 0.1); }
.bm-btn.export:hover { background: rgba(200, 150, 50, 0.2); }

.bm-progress { margin-bottom: 12px; }
.phase-label { font-size: 13px; font-weight: bold; margin-bottom: 6px; }
.phase-baseline { color: #ff8888; }
.phase-optimized { color: #88ff88; }
.phase-report { color: #ffcc66; }
.phase-done { color: #88ccff; }
.phase-error { color: #ff4444; }

.progress-bar-container {
  height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; margin-bottom: 4px;
}
.progress-bar {
  height: 100%; background: linear-gradient(90deg, #4488ff, #88ccff); border-radius: 3px;
  transition: width 0.3s;
}
.progress-detail { font-size: 10px; color: #888; }
.error-msg { font-size: 11px; color: #ff6666; background: rgba(255,0,0,0.08); padding: 6px; border-radius: 3px; margin-top: 6px; }

.bm-results { margin-bottom: 12px; }
.results-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.results-table th {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(100,200,255,0.2);
  color: #66bbff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
}
.results-table td {
  padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.04);
  font-family: 'Consolas', 'Monaco', monospace;
}
.results-table tr:hover td { background: rgba(255,255,255,0.02); }
.savings-good { color: #88ff88; }
.savings-bad { color: #ff8888; }

.bm-log { margin-top: 8px; }
.panel-title { font-size: 10px; color: #66bbff; font-weight: bold; padding: 5px 0; border-bottom: 1px solid rgba(100,200,255,0.1); text-transform: uppercase; letter-spacing: 1px; }
.log-list {
  max-height: 200px; overflow-y: auto; font-family: 'Consolas', 'Monaco', monospace;
  font-size: 10px; padding: 4px 0;
}
.log-line { padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,0.02); line-height: 1.4; }
.log-info { color: #88ccff; }
.log-warn { color: #ffaa44; }
.log-error { color: #ff6666; }

.bm-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 12px; border-top: 1px solid rgba(100,200,255,0.15);
  background: rgba(0,0,0,0.3); font-size: 9px; color: #555;
}
.footer-export { color: #88ff88; }
</style>
