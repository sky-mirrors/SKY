<template>
  <div class="dev-console">
    <header class="dev-titlebar">
      <span class="dev-titlebar-text">🛠 SKY 开发者端</span>
      <nav class="dev-tabs">
        <button
          v-for="t in TABS"
          :key="t.id"
          class="dev-tab"
          :class="{ active: active === t.id }"
          @click="active = t.id"
        >{{ t.icon }} {{ t.label }}</button>
      </nav>
      <div class="dev-titlebar-actions">
        <button class="dev-tb-btn" @click="onMinimize" title="最小化">─</button>
        <button class="dev-tb-btn" @click="onMaximize" title="最大化/还原">□</button>
        <button class="dev-tb-btn dev-tb-close" @click="onClose" title="关闭">✕</button>
      </div>
    </header>

    <div class="dev-body">
      <!-- v-show 而非 v-if：切换 tab 不重建页面（各页带自己的轮询/订阅，重建代价高） -->
      <DebugWindowPage v-show="active === 'debug'" class="dev-pane" />
      <BenchmarkPage v-show="active === 'bench'" class="dev-pane" />
      <RuleReviewPage v-show="active === 'rule'" class="dev-pane" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import DebugWindowPage from '@/components/DebugWindowPage.vue'
import BenchmarkPage from '@/components/BenchmarkPage.vue'
import RuleReviewPage from '@/components/RuleReview/RuleReviewPage.vue'

/**
 * 2026-10-01：开发者端 = 把「调试中心 / 压测台 / 规则审核」三个独立窗口合并到一个窗口里，
 * 按用户裁定「管线编辑器不进开发者端」（它仍保留独立窗口）。
 * 三页组件在这里直接复用——它们本来各自就是独立渲染进程的根组件，语义上等同"一个窗口里放三页"。
 */
const TABS = [
  { id: 'debug', icon: '🔍', label: '调试中心' },
  { id: 'bench', icon: '📊', label: '压测台' },
  { id: 'rule', icon: '⚖️', label: '规则审核' }
] as const

const active = ref<(typeof TABS)[number]['id']>('debug')

// 窗口控制走本窗（dev 窗口）的 IPC。内嵌页面自带的 .titlebar-actions 已在下方 CSS 隐藏——
// 它们绑的是各自窗口的 IPC（debugWindowMinimize / ruleReviewWindowClose …），在此窗口里点了无效。
function onMinimize(): void { window.electronAPI?.devWindowMinimize() }
function onMaximize(): void { window.electronAPI?.devWindowMaximize() }
function onClose(): void { window.electronAPI?.devWindowClose() }
</script>

<style scoped>
.dev-console { display: flex; flex-direction: column; width: 100%; height: 100%; background: #050510; color: #b8c6dd; }
.dev-titlebar {
  display: flex; align-items: center; gap: 12px; padding: 6px 10px;
  background: rgba(6, 9, 20, 0.95); border-bottom: 1px solid rgba(80, 160, 255, 0.12);
  -webkit-app-region: drag;
}
.dev-titlebar-text { font-size: 12px; letter-spacing: 1px; opacity: 0.85; }
.dev-tabs { display: flex; gap: 4px; -webkit-app-region: no-drag; }
.dev-tab { background: none; border: 1px solid transparent; color: #b8c6dd; cursor: pointer; font-size: 12px; padding: 2px 10px; border-radius: 4px; }
.dev-tab:hover { background: rgba(80, 160, 255, 0.07); }
.dev-tab.active { background: rgba(80, 160, 255, 0.12); border-color: rgba(80, 160, 255, 0.25); }
.dev-titlebar-actions { margin-left: auto; display: flex; gap: 2px; -webkit-app-region: no-drag; }
.dev-tb-btn { background: none; border: none; color: #b8c6dd; cursor: pointer; font-size: 12px; padding: 2px 8px; border-radius: 3px; }
.dev-tb-btn:hover { background: rgba(80, 160, 255, 0.12); }
.dev-tb-close:hover { background: #c0392b; color: #fff; }
.dev-body { flex: 1; min-height: 0; position: relative; }
.dev-pane { position: absolute; inset: 0; }

/* 三个页面（Debug / Benchmark / RuleReview）的窗口控制按钮统一在 .titlebar-actions 下，一处覆盖三处 */
.dev-body :deep(.titlebar-actions) { display: none !important; }
</style>
