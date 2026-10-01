<template>
  <div class="wb-nav" :class="{ collapsed: navCollapsed }">
    <div class="wb-nav-header">
      <span class="wb-nav-logo">HS</span>
      <span v-if="!navCollapsed" class="wb-nav-title">HoloStarmap</span>
      <button class="wb-nav-collapse-btn" @click="navCollapsed = !navCollapsed" :title="navCollapsed ? '展开导航' : '收起导航'">{{ navCollapsed ? '»' : '«' }}</button>
    </div>

    <div class="wb-nav-section">
      <div v-if="!navCollapsed" class="wb-nav-section-label">主视图</div>
      <button class="wb-nav-item active" :title="'工作台（唯一主视图）'">
        <span class="wb-nav-icon">🛠</span>
        <span v-if="!navCollapsed" class="wb-nav-item-text">工作台</span>
      </button>
    </div>

    <div class="wb-nav-section">
      <div v-if="!navCollapsed" class="wb-nav-section-label">配置</div>
      <button class="wb-nav-item" title="模型网关配置" @click="emit('openApiSettings')">
        <span class="wb-nav-icon">🧠</span>
        <span v-if="!navCollapsed" class="wb-nav-item-text">模型网关</span>
      </button>
    </div>

    <!-- 2026-10-01 UI 分端：开发者工具收进默认折叠的「开发者」分区，用户端默认看不到它们。
         空 shell 的 L0 自动执行、funnel 主路径开关、四个工具窗口都是开发者向，不进用户视野。 -->
    <div class="wb-nav-section">
      <button
        v-if="!navCollapsed"
        class="wb-nav-section-label wb-nav-dev-toggle"
        :title="devOpen ? '收起开发者工具' : '展开开发者工具'"
        @click="devOpen = !devOpen"
      >开发者 {{ devOpen ? '▾' : '▸' }}</button>
      <button v-else class="wb-nav-item" :title="'开发者工具'" @click="devOpen = !devOpen">
        <span class="wb-nav-icon">⚙</span>
      </button>

      <template v-if="devOpen">
        <button class="wb-nav-item" title="管线编辑器（独立窗口）" @click="openWindow('openPipelineWindow')">
          <span class="wb-nav-icon">🧩</span>
          <span v-if="!navCollapsed" class="wb-nav-item-text">管线编辑器</span>
        </button>
        <!-- 2026-10-01：调试中心 / 压测台 / 规则审核 已合并为一个独立「开发者端」窗口 -->
        <button class="wb-nav-item" title="开发者端（调试中心 / 压测台 / 规则审核）" @click="openWindow('openDevWindow')">
          <span class="wb-nav-icon">🛠</span>
          <span v-if="!navCollapsed" class="wb-nav-item-text">开发者端</span>
        </button>
        <button
          class="wb-nav-item"
          :class="{ 'wb-nav-danger': !hotplugStore.funnelMainEnabled }"
          :title="hotplugStore.funnelMainEnabled ? 'funnel 主路径运行中——点击回滚旧六层路由' : 'funnel 主路径已关闭——点击恢复'"
          @click="hotplugStore.toggleFunnelMain()"
        >
          <span class="wb-nav-icon">{{ hotplugStore.funnelMainEnabled ? '🟢' : '🟠' }}</span>
          <span v-if="!navCollapsed" class="wb-nav-item-text">funnel 主路径</span>
          <span v-if="!navCollapsed" class="wb-nav-badge" :class="{ off: !hotplugStore.funnelMainEnabled }">{{ hotplugStore.funnelMainEnabled ? 'ON' : 'OFF' }}</span>
        </button>
      </template>
    </div>

    <div class="wb-nav-section wb-nav-sessions">
      <div v-if="!navCollapsed" class="wb-nav-section-label">
        会话
        <button class="wb-nav-new-session" title="新建会话" @click="onNewSession">＋</button>
      </div>
      <div class="wb-nav-session-list">
        <div
          v-for="s in sessionStore.activeSessions"
          :key="s.id"
          class="wb-nav-item wb-nav-session"
          :class="{ active: s.id === sessionStore.activeSessionId }"
          :title="`${s.name}（${s.messages.length} 条消息）`"
          @click="onSwitchSession(s.id)"
        >
          <span class="wb-nav-icon">💬</span>
          <input
            v-if="renamingId === s.id"
            class="wb-nav-rename-input"
            v-model="renameValue"
            @click.stop
            @keydown.enter="commitRename(s.id)"
            @keydown.esc="cancelRename"
            @blur="commitRename(s.id)"
          />
          <template v-else>
            <span v-if="!navCollapsed" class="wb-nav-item-text wb-nav-session-name">{{ s.name }}</span>
            <!-- 2026-10-01：会话管理入口收进侧栏（能力本就在 sessionStore/dialogStore，此前只挂在 DialogPanel 里，侧栏点不到） -->
            <span class="wb-nav-sess-actions" @click.stop>
              <button title="重命名" @click="startRename(s)">✎</button>
              <button title="归档（隐藏）" @click="sessionStore.archiveSession(s.id)">📦</button>
              <button title="删除" @click="onDeleteSession(s.id)">✕</button>
            </span>
          </template>
        </div>

        <!-- 归档（隐藏）的会话：可展开并恢复，使「隐藏」可逆 -->
        <div v-if="archivedSessions.length > 0" class="wb-nav-archived">
          <button class="wb-nav-item wb-nav-archived-toggle" :title="archivedOpen ? '收起已归档' : '展开已归档'" @click="archivedOpen = !archivedOpen">
            <span class="wb-nav-icon">📦</span>
            <span v-if="!navCollapsed" class="wb-nav-item-text">已归档 ({{ archivedSessions.length }}) {{ archivedOpen ? '▾' : '▸' }}</span>
          </button>
          <template v-if="archivedOpen">
            <div v-for="s in archivedSessions" :key="s.id" class="wb-nav-item wb-nav-session wb-nav-archived-item" :title="s.name">
              <span class="wb-nav-icon">💬</span>
              <span v-if="!navCollapsed" class="wb-nav-item-text wb-nav-session-name">{{ s.name }}</span>
              <span class="wb-nav-sess-actions" @click.stop>
                <button title="恢复" @click="sessionStore.unarchiveSession(s.id)">↩</button>
                <button title="删除" @click="onDeleteSession(s.id)">✕</button>
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="wb-nav-footer">
      <span class="wb-nav-footer-text" v-if="!navCollapsed">v0.1 · 内核 {{ hotplugStore.activeKernelId || '—' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDialogStore } from '@/domains/dialog'
import { useSessionStore } from '@/domains/app'
import { useHotplugStore } from '@/stores/hotplugStore'

const dialogStore = useDialogStore()
const sessionStore = useSessionStore()
const hotplugStore = useHotplugStore()

const navCollapsed = ref(false)
/** 2026-10-01 UI 分端：开发者分区默认折叠 —— 用户端默认看不到开发工具 */
const devOpen = ref(false)

// ── 会话管理（2026-10-01）────────────────────────────────────────────────────
// 删除/重命名/归档的能力本就在 sessionStore / dialogStore，此前只有 DialogPanel 挂了入口，
// 用户在侧栏（操作会话的地方）够不到 → 表现为「会话不能删除/重命名/隐藏」。此处补齐侧栏入口。
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const archivedOpen = ref(false)
const archivedSessions = computed(() => sessionStore.sessions.filter(s => s.status === 'archived'))

function startRename(s: { id: string; name: string }): void {
  renamingId.value = s.id
  renameValue.value = s.name
}
function cancelRename(): void {
  renamingId.value = null
}
function commitRename(id: string): void {
  if (renamingId.value !== id) return
  const name = renameValue.value.trim()
  if (name) sessionStore.renameSession(id, name)
  renamingId.value = null
}
/** 删除必须经 dialogStore 路由（P0-8：直调 sessionStore.deleteSession 会漏掉边界处理） */
function onDeleteSession(id: string): void {
  dialogStore.deleteSession(id)
}

const emit = defineEmits<{ openApiSettings: [] }>()

function openWindow(fn: 'openPipelineWindow' | 'openDebugWindow' | 'openBenchmarkWindow' | 'openRuleReviewWindow' | 'openDevWindow') {
  const api = (window as unknown as Record<string, undefined | (() => void)>).electronAPI as Record<string, undefined | (() => void)> | undefined
  api?.[fn]?.()
}

// P0-C4：统一走 dialogStore 入口——原实现直接别名赋值 dialogStore.messages = switched.messages
// （P0-8 违例：push 会直改会话存储数组），且不清暂停点/不复位 isProcessing
function onNewSession() {
  const s = dialogStore.newSession()
  dialogStore.showTransientHint(`✅ 已创建并切换到: ${s.name}`)
}

function onSwitchSession(sessionId: string) {
  if (sessionId === sessionStore.activeSessionId) return
  const switched = dialogStore.switchSession(sessionId)
  if (switched) {
    dialogStore.showTransientHint(`🔄 已切换到: ${switched.name}`)
  }
}
</script>

<style scoped>
.wb-nav {
  --wb-nav-bg: rgba(6, 9, 20, 0.92);
  --wb-nav-border: rgba(80, 160, 255, 0.1);
  --wb-nav-text: #b8c6dd;
  --wb-nav-text-dim: #6b7a94;
  --wb-nav-active-bg: rgba(80, 160, 255, 0.12);
  --wb-nav-hover-bg: rgba(80, 160, 255, 0.07);
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--wb-nav-bg);
  border-right: 1px solid var(--wb-nav-border);
  overflow: hidden;
  user-select: none;
}
.wb-nav.collapsed { width: 46px; }

