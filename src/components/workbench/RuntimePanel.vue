<template>
  <div class="wb-runtime">
    <!-- 区 1：路由与执行 -->
    <div class="wb-rt-section">
      <div class="wb-rt-title">路由与执行</div>
      <div class="wb-rt-card wb-rt-running" v-if="dialogStore.isProcessing">
        <span class="wb-rt-dot working"></span>执行中…
        <button
          class="wb-rt-terminate"
          :disabled="!debugStore.hasAbortable"
          :title="debugStore.hasAbortable ? '立即终止当前执行' : '当前阶段没有可中止的请求（路由/规划尚未进入可取消的执行）'"
          @click="debugStore.terminateExecution"
        >⏹ 终止</button>
      </div>
      <div class="wb-rt-card warn" v-if="dialogStore.awaitingConfirmation">
        <div class="wb-rt-card-head">⏸ 等待计划确认</div>
        <div class="wb-rt-card-body">
          意图：{{ dialogStore.pendingPlan?.intent || '—' }}（{{ dialogStore.pendingPlan?.steps.length ?? 0 }} 步）
        </div>
      </div>
      <div class="wb-rt-card warn" v-else-if="dialogStore.awaitingCandidatePick">
        <div class="wb-rt-card-head">⏸ 等待候选选择</div>
        <!-- P1-46：候选列表补可点击按钮（此前只显示数量，只能靠输入编号） -->
        <div class="wb-rt-card-body">
          <button
            v-for="(c, i) in dialogStore.pendingCandidateList"
            :key="c.manifestId"
            class="wb-rt-candidate-btn"
            :disabled="dialogStore.isProcessing"
            @click="dialogStore.pickCandidate(i)"
          >{{ i + 1 }}. {{ c.manifestName }}（{{ (c.score * 100).toFixed(0) }}%）</button>
          <div class="wb-rt-candidate-hint">点击候选，或在输入框回复编号</div>
        </div>
      </div>
      <div class="wb-rt-card warn" v-else-if="dialogStore.awaitingIntentConfirm">
        <div class="wb-rt-card-head">⏸ 等待意图确认</div>
        <div class="wb-rt-card-body">{{ dialogStore.translatedIntent?.intent || '—' }}</div>
      </div>
      <div class="wb-rt-card warn" v-else-if="dialogStore.awaitingSlotFill">
        <div class="wb-rt-card-head">⏸ 等待槽位填充</div>
        <div class="wb-rt-card-body">{{ dialogStore.slotClarification?.manifestName || '—' }}</div>
      </div>

      <div class="wb-rt-card" v-if="hotplugStore.lastRouted">
        <div class="wb-rt-card-head">
          最近路由
          <span class="wb-rt-tag" :class="hotplugStore.lastRouted.handled ? 'ok' : 'bad'">
            {{ hotplugStore.lastRouted.handled ? '接管' : '回退' }}
          </span>
        </div>
        <div class="wb-rt-card-body">
          <div>层：{{ hotplugStore.lastRouted.source || '—' }} → {{ hotplugStore.lastRouted.kind }}</div>
          <div v-if="hotplugStore.lastRouted.intent">意图：{{ hotplugStore.lastRouted.intent }}</div>
          <div class="wb-rt-time">{{ formatTime(hotplugStore.lastRouted.ts) }}</div>
        </div>
      </div>

      <div class="wb-rt-card" v-if="nodeStore.dagChainState.active">
        <div class="wb-rt-card-head">DAG 执行链</div>
        <div class="wb-rt-card-body">
          <div v-for="s in nodeStore.dagChainState.steps" :key="s.stepNum" class="wb-rt-dag-step">
            <span class="wb-rt-dot" :class="dagStatusClass(s.status)"></span>
            <span class="wb-rt-dag-node">{{ nodeName(s.nodeId) }}</span>
            <span class="wb-rt-dag-status">{{ dagStatusText(s.status) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 区 2：热插拔 -->
    <div class="wb-rt-section">
      <div class="wb-rt-title">热插拔</div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">内核</span>
        <span class="wb-rt-v">
          {{ hotplugStore.activeKernelId || '—' }}
          <span class="wb-rt-tag" :class="hotplugStore.kernelState === 'active' ? 'ok' : 'warn'">{{ hotplugStore.kernelState }}</span>
        </span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">在途/队列</span>
        <span class="wb-rt-v">{{ hotplugStore.kernelInFlight }} / {{ hotplugStore.kernelQueueLen }}</span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">Pack</span>
        <span class="wb-rt-v">
          {{ hotplugStore.mountedPackIds.length }}/{{ hotplugStore.allPackIds.length }}
          <span v-for="p in hotplugStore.mountedPackIds" :key="p" class="wb-rt-chip">{{ p }}</span>
        </span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">funnel 主路径</span>
        <span class="wb-rt-v">
          <span class="wb-rt-tag" :class="hotplugStore.funnelMainEnabled ? 'ok' : 'bad'">{{ hotplugStore.funnelMainEnabled ? '开启' : '已回滚' }}</span>
        </span>
      </div>
      <!-- A6：浸泡验证汇总（数据源 soakStore；未启用 shadow 时显示启用指引） -->
      <div class="wb-rt-card">
        <div class="wb-rt-card-head">
          浸泡验证
          <span class="wb-rt-tag" :class="soakStore.soakEnabled ? 'ok' : 'warn'">{{ soakStore.soakEnabled ? '启用' : '未启用' }}</span>
        </div>
        <div class="wb-rt-card-body" v-if="soakStore.soakEnabled">
          <div>样本 {{ soakStore.soakSummary.shadowTotal }}（一致 {{ (soakStore.soakSummary.matchRate * 100).toFixed(0) }}% / 不一致 {{ soakStore.soakSummary.mismatchCount }} / 待核对 {{ soakStore.soakSummary.manualReviewCount }}）</div>
          <div>funnel 接管 {{ soakStore.soakSummary.handledCount }}/{{ soakStore.soakSummary.routedTotal }}</div>
          <button
            class="wb-rt-candidate-btn"
            :disabled="soakStore.soakSummary.shadowTotal === 0 || soakExporting"
            :title="soakStore.lastExportPath"
            @click="exportSoakReport"
          >{{ soakExportLabel }}</button>
        </div>
        <div class="wb-rt-card-body" v-else>DevTools 执行 vaultWrite('config','holo-funnel-shadow','1') 后重载启用</div>
      </div>
      <!-- EXAM-5：验收考试卡（ACCEPTANCE-SPEC v1.0，控制面在主窗，题目经 DialogPanel 真实主路径执行） -->
      <div class="wb-rt-card">
        <div class="wb-rt-card-head">
          验收考试
          <span class="wb-rt-tag" :class="examPhaseTagClass">{{ examPhaseLabel }}</span>
        </div>
        <div class="wb-rt-card-body">
          <template v-if="examStore.progress.phase === 'idle'">
            <label class="wb-rt-exam-check">
              <input type="checkbox" v-model="examStore.fixtureReady" />
              桌面考试素材已就位（HoloExam 目录，见考试手册）
            </label>
            <label class="wb-rt-exam-check">
              题库
              <select v-model="examStore.activeCaseSet" class="wb-rt-exam-select">
                <option v-for="s in examCaseSets" :key="s.id" :value="s.id">{{ s.label }}·{{ s.count }} 题</option>
              </select>
            </label>
            <button class="wb-rt-candidate-btn" @click="startExam">开始考试（{{ activeCaseSetMeta.label }} · {{ activeCaseSetMeta.count }} 题，约 {{ activeCaseSetMeta.estMinutes }} 分钟）</button>
            <div class="wb-rt-candidate-hint">V2 会在 photos/media 留下产物，之后跑 V1 前请按手册复位（两套题库分轮跑）</div>
            <div class="wb-rt-candidate-hint">考试期间请勿在对话框手动输入；暂停点出现时在确认条上正常裁决</div>
          </template>
          <template v-else>
            <div v-if="examStore.progress.phase === 'running'">
              <div>第 {{ examStore.progress.current }}/{{ examStore.progress.total }} 题：{{ examStore.progress.currentLabel }}</div>
              <div>{{ examStore.progress.currentStatus }}</div>
              <button class="wb-rt-candidate-btn" @click="examStore.cancel()">中止考试</button>
            </div>
            <div v-else-if="examStore.progress.phase === 'done' || examStore.progress.phase === 'cancelled'">
              <div>可交付 {{ ((examStore.progress.report?.summary.deliverableRate ?? 0) * 100).toFixed(0) }}%（线 80%）/ 零干预 {{ ((examStore.progress.report?.summary.zeroInterventionRate ?? 0) * 100).toFixed(0) }}%（线 60%）</div>
              <div>平均耗时 {{ formatExamDuration(examStore.progress.report?.summary.avgDurationMs ?? 0) }}（线 2min）</div>
              <div v-if="examStore.progress.phase === 'cancelled'" class="wb-rt-candidate-hint">已中止（已完成题目仍计入成绩单）</div>
              <div v-if="examStore.lastPersistedAt > 0" class="wb-rt-candidate-hint">成绩单已自动落盘（EXAM-1：刷新/切模式不丢失）</div>
              <div class="wb-rt-exam-actions">
                <button
                  class="wb-rt-candidate-btn"
                  :disabled="examExporting"
                  :title="examExportPath"
                  @click="exportExamReport"
                >{{ examExportLabel }}</button>
                <button class="wb-rt-candidate-btn" @click="startExam">重新开考</button>
              </div>
            </div>
            <div v-else-if="examStore.progress.phase === 'error'" class="wb-rt-candidate-hint">
              考试异常：{{ examStore.progress.errorMessage }}
              <button class="wb-rt-candidate-btn" @click="startExam">重新开考</button>
            </div>
          </template>
        </div>
      </div>
      <div class="wb-rt-log">
        <div v-for="(e, i) in hotplugStore.eventLog" :key="i" class="wb-rt-log-item" :class="e.level">
          <span class="wb-rt-log-kind">{{ kindIcon(e.kind) }}</span>
          <span class="wb-rt-log-text">{{ e.text }}</span>
          <span class="wb-rt-time">{{ formatTime(e.ts) }}</span>
        </div>
        <div v-if="hotplugStore.eventLog.length === 0" class="wb-rt-log-empty">暂无事件</div>
      </div>
    </div>

    <!-- 区 3：Token 预算 -->
    <div class="wb-rt-section">
      <div class="wb-rt-title">Token 预算</div>
      <template v-if="debugStore.budgetStatus">
        <div class="wb-rt-budget-row" v-for="period in (['session', 'daily', 'monthly'] as const)" :key="period">
          <span class="wb-rt-k">{{ budgetLabel(period) }}</span>
          <div class="wb-rt-bar">
            <div class="wb-rt-bar-fill" :class="debugStore.budgetStatus[period].warnLevel" :style="{ width: Math.min(100, debugStore.budgetStatus[period].percent) + '%' }"></div>
          </div>
          <span class="wb-rt-v">{{ debugStore.budgetStatus[period].spent.toFixed(3) }}/{{ debugStore.budgetStatus[period].budget }} 元</span>
        </div>
      </template>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">本会话花费</span>
        <span class="wb-rt-v">¥{{ getSessionSpent().toFixed(4) }}</span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">预算模式</span>
        <span class="wb-rt-v">{{ budgetModeLabel }}</span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">熔断器</span>
        <span class="wb-rt-v">
          <template v-if="apiStore.isCircuitOpen">
            <span class="wb-rt-tag bad">已熔断</span>
            <button class="wb-rt-action" @click="apiStore.resetCircuitBreaker()">重置</button>
          </template>
          <span v-else class="wb-rt-tag ok">正常</span>
        </span>
      </div>
    </div>

    <!-- 区 4：探针流 -->
    <div class="wb-rt-section">
      <div class="wb-rt-title">
        探针流
        <span class="wb-rt-tag" :class="{ warn: debugStore.frozen }">{{ debugStore.frozen ? '❄️ 冻结' : '记录中' }}</span>
        <button class="wb-rt-action" @click="openDebugWindow">打开调试窗口</button>
      </div>
      <div class="wb-rt-probes">
        <div v-for="p in recentProbes" :key="p.id" class="wb-rt-probe" :class="{ error: p.source === 'error' }">
          <span class="wb-rt-probe-tool">{{ p.toolName || p.manifestId }}</span>
          <span class="wb-rt-probe-detail">{{ probeLabel(p) }}</span>
          <span class="wb-rt-time">{{ p.durationMs }}ms</span>
        </div>
        <div v-if="recentProbes.length === 0" class="wb-rt-log-empty">暂无探针</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDialogStore } from '@/domains/dialog'
import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useDebugStore } from '@/domains/debug'
import { useHotplugStore } from '@/stores/hotplugStore'
import { useSoakStore } from '@/stores/soakStore'
import { EXAM_CASE_SETS, useExamStore } from '@/stores/examStore'
import { getBudgetMode, getSessionSpent } from '@/services/tokenBudget'
import type { ProbeSnapshot } from '@/models'

