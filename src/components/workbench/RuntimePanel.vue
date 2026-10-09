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
      <!-- 2026-10-01（用户裁定：热插拔要「能替换」）：此前本区只有只读展示，用户点不动。
           现补操作入口——内核可在池中切换；每个 pack 可挂载/卸载/重载（复用已有运行时 API）。 -->
      <div class="wb-rt-kv">
        <span class="wb-rt-k">切换内核</span>
        <span class="wb-rt-v">
          <select
            class="wb-rt-select"
            :value="hotplugStore.activeKernelId"
            :disabled="hotplugStore.operating || hotplugStore.kernelIds.length === 0"
            @change="hotplugStore.activateKernel(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="k in hotplugStore.kernelIds" :key="k" :value="k">{{ k }}</option>
          </select>
          <span v-if="hotplugStore.kernelIds.length <= 1" class="wb-rt-hint">池中仅 1 个内核</span>
        </span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">在途/队列</span>
        <span class="wb-rt-v">{{ hotplugStore.kernelInFlight }} / {{ hotplugStore.kernelQueueLen }}</span>
      </div>
      <div class="wb-rt-kv">
        <span class="wb-rt-k">Pack</span>
        <span class="wb-rt-v">{{ hotplugStore.mountedPackIds.length }}/{{ hotplugStore.allPackIds.length }}</span>
      </div>
      <div class="wb-rt-packlist">
        <div v-for="p in hotplugStore.allPackIds" :key="p" class="wb-rt-packrow">
          <div class="wb-rt-packhead">
            <span class="wb-rt-packname">{{ p }}</span>
            <span class="wb-rt-tag" :class="hotplugStore.mountedPackIds.includes(p) ? 'ok' : 'off'">
              {{ hotplugStore.mountedPackIds.includes(p) ? '已挂载' : '未挂载' }}
            </span>
          </div>
          <div class="wb-rt-packops">
            <button class="wb-rt-op" :disabled="hotplugStore.operating || hotplugStore.mountedPackIds.includes(p)" @click="hotplugStore.mountPack(p)">挂载</button>
            <button class="wb-rt-op" :disabled="hotplugStore.operating || !hotplugStore.mountedPackIds.includes(p)" @click="hotplugStore.unmountPack(p)">卸载</button>
            <button class="wb-rt-op" :disabled="hotplugStore.operating || !hotplugStore.mountedPackIds.includes(p)" @click="hotplugStore.reloadPack(p)">重载</button>
          </div>
        </div>
        <div v-if="hotplugStore.allPackIds.length === 0" class="wb-rt-log-empty">无可用领域包</div>
      </div>
      <!-- 2026-10-01：funnel 主路径状态与「浸泡验证」卡片都删去 —— 已定用六层漏斗，
           这个开关（及其 shadow 对照：浸泡验证测的正是 funnel vs 旧路径的一致性）不再有意义
           （用户裁定「funnel 主路径是否开启也不影响真正使用」「浸泡验证意义不明」）。 -->
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
          <span class="wb-rt-log-kind"><Icon :name="kindIcon(e.kind)" :size="12" /></span>
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

  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { useDialogStore } from '@/domains/dialog'
import { useNodeStore } from '@/domains/node'
import { useApiStore } from '@/domains/api'
import { useDebugStore } from '@/domains/debug'
import { useHotplugStore } from '@/stores/hotplugStore'
import { EXAM_CASE_SETS, useExamStore } from '@/stores/examStore'
import { getBudgetMode, getSessionSpent } from '@/services/tokenBudget'
import type { ProbeSnapshot } from '@/models'

const dialogStore = useDialogStore()
const nodeStore = useNodeStore()
const apiStore = useApiStore()
const debugStore = useDebugStore()
const hotplugStore = useHotplugStore()
const examStore = useExamStore()