.wb-nav-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-bottom: 1px solid var(--wb-nav-border);
}
.wb-nav-logo {
  font-size: 12px;
  font-weight: 700;
  color: #6db3ff;
  background: rgba(80, 160, 255, 0.12);
  border-radius: 6px;
  padding: 2px 6px;
  flex-shrink: 0;
}
.wb-nav-title { font-size: 12px; font-weight: 600; color: var(--wb-nav-text); flex: 1; white-space: nowrap; overflow: hidden; }
.wb-nav-collapse-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--wb-nav-text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  border-radius: 4px;
  flex-shrink: 0;
}
.wb-nav-collapse-btn:hover { color: var(--wb-nav-text); background: var(--wb-nav-hover-bg); }
.wb-nav.collapsed .wb-nav-collapse-btn { margin-left: 0; }

.wb-nav-section { padding: 8px 6px; border-bottom: 1px solid var(--wb-nav-border); }
.wb-nav-section-label {
  font-size: 10px;
  color: var(--wb-nav-text-dim);
  padding: 2px 6px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  letter-spacing: 1px;
}
.wb-nav-new-session {
  background: none;
  border: 1px solid var(--wb-nav-border);
  color: var(--wb-nav-text);
  cursor: pointer;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1;
  padding: 2px 6px;
}
.wb-nav-new-session:hover { background: var(--wb-nav-hover-bg); }

