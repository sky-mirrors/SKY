<template>
  <div class="rule-review-page">
    <header class="page-header">
      <h1 class="page-title">Rule Review Panel</h1>
      <div class="header-stats">
        <span class="stat-chip" v-for="(stat, domain) in ruleStore.statsByDomain" :key="domain">
          <span class="stat-domain" :class="`domain-${domain}`">{{ domain }}</span>
          <span class="stat-counts">{{ stat.active }}/{{ stat.total }} active</span>
        </span>
      </div>
      <!-- P1-37：无边框窗口补窗口控制（复制 DebugWindowPage 模式） -->
      <div class="titlebar-actions">
        <button class="tb-btn" @click="onMinimize" title="最小化">─</button>
        <button class="tb-btn" @click="onMaximize" title="最大化/还原">□</button>
        <button class="tb-btn tb-close" @click="onClose" title="关闭">✕</button>
      </div>
    </header>
    <div class="page-body">
      <aside class="sidebar">
        <RuleList />
      </aside>
      <main class="main-content">
        <RuleDetail />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRuleStore } from '@/domains/app'
import RuleList from './RuleList.vue'
import RuleDetail from './RuleDetail.vue'

const ruleStore = useRuleStore()

function onMinimize() {
  window.electronAPI?.ruleReviewWindowMinimize()
}

function onMaximize() {
  window.electronAPI?.ruleReviewWindowMaximize()
}

function onClose() {
  window.electronAPI?.ruleReviewWindowClose()
}

onMounted(() => {
  ruleStore.loadRules()
})
</script>

<style scoped>
.rule-review-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d0d2b;
  color: #e0e0ff;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: rgba(13, 13, 43, 0.8);
  border-bottom: 1px solid #2a2a5e;
  flex-shrink: 0;
  /* P1-37：无边框窗口拖拽区 */
  -webkit-app-region: drag;
  user-select: none;
}
.titlebar-actions {
  display: flex;
  gap: 2px;
  -webkit-app-region: no-drag;
}
.tb-btn {
  width: 28px;
  height: 24px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: #8888bb;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.tb-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e0e0ff;
}
.tb-close:hover {
  background: rgba(220, 60, 60, 0.5);
  color: #fff;
}
.page-title {
  font-size: 16px;
  font-weight: 600;
  color: #e0e0ff;
  margin: 0;
  letter-spacing: 0.3px;
}
.header-stats {
  display: flex;
  gap: 8px;
}
.stat-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-sm);
  padding: 2px 8px;
  background: rgba(26, 26, 62, 0.6);
  border: 1px solid #2a2a5e;
  border-radius: 3px;
}
.stat-domain {
  font-weight: 600;
  text-transform: uppercase;
}
.domain-finance { color: #00ccff; }
.domain-legal { color: #b088e0; }
.domain-hr { color: #00cc80; }
.stat-counts {
  color: #8888bb;
}
.page-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.sidebar {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid #2a2a5e;
  background: rgba(13, 13, 43, 0.4);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
