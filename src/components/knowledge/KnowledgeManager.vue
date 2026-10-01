<template>
  <div class="km-root">
    <header class="km-titlebar">
      <span class="km-titlebar-text">📚 HoloStarmap 知识库</span>
      <span class="km-notice" v-if="notice">{{ notice }}</span>
      <div class="km-titlebar-actions">
        <button class="km-tb-btn" @click="onMinimize" title="最小化">─</button>
        <button class="km-tb-btn" @click="onMaximize" title="最大化/还原">□</button>
        <button class="km-tb-btn km-tb-close" @click="onClose" title="关闭">✕</button>
      </div>
    </header>

    <div class="km-body">
      <div class="kb-panel">
        <div class="kb-toolbar">
          <button class="kb-upload-btn" @click="onUpload">📤 上传文件</button>
          <span class="kb-count">{{ kbEntries.length }} 文件 / {{ totalChunks }} 块</span>
        </div>
        <div class="kb-tabs">
          <button class="kb-tab" :class="{ active: kbTab === 'browse' }" @click="kbTab = 'browse'">浏览</button>
          <button class="kb-tab" :class="{ active: kbTab === 'refs' }" @click="kbTab = 'refs'">对话引用</button>
        </div>

        <template v-if="kbTab === 'browse'">
          <div class="kb-search-row">
            <input class="kb-search-input" v-model="kbSearchQuery" placeholder="搜索知识库..." @keydown.enter="onKbSearch" />
            <button class="kb-search-btn" @click="onKbSearch" :disabled="kbSearching">{{ kbSearching ? '⏳' : '🔍' }}</button>
          </div>
          <div class="kb-search-results" v-if="kbSearchResults.length > 0">
            <div v-for="(r, i) in kbSearchResults" :key="i" class="kb-result-item">
              <span class="kb-result-score">{{ (r.score * 100).toFixed(0) }}%</span>
              <span class="kb-result-text">{{ r.text.substring(0, 80) }}{{ r.text.length > 80 ? '...' : '' }}</span>
            </div>
          </div>
          <div class="kb-search-empty" v-else-if="kbSearched && !kbSearching">
            🔍 未找到相关知识
          </div>

          <!-- 2026-10-01（用户反馈：上传后不知道「传到了哪个文件夹、哪个对话」）：
               此前界面只有一个总数，既看不到文件清单、也看不到归属。现列出文件并逐条标注
               它属于哪个分组 / 哪个会话 / 还是仅全局。 -->
          <div class="kb-files-section">
            <div class="kb-section-label">📄 文件 ({{ kbEntries.length }})</div>
            <div class="kb-file-list">
              <div v-for="e in kbEntries.slice(0, 40)" :key="e.id" class="kb-file-row">
                <span class="kf-name" :title="e.filename">{{ e.filename }}</span>
                <span class="kf-chunks">{{ e.chunks }}块</span>
                <span class="kf-owner" :class="{ unowned: ownerLabelOf(e.id).startsWith('全局') }" :title="ownerLabelOf(e.id)">{{ ownerLabelOf(e.id) }}</span>
              </div>
              <div v-if="kbEntries.length === 0" class="mem-empty">暂无文件，点上方「上传文件」添加</div>
              <div v-else-if="kbEntries.length > 40" class="mem-empty">仅显示最近 40 个，共 {{ kbEntries.length }} 个</div>
            </div>
          </div>

          <div class="kb-group-toolbar">
            <input class="kb-grp-input" v-model="newGroupName" placeholder="新分组名..." />
            <button class="kb-grp-btn" @click="onCreateGroup" :disabled="!newGroupName.trim()">📁 新建</button>
          </div>
          <div class="kb-tree">
            <div v-for="group in knowledgeStore.knowledgeGroups" :key="group.id" class="kb-group-node">
              <div class="kb-group-header" @click="toggleKbGroup(group.id)">
                <span class="kb-group-arrow">{{ expandedGroups.has(group.id) ? '▼' : '▶' }}</span>
                <span class="kb-group-icon">📁</span>
                <span class="kb-group-name">{{ group.name }}</span>
                <span class="kb-group-meta">{{ group.sharedEntryIds.length }}共享</span>
                <button class="kb-grp-del" @click.stop="knowledgeStore.deleteGroup(group.id, memoryStore.projectMemories)">✕</button>
              </div>
              <div v-if="expandedGroups.has(group.id)" class="kb-group-children">
                <div class="kb-shared-section">
                  <span class="kb-section-label">📂 共享知识库</span>
                  <div v-for="eid in group.sharedEntryIds" :key="eid" class="kb-tree-entry">
                    <span class="kb-te-name">{{ getEntryName(eid) }}</span>
                    <button class="kb-te-del" @click="onRemoveSharedEntry(group.id, eid)">✕</button>
                  </div>
                  <div v-if="group.sharedEntryIds.length === 0" class="kb-tree-empty">暂无共享文件</div>
                </div>
                <div v-for="proj in knowledgeStore.getGroupProjects(group.id, memoryStore.projectMemories)" :key="proj.id" class="kb-proj-node">
                  <span class="kb-proj-icon">💬</span>
                  <span class="kb-proj-name">{{ proj.name }}</span>
                  <span class="kb-proj-meta">{{ proj.knowledgeEntryIds.length }}文件</span>
                </div>
              </div>
            </div>
            <div class="kb-ungrouped" v-if="ungroupedProjects.length > 0">
              <div class="kb-section-label">📌 未分组项目</div>
              <div v-for="proj in ungroupedProjects" :key="proj.id" class="kb-proj-node">
                <span class="kb-proj-icon">💬</span>
                <span class="kb-proj-name">{{ proj.name }}</span>
                <span class="kb-proj-meta">{{ proj.knowledgeEntryIds.length }}文件</span>
                <select class="kb-grp-select" @change="onAssignGroup(proj.id, ($event.target as HTMLSelectElement).value)">
                  <option value="">移入分组...</option>
                  <option v-for="g in knowledgeStore.knowledgeGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
                </select>
              </div>
            </div>
          </div>

          <div class="mem-section">
            <div class="mem-section-title">项目空间</div>
            <div class="mem-proj-list" v-if="memoryStore.projectMemories.length > 0">
              <div v-for="p in memoryStore.projectMemories" :key="p.id" class="mem-proj-item" :class="{ active: p.id === memoryStore.activeProjectId }" @click="memoryStore.setActiveProject(p.id)">
                <span class="mp-name">{{ p.name }}</span>
                <span class="mp-meta">{{ p.fileFingerprints.length }}指纹 · {{ p.knowledgeEntryIds.length }}知识{{ p.sessionIds?.length ? ` · ${p.sessionIds.length}会话` : '' }}</span>
              </div>
            </div>
            <div v-else class="mem-empty">暂无项目</div>
            <div class="mem-add-row">
              <input class="mem-add-input" v-model="newProjectName" placeholder="新建项目名..." />
              <button class="mem-add-btn" @click="onAddProject">+</button>
              <button class="mem-add-btn merge-toggle" @click="mergeOpen = !mergeOpen" title="合并多个会话与知识库，新建项目空间">⧉</button>
            </div>
            <div class="merge-panel" v-if="mergeOpen">
              <div class="merge-hint">选会话 + 选知识库 → 合并为新项目空间（原知识库保持不变）</div>
              <div class="merge-group">
                <div class="merge-label">会话 ({{ mergeSessionIds.length }})</div>
                <label v-for="s in sessionStore.sessions" :key="s.id" class="merge-item">
                  <input type="checkbox" :value="s.id" v-model="mergeSessionIds" /> {{ s.name }}
                </label>
                <div v-if="sessionStore.sessions.length === 0" class="mem-empty">暂无会话</div>
              </div>
              <div class="merge-group">
                <div class="merge-label">知识库 ({{ mergeGroupIds.length }})</div>
                <label v-for="g in knowledgeStore.knowledgeGroups" :key="g.id" class="merge-item">
                  <input type="checkbox" :value="g.id" v-model="mergeGroupIds" /> {{ g.name }} ({{ g.sharedEntryIds.length }}条)
                </label>
                <div v-if="knowledgeStore.knowledgeGroups.length === 0" class="mem-empty">暂无知识库</div>
              </div>
              <div class="merge-actions">
                <button class="merge-ok" @click="onMergeCreate" :disabled="!newProjectName.trim()">创建项目空间</button>
                <button class="merge-cancel" @click="mergeOpen = false">取消</button>
              </div>
            </div>
          </div>
        </template>

        <div v-if="kbTab === 'refs'" class="kb-ref-list">
          <div v-for="msg in dialogStore.messages.filter(m => m.role === 'user' && m.content.length > 10)" :key="msg.id" class="kb-ref-item">
            <span class="kb-ref-text">{{ msg.content.substring(0, 60) }}{{ msg.content.length > 60 ? '...' : '' }}</span>
            <span class="kb-ref-time">{{ new Date(msg.timestamp).toLocaleTimeString('zh-CN') }}</span>
          </div>
          <div v-if="dialogStore.messages.filter(m => m.role === 'user').length === 0" class="mem-empty">暂无对话引用</div>
        </div>

        <div class="kb-stats">
          <div class="kb-stat">文件: <strong>{{ kbEntries.length }}</strong></div>
          <div class="kb-stat">分组: <strong>{{ knowledgeStore.knowledgeGroups.length }}</strong></div>
          <div class="kb-stat">知识块: <strong>{{ totalChunks }}</strong></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 2026-10-01（用户裁定）：知识库管理从指令区右栏的「全屏覆盖层」提为**独立窗口**。
 *
 * 本组件是 knowledge.html 渲染进程的根组件（与 dev.html / DevConsole.vue 同一套多窗口成例）。
 * 数据来源：本窗口是独立渲染进程，有自己的 Pinia；knowledge/memory/dialog store 的权威态
 * 由主窗经 store 镜像协议（storeSyncToMain / onStoreApplyUpdate）下发，本窗只消费镜像态，
 * 变更再经 storeSyncToMain 回传主窗落盘（见 src/knowledge-main.ts）。
 *
 * 注意：这里**不**调用 memoryStore.loadFromStorage()——它会因本窗 configStore 未载入而
 * 误判 restoreSessionMemory=false，进而 pushSessionToArchive + clearSession 清空主窗会话记忆。
 */