const dialogStore = useDialogStore()
const nodeStore = useNodeStore()
const apiStore = useApiStore()
const debugStore = useDebugStore()
const hotplugStore = useHotplugStore()
const soakStore = useSoakStore()
const examStore = useExamStore()

const budgetModeLabel = computed(() => {
  const mode = getBudgetMode()
  if (mode === 'zero') return '零 Token'
  if (mode === 'economy') return '经济'
  return '标准'
})

const recentProbes = computed(() => {
  return [...debugStore.activeProbes].slice(-30).reverse()
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function kindIcon(kind: 'kernel' | 'pack' | 'funnel'): string {
  if (kind === 'kernel') return '🧠'
  if (kind === 'pack') return '📦'
  return '🧭'
}

function budgetLabel(period: 'session' | 'daily' | 'monthly'): string {
  if (period === 'session') return '会话'
  if (period === 'daily') return '日'
  return '月'
}

function nodeName(nodeId: string): string {
  return nodeStore.nodes.find(n => n.id === nodeId)?.name ?? nodeId
}

function dagStatusClass(status: string): string {
  if (status === 'running') return 'working'
  if (status === 'done' || status === 'reuse') return 'ok'
  if (status === 'failed') return 'error'
  return 'pending'
}

function dagStatusText(status: string): string {
  const map: Record<string, string> = { pending: '待执行', running: '执行中', done: '完成', failed: '失败', replanned: '已重规划', reuse: '复用', skip: '跳过' }
  return map[status] ?? status
}

function probeLabel(p: ProbeSnapshot): string {
  if (p.source === 'error') return '执行错误'
  if (p.source === 'cache') return '缓存命中'
  if (p.source === 'rule') return '规则触发'
  if (p.source === 'shell') return 'Shell 执行'
  return p.sourceDetail || '探针'
}

function openDebugWindow() {
  const api = (window as unknown as { electronAPI?: { openDebugWindow?: () => void } }).electronAPI
  api?.openDebugWindow?.()
}

// ===== A6：浸泡验证汇总导出（soakStore 数据管道，R15 证据采集） =====
const soakExporting = ref(false)
const soakExportLabel = ref('导出浸泡报告')

async function exportSoakReport(): Promise<void> {
  if (soakExporting.value) return
  soakExporting.value = true
  soakExportLabel.value = '导出中…'
  const path = await soakStore.exportSoakReport()
  soakExporting.value = false
  soakExportLabel.value = path ? '已导出' : '导出失败'
  setTimeout(() => { soakExportLabel.value = '导出浸泡报告' }, 3000)
}

// ===== EXAM-5：验收考试卡（状态在 examStore——EXAM-1/EXAM-6：模式切换不孤儿化，进度 reactive） =====
const examExporting = ref(false)
const examExportLabel = ref('导出成绩单')
  const examExportPath = ref('')
  const examCaseSets = EXAM_CASE_SETS
  const activeCaseSetMeta = computed(() =>
    examCaseSets.find(s => s.id === examStore.activeCaseSet) ?? examCaseSets[0]
  )

const examPhaseLabel = computed(() => {
  const phase = examStore.progress.phase
  if (phase === 'running') return '进行中'
  if (phase === 'done') return '已完成'
  if (phase === 'cancelled') return '已中止'
  if (phase === 'error') return '异常'
  return '未开始'
})

const examPhaseTagClass = computed(() => {
  const phase = examStore.progress.phase
  if (phase === 'running') return 'warn'
  if (phase === 'done') return 'ok'
  if (phase === 'error') return 'bad'
  return phase === 'cancelled' ? 'warn' : ''
})

function startExam(): void {
  examStore.startExam(examStore.fixtureReady, examStore.activeCaseSet)
}

async function exportExamReport(): Promise<void> {
  if (examExporting.value) return
  examExporting.value = true
  examExportLabel.value = '导出中…'
  const path = await examStore.exportReport()
  examExportPath.value = path ?? ''
  examExporting.value = false
  examExportLabel.value = path ? '已导出' : '导出失败'
  setTimeout(() => { examExportLabel.value = '导出成绩单' }, 3000)
}

function formatExamDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}
</script>

<style scoped>
.wb-runtime {
  --rt-bg: rgba(6, 9, 20, 0.92);
  --rt-border: rgba(80, 160, 255, 0.1);
  --rt-text: #b8c6dd;
  --rt-text-dim: #6b7a94;
  --rt-card-bg: rgba(255, 255, 255, 0.03);
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--rt-bg);
  border-left: 1px solid var(--rt-border);
  overflow-y: auto;
  overflow-x: hidden;
  user-select: none;
}