const budgetModeLabel = computed(() => {
  const mode = getBudgetMode()
  if (mode === 'zero') return '零 Token'
  if (mode === 'economy') return '经济'
  return '标准'
})

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function kindIcon(kind: 'kernel' | 'pack' | 'funnel'): 'cpu' | 'package' | 'compass' {
  if (kind === 'kernel') return 'cpu'
  if (kind === 'pack') return 'package'
  return 'compass'
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
  /* 底色/字色直接消费三档令牌（原为写死的旧深蓝一套）。 */
  --rt-bg: var(--t-panel, rgba(6, 9, 20, 0.92));
  --rt-border: var(--t-line, rgba(80, 160, 255, 0.1));
  --rt-text: var(--t-text, #b8c6dd);
  --rt-text-dim: var(--t-dim, #6b7a94);
  --rt-card-bg: var(--t-panel-2, rgba(255, 255, 255, 0.03));
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
.wb-rt-candidate-hint { font-size: var(--font-sm); opacity: 0.6; margin-top: 4px; }
  .wb-rt-exam-check { display: flex; align-items: center; gap: 5px; font-size: var(--font-sm); color: var(--rt-text-dim); cursor: pointer; }
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
  font-size: var(--font-xs);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
}
.wb-rt-tag.ok { background: rgba(94, 201, 138, 0.14); color: #5ec98a; }
.wb-rt-tag.warn { background: rgba(230, 180, 80, 0.14); color: #e0b450; }
.wb-rt-tag.bad { background: rgba(224, 106, 106, 0.14); color: #e06a6a; }
.wb-rt-tag.off { background: rgba(140, 150, 170, 0.12); color: var(--rt-text-dim); }

/* 2026-10-01：热插拔操作入口（领域包装卸/重载 + 内核切换） */
.wb-rt-select { font-size: var(--font-sm); background: rgba(20, 30, 50, 0.6); color: var(--rt-text); border: 1px solid rgba(100, 180, 255, 0.2); border-radius: 3px; padding: 1px 4px; max-width: 140px; }
.wb-rt-select:disabled { opacity: 0.5; }
.wb-rt-hint { font-size: var(--font-xs); color: var(--rt-text-dim); }
.wb-rt-packlist { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
/* 2026-10-09：状态与动作分离——原先「已挂载」tag 与三个动作按钮挤在同一行、同级同权重，
   读起来像一排开关。改为两行：上行「名称 + 状态」，下行动作按钮组。 */
.wb-rt-packrow { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-sm); padding: 4px 0; border-bottom: 1px solid var(--t-line, rgba(100, 180, 255, 0.1)); }
.wb-rt-packhead { display: flex; align-items: center; gap: 6px; }
.wb-rt-packops { display: flex; gap: 4px; }
.wb-rt-packname { flex: 1; color: var(--rt-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-op { font-size: var(--font-xs); padding: 1px 6px; background: color-mix(in srgb, var(--t-accent, #8ab4ff) 10%, transparent); border: 1px solid var(--t-line, rgba(100, 180, 255, 0.18)); border-radius: 3px; color: var(--t-accent, #8ab4d8); cursor: pointer; }
.wb-rt-op:hover:not(:disabled) { background: color-mix(in srgb, var(--t-accent, #8ab4ff) 22%, transparent); }
.wb-rt-op:disabled { opacity: 0.35; cursor: not-allowed; }

.wb-rt-kv { display: flex; align-items: baseline; gap: 8px; font-size: 11px; margin-bottom: 5px; }
.wb-rt-k { color: var(--rt-text-dim); flex-shrink: 0; width: 62px; }
.wb-rt-v { color: var(--rt-text); display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.wb-rt-chip {
  font-size: var(--font-xs);
  padding: 0 5px;
  border-radius: 7px;
  background: rgba(80, 160, 255, 0.1);
  color: #7aa8dd;
}

.wb-rt-dag-step { display: flex; align-items: center; gap: 6px; }
.wb-rt-dag-node { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-dag-status { color: var(--rt-text-dim); font-size: var(--font-sm); }

.wb-rt-log {
  margin-top: 8px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wb-rt-log-item { display: flex; align-items: baseline; gap: 5px; font-size: var(--font-sm); color: var(--rt-text-dim); }
.wb-rt-log-item.warn { color: #e0b450; }
.wb-rt-log-item.error { color: #e06a6a; }
.wb-rt-log-kind { flex-shrink: 0; }
.wb-rt-log-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-rt-log-empty { font-size: var(--font-sm); color: var(--rt-text-dim); text-align: center; padding: 8px 0; }

.wb-rt-budget-row { display: flex; align-items: center; gap: 6px; font-size: var(--font-sm); margin-bottom: 5px; }
.wb-rt-budget-row .wb-rt-k { width: 28px; }
.wb-rt-bar { flex: 1; height: 5px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
.wb-rt-bar-fill { height: 100%; border-radius: 3px; background: #5ec98a; transition: width 0.3s; }
.wb-rt-bar-fill.warning { background: #e0b450; }
.wb-rt-bar-fill.critical, .wb-rt-bar-fill.exceeded { background: #e06a6a; }
.wb-rt-budget-row .wb-rt-v { width: 96px; justify-content: flex-end; flex-shrink: 0; font-size: var(--font-xs); }

.wb-rt-action {
  background: none;
  border: 1px solid var(--rt-border);
  color: var(--rt-text);
  font-size: var(--font-xs);
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.wb-rt-action:hover { background: rgba(80, 160, 255, 0.08); }

.wb-rt-time { font-size: var(--font-xs); color: var(--rt-text-dim); opacity: 0.7; flex-shrink: 0; }

/* light/green 的旧覆盖块（2026-10-07 e8fa384 补的）已删除 —— 基底已直接消费 --t-* 令牌。 */
</style>
