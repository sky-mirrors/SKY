<template>
  <div class="wb-nav" :class="{ collapsed: navCollapsed }">
    <div class="wb-nav-header">
      <!-- 2026-10-01：收起后只剩窄条、其他操作够不到 —— 双击 HS 图标即恢复展开（用户反馈） -->
      <span class="wb-nav-logo" @dblclick="navCollapsed = false" :title="navCollapsed ? '双击展开导航' : 'HoloStarmap'">HS</span>
      <span v-if="!navCollapsed" class="wb-nav-title">HoloStarmap</span>
      <button v-if="!navCollapsed" class="wb-nav-collapse-btn" @click="navCollapsed = true" title="收起导航">«</button>
    </div>

    <!-- 2026-10-01：现在只有一个视图，「主视图」节与「工作台」项删去 -->
    <div class="wb-nav-section">
      <!-- 2026-10-01：配置 / 工具的分组标题文本栏删去（项保留） -->
      <button class="wb-nav-item" title="模型网关配置" @click="emit('openApiSettings')">
        <span class="wb-nav-icon">🧠</span>
        <span v-if="!navCollapsed" class="wb-nav-item-text">模型网关</span>
      </button>
    </div>

    <!-- 2026-10-01 UI 分端：开发者工具收进默认折叠的「开发者」分区，用户端默认看不到它们。
         空 shell 的 L0 自动执行、funnel 主路径开关、四个工具窗口都是开发者向，不进用户视野。 -->
    <div class="wb-nav-section">
      <button class="wb-nav-item" title="管线编辑器（独立窗口）" @click="openWindow('openPipelineWindow')">
        <span class="wb-nav-icon">🧩</span>
        <span v-if="!navCollapsed" class="wb-nav-item-text">管线编辑器</span>
      </button>
      <!-- 2026-10-01（用户裁定）：知识库入口从指令区迁到这里，与管线编辑器并列 -->
      <button class="wb-nav-item" title="知识库管理（独立窗口）" @click="openWindow('openKnowledgeWindow')">
        <span class="wb-nav-icon">📚</span>
        <span v-if="!navCollapsed" class="wb-nav-item-text">知识库</span>
      </button>
    </div>

    <div class="wb-nav-section wb-nav-sessions">
      <div v-if="!navCollapsed" class="wb-nav-section-label">
        <!-- 2026-10-01：会话列表可折叠（会话多时占满侧栏，挤压上面的功能入口） -->
        <button class="wb-nav-sessions-toggle" :title="sessionsOpen ? '折叠会话列表' : '展开会话列表'" @click="sessionsOpen = !sessionsOpen">会话 {{ sessionsOpen ? '▾' : '▸' }}</button>
        <button class="wb-nav-new-session" title="新建会话" @click="onNewSession">＋</button>
      </div>
      <div v-show="sessionsOpen || navCollapsed" class="wb-nav-session-list">
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
            <!-- 2026-10-01：会话级操作统一到左导航（附件 / 连接知识库），
                 原先它们和「会话列表」一起挤在指令区的 💬 面板里，与左导航的会话列表重复、对用户不清晰 -->
            <span class="wb-nav-sess-actions" @click.stop>
              <button title="添加附件" @click="onSessionAction(s.id, 'attach')">📎</button>
              <button title="连接知识库" @click="onSessionAction(s.id, 'kb')">🔗</button>
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
import { globalBus } from '@/kernel/bus'
import { useDialogStore } from '@/domains/dialog'
import { useSessionStore } from '@/domains/app'
import { useHotplugStore } from '@/stores/hotplugStore'

const dialogStore = useDialogStore()
const sessionStore = useSessionStore()
const hotplugStore = useHotplugStore()

const navCollapsed = ref(false)
/** 2026-10-01：会话列表默认展开，可折叠（会话多时不再挤占侧栏） */
const sessionsOpen = ref(true)

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

/**
 * 2026-10-01：会话级操作（添加附件 / 连接知识库）统一由左导航发起。
 * 这两项的实际逻辑仍在指令区（附件要 FileReader + 摄取，知识库要选分组），
 * 所以这里只做「选中该会话 + 请求指令区打开对应面板」，避免把逻辑复制两份。
 */
function onSessionAction(sessionId: string, panel: 'attach' | 'kb'): void {
  onSwitchSession(sessionId)
  globalBus.emit('ui:session-panel', { panel })
}

const emit = defineEmits<{ openApiSettings: [] }>()

function openWindow(fn: 'openPipelineWindow' | 'openKnowledgeWindow' | 'openDebugWindow' | 'openBenchmarkWindow' | 'openRuleReviewWindow' | 'openDevWindow') {
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
  /* 底色/字色直接消费三档令牌（原为写死的旧深蓝一套）。active/hover 用主题强调色按原比例混出。
     无 data-theme 时逐项兜底到原深色。 */
  --wb-nav-bg: var(--t-panel, rgba(6, 9, 20, 0.92));
  --wb-nav-border: var(--t-line, rgba(80, 160, 255, 0.1));
  --wb-nav-text: var(--t-text, #b8c6dd);
  --wb-nav-text-dim: var(--t-dim, #6b7a94);
  --wb-nav-active-bg: color-mix(in srgb, var(--t-accent, #8ab4ff) 14%, transparent);
  --wb-nav-hover-bg: color-mix(in srgb, var(--t-accent, #8ab4ff) 7%, transparent);
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
  color: var(--t-accent, #6db3ff);
  background: color-mix(in srgb, var(--t-accent, #80a0ff) 14%, transparent);
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
  font-size: var(--font-sm);
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
.wb-nav-sessions-toggle {
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
.wb-nav-sessions-toggle:hover { opacity: 1; color: var(--wb-nav-text); }

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
  font-size: var(--font-xs);
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
.wb-nav-footer-text { font-size: var(--font-sm); color: var(--wb-nav-text-dim); }

/* light/green 的旧覆盖块（2026-10-07 e8fa384 补的）已删除 —— 基底已直接消费 --t-* 令牌，无需再逐档覆盖。 */
</style>
