<template>
  <transition name="cmd-fade">
    <div class="cmd-palette-overlay" v-if="visible" @click.self="close">
      <div class="cmd-palette">
        <div class="cmd-input-row">
          <span class="cmd-icon">⌘</span>
          <input
            ref="inputRef"
            v-model="query"
            class="cmd-input"
            placeholder="搜索技能、设置、操作…"
            @keydown.escape="close"
            @keydown.enter="onEnter"
            @keydown.up.prevent="moveUp"
            @keydown.down.prevent="moveDown"
          />
          <span class="cmd-scope-tag" v-if="scope !== 'all'" @click="scope = 'all'">{{ scopeLabel }} ✕</span>
        </div>
        <div class="cmd-results" v-if="results.length > 0">
          <div
            v-for="(r, i) in results"
            :key="r.id"
            class="cmd-item"
            :class="{ active: i === activeIndex }"
            @click="select(i)"
            @mouseenter="activeIndex = i"
          >
            <span class="cmd-item-icon">{{ typeIcon(r.type) }}</span>
            <div class="cmd-item-text">
              <span class="cmd-item-label">{{ r.label }}</span>
              <span class="cmd-item-desc">{{ r.description }}</span>
            </div>
            <span class="cmd-item-category">{{ r.category }}</span>
          </div>
        </div>
        <div class="cmd-empty" v-else-if="query.trim()">
          <span>无匹配结果</span>
        </div>
        <div class="cmd-hints" v-else>
          <span>输入关键词搜索技能、设置或操作</span>
          <span class="cmd-hint-scopes">
            <button class="cmd-scope-btn" @click="scope = 'skills'">技能</button>
            <button class="cmd-scope-btn" @click="scope = 'settings'">设置</button>
            <button class="cmd-scope-btn" @click="scope = 'history'">历史</button>
          </span>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { search } from '@/domains/app'
import { useDialogStore } from '@/domains/dialog'
import { useConfigStore } from '@/domains/config'
import { CommandPaletteResult } from '@/models'

const visible = ref(false)
const query = ref('')
const scope = ref<'all' | 'skills' | 'settings' | 'history'>('all')
const results = ref<CommandPaletteResult[]>([])
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

const dialogStore = useDialogStore()
const configStore = useConfigStore()

const scopeLabel: Record<string, string> = {
  skills: '技能',
  settings: '设置',
  history: '历史'
}

function typeIcon(type: CommandPaletteResult['type']): string {
  switch (type) {
    case 'skill': return '⚡'
    case 'setting': return '⚙'
    case 'action': return '▶'
    case 'history': return '🕐'
    default: return '•'
  }
}

function doSearch() {
  if (!query.value.trim()) {
    results.value = []
    return
  }
  results.value = search(query.value, scope.value, dialogStore)
  activeIndex.value = 0
}

watch(query, doSearch)
watch(scope, doSearch)

function moveUp() {
  if (activeIndex.value > 0) activeIndex.value--
}
function moveDown() {
  if (activeIndex.value < results.value.length - 1) activeIndex.value++
}

function select(idx: number) {
  const item = results.value[idx]
  if (!item) return
  handleResult(item)
}

function onEnter() {
  if (results.value.length > 0) select(activeIndex.value)
}

function handleResult(r: CommandPaletteResult) {
  close()
  switch (r.type) {
    case 'skill':
      dialogStore.sendMessage(`使用技能: ${r.label}`)
      break
    case 'setting':
      if (r.id === 'setting-api') {
        window.electronAPI?.openDebugWindow?.()
      } else if (r.id === 'setting-appearance' || r.id === 'setting-notifications' || r.id === 'setting-data') {
        window.dispatchEvent(new CustomEvent('holo-open-settings', { detail: r.id.replace('setting-', '') }))
      }
      break
    case 'action':
      if (r.id === 'action-toggle-theme') {
        configStore.toggleTheme()
      } else if (r.id === 'action-toggle-mode') {
        window.dispatchEvent(new CustomEvent('holo-toggle-mode'))
      } else if (r.id === 'action-open-debug') {
        window.electronAPI?.openDebugWindow?.()
      } else if (r.id === 'action-open-benchmark') {
        window.electronAPI?.openBenchmarkWindow?.()
      } else if (r.id === 'action-open-rules') {
        window.electronAPI?.openRuleReviewWindow?.()
      } else if (r.id === 'action-open-notifications') {
        window.dispatchEvent(new CustomEvent('holo-open-notifications'))
      }
      break
    case 'history':
      dialogStore.sendMessage(r.label)
      break
  }
}

function open(initialScope: 'all' | 'skills' | 'settings' | 'history' = 'all') {
  visible.value = true
  scope.value = initialScope
  query.value = ''
  results.value = []
  activeIndex.value = 0
  nextTick(() => {
    inputRef.value?.focus()
  })
}

function close() {
  visible.value = false
  query.value = ''
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'p' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    if (visible.value) close()
    else open()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})

defineExpose({ open, close })
</script>

<style scoped>
.cmd-palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 5000;
}

.cmd-palette {
  width: 480px;
  max-height: 400px;
  background: rgba(10, 16, 32, 0.95);
  border: 1px solid rgba(100, 180, 255, 0.25);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 1px rgba(100, 180, 255, 0.3);
}

.cmd-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.12);
}

.cmd-icon {
  color: rgba(100, 180, 255, 0.5);
  font-size: 16px;
  flex-shrink: 0;
}

.cmd-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: #d0e0f0;
  font-size: 14px;
  font-family: inherit;
}

.cmd-input::placeholder {
  color: rgba(130, 170, 220, 0.35);
}

.cmd-scope-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(100, 180, 255, 0.15);
  color: #88bbff;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
}

.cmd-scope-tag:hover {
  background: rgba(100, 180, 255, 0.3);
}

.cmd-results {
  overflow-y: auto;
  max-height: 320px;
  padding: 4px 0;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.1s;
}

.cmd-item:hover,
.cmd-item.active {
  background: rgba(80, 160, 255, 0.12);
}

.cmd-item-icon {
  font-size: 14px;
  flex-shrink: 0;
  width: 20px;
  text-align: center;
}

.cmd-item-text {
  flex: 1;
  min-width: 0;
}

.cmd-item-label {
  display: block;
  font-size: 13px;
  color: #d0e0f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-item-desc {
  display: block;
  font-size: 11px;
  color: rgba(130, 170, 220, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-item-category {
  font-size: 10px;
  color: rgba(130, 170, 220, 0.4);
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(100, 180, 255, 0.06);
  flex-shrink: 0;
}

.cmd-empty,
.cmd-hints {
  padding: 24px 16px;
  text-align: center;
  color: rgba(130, 170, 220, 0.35);
  font-size: 13px;
}

.cmd-hint-scopes {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-top: 8px;
}

.cmd-scope-btn {
  padding: 3px 12px;
  border-radius: 12px;
  border: 1px solid rgba(100, 180, 255, 0.2);
  background: rgba(100, 180, 255, 0.08);
  color: #88bbff;
  font-size: 11px;
  cursor: pointer;
}

.cmd-scope-btn:hover {
  background: rgba(100, 180, 255, 0.2);
}

.cmd-fade-enter-active { transition: opacity 0.15s; }
.cmd-fade-leave-active { transition: opacity 0.1s; }
.cmd-fade-enter-from, .cmd-fade-leave-to { opacity: 0; }
</style>