.wb-rt-section { padding: 10px 12px; border-bottom: 1px solid var(--rt-border); }
.wb-rt-title {
  font-size: 11px;
  font-weight: 600;
  color: #9ecbff;
  letter-spacing: 1px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-rt-title .wb-rt-action { margin-left: auto; }

.wb-rt-card {
  background: var(--rt-card-bg);
  border: 1px solid var(--rt-border);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--rt-text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-rt-card.warn { border-color: rgba(230, 180, 80, 0.35); }
.wb-rt-card-head { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.wb-rt-card-body { color: var(--rt-text-dim); display: flex; flex-direction: column; gap: 2px; }
.wb-rt-candidate-btn {
  text-align: left;
  background: rgba(80, 120, 255, 0.08);
  border: 1px solid rgba(80, 120, 255, 0.3);
  border-radius: 4px;
  color: var(--rt-text, #ccd2ee);
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.wb-rt-candidate-btn:hover:not(:disabled) { background: rgba(80, 120, 255, 0.22); }
.wb-rt-candidate-btn:disabled { opacity: 0.5; cursor: default; }
.wb-rt-candidate-hint { font-size: 10px; opacity: 0.6; margin-top: 4px; }
  .wb-rt-exam-check { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--rt-text-dim); cursor: pointer; }
  .wb-rt-exam-actions { display: flex; gap: 6px; margin-top: 6px; }
.wb-rt-card.wb-rt-card { flex-direction: column; align-items: stretch; }
.wb-rt-card .wb-rt-dot { align-self: auto; }

/* D1（星图删除的补偿）：星图模式里带「终止执行」的探针面板随星图删除，
   而工作台模式下该面板本来就不可见 ⇒ 主窗口将没有任何窗口内终止入口。
   这里把终止按钮补回工作台的「路由与执行」区。 */
.wb-rt-card.wb-rt-running { flex-direction: row; align-items: center; justify-content: space-between; }
.wb-rt-terminate {
  border: 1px solid rgba(255, 90, 90, 0.5);
  color: #ff6b6b;
  background: rgba(255, 60, 60, 0.08);
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}
.wb-rt-terminate:not(:disabled):hover { background: rgba(255, 60, 60, 0.18); color: #ff8a8a; }
/* 无在册控制器（路由/规划阶段）时置灰：该阶段点击本就无任何中止效果（此前无条件可点 ⇒ 静默空转）。
   置灰 + title 说明，避免「点了没反应」。 */
.wb-rt-terminate:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  border-color: rgba(255, 90, 90, 0.25);
  color: #8a7070;
  background: rgba(255, 60, 60, 0.04);
}

.wb-rt-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.wb-rt-dot.working { background: #6db3ff; animation: wb-pulse 1s infinite; }
.wb-rt-dot.ok { background: #5ec98a; }
.wb-rt-dot.error { background: #e06a6a; }
.wb-rt-dot.pending { background: #55617a; }
@keyframes wb-pulse { 50% { opacity: 0.35; } }

.wb-rt-tag {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
}
.wb-rt-tag.ok { background: rgba(94, 201, 138, 0.14); color: #5ec98a; }
.wb-rt-tag.warn { background: rgba(230, 180, 80, 0.14); color: #e0b450; }
.wb-rt-tag.bad { background: rgba(224, 106, 106, 0.14); color: #e06a6a; }

.wb-rt-kv { display: flex; align-items: baseline; gap: 8px; font-size: 11px; margin-bottom: 5px; }
.wb-rt-k { color: var(--rt-text-dim); flex-shrink: 0; width: 62px; }
.wb-rt-v { color: var(--rt-text); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.wb-rt-chip {
  font-size: 9px;
  padding: 0 5px;
  border-radius: 7px;
  background: rgba(80, 160, 255, 0.1);
  color: #7aa8dd;
}

.wb-rt-dag-step { display: flex; align-items: center; gap: 6px; }
.wb-rt-dag-node { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-dag-status { color: var(--rt-text-dim); font-size: 10px; }

.wb-rt-log {
  margin-top: 8px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wb-rt-log-item { display: flex; align-items: baseline; gap: 5px; font-size: 10px; color: var(--rt-text-dim); }
.wb-rt-log-item.warn { color: #e0b450; }
.wb-rt-log-item.error { color: #e06a6a; }
.wb-rt-log-kind { flex-shrink: 0; }
.wb-rt-log-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-log-empty { font-size: 10px; color: var(--rt-text-dim); text-align: center; padding: 8px 0; }

.wb-rt-budget-row { display: flex; align-items: center; gap: 6px; font-size: 10px; margin-bottom: 5px; }
.wb-rt-budget-row .wb-rt-k { width: 28px; }
.wb-rt-bar { flex: 1; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
.wb-rt-bar-fill { height: 100%; border-radius: 3px; background: #5ec98a; transition: width 0.3s; }
.wb-rt-bar-fill.warning { background: #e0b450; }
.wb-rt-bar-fill.critical, .wb-rt-bar-fill.exceeded { background: #e06a6a; }
.wb-rt-budget-row .wb-rt-v { width: 96px; justify-content: flex-end; flex-shrink: 0; font-size: 9px; }

.wb-rt-action {
  background: none;
  border: 1px solid var(--rt-border);
  color: var(--rt-text);
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.wb-rt-action:hover { background: rgba(80, 160, 255, 0.08); }

.wb-rt-probes { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.wb-rt-probe { display: flex; align-items: baseline; gap: 6px; font-size: 10px; color: var(--rt-text-dim); }
.wb-rt-probe.error { color: #e06a6a; }
.wb-rt-probe-tool { color: var(--rt-text); flex-shrink: 0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-probe-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.wb-rt-time { font-size: 9px; color: var(--rt-text-dim); opacity: 0.7; flex-shrink: 0; }

:root[data-theme='light'] .wb-runtime {
  --rt-bg: rgba(240, 243, 250, 0.95);
  --rt-border: rgba(0, 0, 0, 0.08);
  --rt-text: #3a4254;
  --rt-text-dim: #8a93a6;
  --rt-card-bg: rgba(0, 0, 0, 0.02);
}
:root[data-theme='green'] .wb-runtime {
  --rt-bg: rgba(20, 32, 20, 0.92);
  --rt-border: rgba(80, 160, 80, 0.15);
  --rt-text: #a8c8a8;
  --rt-text-dim: #6a8a6a;
  --rt-card-bg: rgba(255, 255, 255, 0.03);
}
</style>