import { ref, computed, onMounted } from 'vue'
import { useKnowledgeStore, ingestFile, getKnowledgeEntries, hybridSearch } from '@/domains/knowledge'
import { useMemoryStore } from '@/domains/memory'
import { useDialogStore } from '@/domains/dialog'
import { useSessionStore } from '@/domains/app'
import { createProjectSpace } from '@/services/projectSpace'

const knowledgeStore = useKnowledgeStore()
const memoryStore = useMemoryStore()
const dialogStore = useDialogStore()
const sessionStore = useSessionStore()

const kbEntries = ref<{ id: string; filename: string; chunks: number; createdAt: number }[]>([])
const kbTab = ref<'browse' | 'refs'>('browse')
const kbSearchQuery = ref('')
const kbSearching = ref(false)
const kbSearched = ref(false)
const kbSearchResults = ref<Array<{ score: number; text: string }>>([])
const newGroupName = ref('')
const newProjectName = ref('')
const expandedGroups = ref<Set<string>>(new Set())
const notice = ref('')
// 合并式新建项目空间（2026-10-01 用户诉求）
const mergeOpen = ref(false)
const mergeSessionIds = ref<string[]>([])
const mergeGroupIds = ref<string[]>([])

const totalChunks = computed(() => kbEntries.value.reduce((sum, e) => sum + e.chunks, 0))
const ungroupedProjects = computed(() => memoryStore.projectMemories.filter(p => !p.parentGroupId))