/* 2026-10-01 UI 分端：开发者分区标题做成可点击的折叠开关（默认收起，用户端更松） */
.wb-nav-dev-toggle {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  letter-spacing: 1px;
  padding: 0;
  opacity: 0.7;
}
.wb-nav-dev-toggle:hover { opacity: 1; color: var(--wb-nav-text); }

/* 2026-10-01 会话管理：操作按钮随 hover 出现（默认不占视觉注意力），归档区低对比 */
.wb-nav-sess-actions {
  display: none;
  gap: 2px;
  margin-left: auto;
  align-items: center;
}
.wb-nav-session:hover .wb-nav-sess-actions { display: flex; }
.wb-nav-sess-actions button {
  background: none;
  border: none;
  color: var(--wb-nav-text-dim);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 1px 3px;
  border-radius: 3px;
}
.wb-nav-sess-actions button:hover { color: var(--wb-nav-text); background: var(--wb-nav-hover-bg); }
.wb-nav-rename-input {
  flex: 1;
  min-width: 0;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--wb-nav-border);
  border-radius: 3px;
  color: var(--wb-nav-text);
  font-size: 12px;
  padding: 1px 4px;
}
.wb-nav-archived { margin-top: 2px; border-top: 1px dashed var(--wb-nav-border); padding-top: 2px; }
.wb-nav-archived-toggle { opacity: 0.7; }
.wb-nav-archived-item { opacity: 0.75; }

.wb-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--wb-nav-text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.wb-nav-item:hover { background: var(--wb-nav-hover-bg); }
.wb-nav-item.active { background: var(--wb-nav-active-bg); color: #9ecbff; }
.wb-nav-item.wb-nav-danger { color: #e0a860; }
.wb-nav-icon { flex-shrink: 0; font-size: 13px; }
.wb-nav-item-text { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-nav-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(80, 200, 120, 0.15);
  color: #5ec98a;
}
.wb-nav-badge.off { background: rgba(230, 160, 60, 0.15); color: #e0a860; }

.wb-nav-sessions { flex: 1; min-height: 0; display: flex; flex-direction: column; border-bottom: none; }
.wb-nav-session-list { flex: 1; overflow-y: auto; min-height: 0; }
.wb-nav-session .wb-nav-session-name { font-size: 11px; }

.wb-nav-footer {
  padding: 6px 10px;
  border-top: 1px solid var(--wb-nav-border);
}
.wb-nav-footer-text { font-size: 10px; color: var(--wb-nav-text-dim); }

:root[data-theme='light'] .wb-nav {
  --wb-nav-bg: rgba(240, 243, 250, 0.95);
  --wb-nav-border: rgba(0, 0, 0, 0.08);
  --wb-nav-text: #3a4254;
  --wb-nav-text-dim: #8a93a6;
  --wb-nav-active-bg: rgba(60, 110, 220, 0.1);
  --wb-nav-hover-bg: rgba(60, 110, 220, 0.06);
}
:root[data-theme='green'] .wb-nav {
  --wb-nav-bg: rgba(20, 32, 20, 0.92);
  --wb-nav-border: rgba(80, 160, 80, 0.15);
  --wb-nav-text: #a8c8a8;
  --wb-nav-text-dim: #6a8a6a;
  --wb-nav-active-bg: rgba(80, 160, 80, 0.15);
  --wb-nav-hover-bg: rgba(80, 160, 80, 0.08);
}
</style>