let noticeTimer: ReturnType<typeof setTimeout> | null = null
function showNotice(msg: string) {
  notice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 4000)
}

function refreshKbEntries() {
  kbEntries.value = getKnowledgeEntries()
}

const UPLOAD_ACCEPT = '.md,.txt,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.yaml,.yml,.toml,.ini,.cfg,.log,.sql,.sh,.bat,.ps1,.env,.gitignore,.editorconfig,.prettierrc,.eslintrc'

function onUpload() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = UPLOAD_ACCEPT
  input.onchange = async () => {
    const files = input.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      try {
        const entry = await ingestFile(file, { type: 'global' })
        showNotice(`[上传] ${file.name} → 知识库 (${entry.chunks}块)`)
      } catch {
        showNotice(`❌ 上传失败: ${file.name}`)
      }
    }
    refreshKbEntries()
  }
  input.click()
}

async function onKbSearch() {
  if (!kbSearchQuery.value.trim()) return
  kbSearching.value = true
  kbSearched.value = false
  try {
    const results = await hybridSearch(kbSearchQuery.value.trim(), 5)
    kbSearchResults.value = results.map(r => ({ score: r.score, text: r.text }))
    kbSearched.value = true
  } catch {
    showNotice('❌ 知识库搜索失败')
    kbSearched.value = true
  } finally {
    kbSearching.value = false
  }
}

function toggleKbGroup(groupId: string) {
  if (expandedGroups.value.has(groupId)) {
    expandedGroups.value.delete(groupId)
  } else {
    expandedGroups.value.add(groupId)
  }
}

function onCreateGroup() {
  if (!newGroupName.value.trim()) return
  const name = newGroupName.value.trim()
  const result = knowledgeStore.createGroup(name)
  if (!result) { showNotice('⚠️ 分组名称已存在'); return }
  newGroupName.value = ''
  showNotice(`📁 已创建分组: ${name}`)
}

function getEntryName(entryId: string): string {
  const entry = kbEntries.value.find(e => e.id === entryId)
  return entry?.filename || entryId
}

/**
 * 2026-10-01（用户反馈：上传后「不知道传到了哪个文件夹、哪个对话」）：
 * 上传走的是全局库（`ingestFile(file, { type: 'global' })`），本就不归属任何分组/会话——
 * 但界面此前只显示一个总数，用户无从判断。这里把归属显式算出来并标在文件行上。
 */
function ownerLabelOf(entryId: string): string {
  const groups = knowledgeStore.knowledgeGroups.filter(g => g.sharedEntryIds.includes(entryId))
  if (groups.length > 0) return `分组：${groups.map(g => g.name).join('、')}`
  const sessions = sessionStore.sessions.filter(s => (s.attachedEntryIds ?? []).includes(entryId))
  if (sessions.length > 0) return `会话：${sessions.map(s => s.name).join('、')}`
  return '全局（未归属分组/会话）'
}

function formatSize(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function onRemoveSharedEntry(groupId: string, entryId: string) {
  knowledgeStore.removeSharedEntryFromGroup(groupId, entryId)
}

function onAssignGroup(projectId: string, groupId: string) {
  memoryStore.setProjectGroup(projectId, groupId || undefined)
  showNotice(groupId ? '📦 已移入分组' : '📌 已移出分组')
}

function onAddProject() {
  if (!newProjectName.value.trim()) return
  const result = memoryStore.addProjectMemory(newProjectName.value.trim())
  if (!result) { showNotice('⚠️ 项目空间名称已存在'); return }
  newProjectName.value = ''
}

/**
 * 2026-10-01（用户诉求）：合并多个会话与多个知识库，新建一个项目空间。
 * 新库取所选各库条目并集，**原库保持不变**；所选会话改指新库。详见 services/projectSpace.ts。
 */
function onMergeCreate() {
  const r = createProjectSpace({
    name: newProjectName.value.trim(),
    sessionIds: mergeSessionIds.value,
    groupIds: mergeGroupIds.value
  })
  if (!r) { showNotice('⚠️ 项目空间名称已存在或无效'); return }
  showNotice(`⧉ 已建项目空间「${r.group.name}」：${r.group.sharedEntryIds.length} 条知识 · ${mergeSessionIds.value.length} 个会话`)
  newProjectName.value = ''
  mergeSessionIds.value = []
  mergeGroupIds.value = []
  mergeOpen.value = false
}

// 窗口控制走本窗（knowledge 窗口）的 IPC
function onMinimize(): void { window.electronAPI?.knowledgeWindowMinimize() }
function onMaximize(): void { window.electronAPI?.knowledgeWindowMaximize() }
function onClose(): void { window.electronAPI?.knowledgeWindowClose() }

onMounted(() => { refreshKbEntries() })
</script>

<style scoped>
.km-root { display: flex; flex-direction: column; width: 100%; height: 100%; background: #050510; color: #b8c6dd; }
.km-titlebar {
  display: flex; align-items: center; gap: 12px; padding: 6px 10px;
  background: rgba(6, 9, 20, 0.95); border-bottom: 1px solid rgba(80, 160, 255, 0.12);
  -webkit-app-region: drag;
}
.km-titlebar-text { font-size: 12px; letter-spacing: 1px; opacity: 0.85; }
.km-notice { font-size: 11px; color: #8ab4ff; -webkit-app-region: no-drag; }
.km-titlebar-actions { margin-left: auto; display: flex; gap: 2px; -webkit-app-region: no-drag; }
.km-tb-btn { background: none; border: none; color: #b8c6dd; cursor: pointer; font-size: 12px; padding: 2px 8px; border-radius: 3px; }
.km-tb-btn:hover { background: rgba(80, 160, 255, 0.12); }
.km-tb-close:hover { background: #c0392b; color: #fff; }
.km-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; scrollbar-width: thin; scrollbar-color: rgba(80, 160, 255, 0.2) transparent; }

.kb-panel { display: flex; flex-direction: column; }
.kb-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.kb-upload-btn { font-size: 9px; padding: 3px 10px; background: rgba(100,180,255,0.12); border: 1px solid rgba(100,180,255,0.2); color: #8ab4d8; border-radius: 3px; cursor: pointer; }
.kb-upload-btn:hover { background: rgba(100,180,255,0.25); }
.kb-count { font-size: 9px; color: #5a7a9a; }
.kb-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
.kb-tab { font-size: 9px; padding: 2px 10px; background: rgba(20,30,50,0.6); border: 1px solid rgba(100,180,255,0.1); color: #5a7a9a; border-radius: 2px 2px 0 0; cursor: pointer; }
.kb-tab.active { background: rgba(100,180,255,0.12); color: #b0d4f1; border-color: rgba(100,180,255,0.3); }
.kb-stats { display: flex; gap: 12px; margin-bottom: 8px; }
.kb-stat { font-size: 10px; color: #7a9cc6; }
.kb-stat strong { color: #8ab4ff; }
.kb-search-row { display: flex; gap: 4px; margin-bottom: 6px; }
.kb-search-input { flex: 1; background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #c0d8ff; font-size: 10px; padding: 3px 6px; outline: none; }
.kb-search-input:focus { border-color: rgba(100,180,255,0.4); }
.kb-search-btn { background: rgba(100,180,255,0.15); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; cursor: pointer; font-size: 10px; padding: 0 6px; }
.kb-search-btn:hover { background: rgba(100,180,255,0.25); }
.kb-search-btn:disabled { opacity: 0.4; }
.kb-search-results { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.kb-result-item { display: flex; gap: 4px; padding: 2px 4px; background: rgba(100,180,255,0.04); border-radius: 2px; font-size: 9px; }
.kb-result-score { color: #44ff88; min-width: 30px; font-weight: bold; }
.kb-result-text { color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-search-empty { padding: 8px; text-align: center; color: #5a7a9a; font-size: 10px; }
.kb-group-toolbar { display: flex; gap: 4px; margin-bottom: 6px; }
.kb-grp-input { flex: 1; padding: 2px 6px; background: rgba(100,180,255,0.06); border: 1px solid rgba(100,180,255,0.12); border-radius: 3px; color: #c0d8ff; font-size: 9px; outline: none; }
.kb-grp-input:focus { border-color: rgba(100,180,255,0.3); }
.kb-grp-input::placeholder { color: #3a5a7a; }
.kb-grp-btn { padding: 2px 8px; background: rgba(100,180,255,0.1); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #8ab4ff; font-size: 9px; cursor: pointer; }
.kb-grp-btn:hover { background: rgba(100,180,255,0.2); }
.kb-grp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 2026-10-01（用户反馈）：文件清单 —— 让用户看清「传了什么、归在哪」 */
.kb-files-section { margin-bottom: 8px; }
.kb-file-list { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow-y: auto; margin-top: 2px; }
.kb-file-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 3px; font-size: 10px; }
.kb-file-row:hover { background: rgba(100, 180, 255, 0.05); }
.kf-name { color: #c0d8f0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kf-chunks { color: #5a7a9a; font-size: 9px; flex-shrink: 0; }
.kf-owner { color: #7dcea0; font-size: 9px; flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kf-owner.unowned { color: #8a93a6; }
.kb-tree { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.kb-group-node { border: 1px solid rgba(100,180,255,0.06); border-radius: 4px; }
.kb-group-header { display: flex; align-items: center; gap: 4px; padding: 3px 6px; cursor: pointer; background: rgba(100,180,255,0.04); border-radius: 3px; }
.kb-group-header:hover { background: rgba(100,180,255,0.08); }
.kb-group-arrow { font-size: 7px; color: #5a7a9a; width: 8px; }
.kb-group-icon { font-size: 10px; }
.kb-group-name { font-size: 10px; color: #c0d8f0; flex: 1; }
.kb-group-meta { font-size: 8px; color: #5a7a9a; }
.kb-grp-del { background: none; border: none; color: #ff4444; font-size: 8px; cursor: pointer; opacity: 0.5; }
.kb-grp-del:hover { opacity: 1; }
.kb-group-children { padding-left: 14px; }
.kb-shared-section { padding: 2px 0; border-bottom: 1px solid rgba(100,180,255,0.04); }
.kb-section-label { font-size: 9px; color: #7a9cc6; padding: 2px 0; display: block; }
.kb-tree-entry { display: flex; justify-content: space-between; align-items: center; padding: 1px 4px; }
.kb-te-name { font-size: 9px; color: #a0c0e8; }
.kb-te-del { background: none; border: none; color: #ff6666; font-size: 8px; cursor: pointer; }
.kb-tree-empty { font-size: 8px; color: #5a7a9a; padding: 1px 4px; }
.kb-proj-node { display: flex; align-items: center; gap: 4px; padding: 2px 4px; }
.kb-proj-icon { font-size: 9px; }
.kb-proj-name { font-size: 9px; color: #a0c0e8; flex: 1; }
.kb-proj-meta { font-size: 8px; color: #5a7a9a; }
.kb-grp-select { background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 2px; color: #8ab4ff; font-size: 8px; padding: 0 2px; max-width: 70px; }
.kb-grp-select option { background: #0a0f1e; }
.kb-ungrouped { border-top: 1px solid rgba(100,180,255,0.06); padding-top: 4px; margin-top: 2px; }
.kb-ref-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.kb-ref-item { display: flex; justify-content: space-between; padding: 2px 6px; font-size: 9px; }
.kb-ref-text { color: #7a9cc6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.kb-ref-time { color: #5a7a9a; flex-shrink: 0; margin-left: 4px; }

.mem-section { margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(100,180,255,0.06); }
.mem-section:last-child { border-bottom: none; }
.mem-section-title { font-size: 10px; color: #8ab4ff; margin-bottom: 4px; font-weight: 600; }
.mem-proj-list { display: flex; flex-direction: column; gap: 2px; }
.mem-proj-item { display: flex; justify-content: space-between; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px; }
.mem-proj-item:hover { background: rgba(100,180,255,0.06); }
.mem-proj-item.active { background: rgba(100,180,255,0.12); }
.mp-name { color: #c0d8f0; }
.mp-meta { color: #5a7a9a; font-size: 8px; }
.mem-add-row { display: flex; gap: 4px; margin-top: 4px; }
.mem-add-input { flex: 1; min-width: 0; background: rgba(10,15,30,0.6); border: 1px solid rgba(100,180,255,0.15); border-radius: 3px; color: #c0d8ff; font-size: 10px; padding: 2px 4px; outline: none; }
.mem-add-input:focus { border-color: rgba(100,180,255,0.4); }
.mem-add-btn { background: rgba(100,180,255,0.15); border: 1px solid rgba(100,180,255,0.2); border-radius: 3px; color: #8ab4ff; cursor: pointer; font-size: 11px; padding: 0 6px; }
.mem-add-btn:hover { background: rgba(100,180,255,0.25); }
.mem-tpl-list { display: flex; flex-direction: column; gap: 2px; }
.mem-tpl-item { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px; }
.mt-name { font-size: 10px; color: #a0c0e8; }
.mt-del { background: none; border: none; color: #ff6666; cursor: pointer; font-size: 9px; }
.mem-empty { font-size: 10px; color: #5a7a9a; text-align: center; padding: 8px; }

/* 合并式新建项目空间 */
.merge-toggle { font-weight: bold; }
.merge-panel { margin-top: 6px; padding: 6px 8px; border: 1px solid rgba(100,180,255,0.15); border-radius: 4px; background: rgba(10,15,30,0.5); }
.merge-hint { font-size: 9px; color: #5a7a9a; margin-bottom: 6px; }
.merge-group { margin-bottom: 6px; max-height: 120px; overflow-y: auto; }
.merge-label { font-size: 10px; color: #8ab4ff; margin-bottom: 2px; }
.merge-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #a0c0e8; padding: 1px 2px; cursor: pointer; }
.merge-item input { accent-color: #5a9cff; }
.merge-actions { display: flex; gap: 4px; margin-top: 4px; }
.merge-ok { flex: 1; padding: 3px 8px; background: rgba(100,180,255,0.15); border: 1px solid rgba(100,180,255,0.25); border-radius: 3px; color: #8ab4ff; font-size: 10px; cursor: pointer; }
.merge-ok:hover { background: rgba(100,180,255,0.25); }
.merge-ok:disabled { opacity: 0.4; cursor: not-allowed; }
.merge-cancel { padding: 3px 10px; background: transparent; border: 1px solid rgba(150,150,150,0.2); border-radius: 3px; color: #7a8a9a; font-size: 10px; cursor: pointer; }
.merge-cancel:hover { color: #aab; }
</style>
