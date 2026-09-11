<template>
  <div class="zol-widget" @click="expanded = !expanded">
    <div class="zol-hud">
      <span class="zol-label">ZOL</span>
      <span class="zol-rate" :class="rateClass">{{ (successRate * 100).toFixed(0) }}%</span>
      <div class="zol-bar-container">
        <div class="zol-bar" :style="{ width: (successRate * 100) + '%' }"></div>
      </div>
      <span class="zol-spend" v-if="budgetMode !== 'standard'">¥{{ spent }}</span>
    </div>
    <div v-if="expanded" class="zol-detail" @click.stop>
      <div class="zol-section">
        <div class="zol-section-title">学习器</div>
        <div class="zol-learner-row" v-for="l in learners" :key="l.name">
          <span class="zl-name">{{ l.name }}</span>
          <span class="zl-count">{{ l.outcomeCount }}次</span>
          <span class="zl-rate" :class="rateClassFor(l.recentSuccessRate)">{{ (l.recentSuccessRate * 100).toFixed(0) }}%</span>
        </div>
      </div>
      <div class="zol-section" v-if="Object.keys(domainOffsets).length > 0">
        <div class="zol-section-title">领域偏移</div>
        <div class="zol-offset-row" v-for="(offsets, domain) in domainOffsets" :key="domain">
          <span class="zo-domain">{{ domain }}</span>
          <span class="zo-values">{{ formatOffsets(offsets) }}</span>
        </div>
      </div>
      <div class="zol-actions">
        <button class="zol-btn" @click="onReset">重置ZOL</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { getZOLState, resetZOL, DOMAIN_REWRITE_OFFSETS, DOMAIN_DISAMBIG_OFFSETS, getRoutingZOLState, DOMAIN_ROUTING_TIER_BIAS, getBudgetMode, getSessionSpent } from '@/kernel'

const expanded = ref(false)

const learners = computed(() => {
  const rewrite = getZOLState().rewrite
  const disambig = getZOLState().disambig
  const routing = getRoutingZOLState()
  return [
    { name: '改写', outcomeCount: rewrite.outcomeCount, recentSuccessRate: rewrite.recentSuccessRate },
    { name: '消歧', outcomeCount: disambig.outcomeCount, recentSuccessRate: disambig.recentSuccessRate },
    { name: '路由', outcomeCount: routing.outcomeCount, recentSuccessRate: routing.recentSuccessRate },
  ]
})

const successRate = computed(() => {
  const ls = learners.value
  return ls.length > 0 ? ls.reduce((s, l) => s + l.recentSuccessRate, 0) / ls.length : 0.5
})

const rateClass = computed(() => {
  if (successRate.value >= 0.9) return 'rate-good'
  if (successRate.value >= 0.7) return 'rate-ok'
  return 'rate-bad'
})

function rateClassFor(rate: number) {
  if (rate >= 0.9) return 'rate-good'
  if (rate >= 0.7) return 'rate-ok'
  return 'rate-bad'
}

const domainOffsets = computed(() => {
  const merged: Record<string, Record<string, number>> = {}
  for (const [domain, offsets] of Object.entries(DOMAIN_REWRITE_OFFSETS)) {
    if (!merged[domain]) merged[domain] = {}
    Object.assign(merged[domain], offsets)
  }
  for (const [domain, offsets] of Object.entries(DOMAIN_DISAMBIG_OFFSETS)) {
    if (!merged[domain]) merged[domain] = {}
    Object.assign(merged[domain], offsets)
  }
  for (const [domain, bias] of Object.entries(DOMAIN_ROUTING_TIER_BIAS)) {
    if (!merged[domain]) merged[domain] = {}
    merged[domain]['tierBias'] = bias
  }
  return merged
})

const budgetMode = computed(() => getBudgetMode())
const spent = computed(() => getSessionSpent().toFixed(4))

function formatOffsets(offsets: Record<string, number>): string {
  return Object.entries(offsets).map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`).join(' ')
}

function onReset() {
  resetZOL()
  expanded.value = false
}
</script>

<style scoped>
.zol-widget { position: relative; font-size: 10px; cursor: pointer; }
.zol-hud { display: flex; align-items: center; gap: 4px; padding: 2px 6px; background: rgba(10,15,30,0.7); border-radius: 3px; border: 1px solid rgba(100,180,255,0.15); }
.zol-label { color: #6a8caa; font-weight: 600; }
.zol-rate { font-weight: 700; min-width: 28px; text-align: right; }
.rate-good { color: #4caf50; }
.rate-ok { color: #ff9800; }
.rate-bad { color: #f44336; }
.zol-bar-container { width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; }
.zol-bar { height: 100%; background: #4caf50; border-radius: 2px; transition: width 0.3s; }
.zol-spend { color: #ff9800; font-family: monospace; }
.zol-detail { position: absolute; bottom: 100%; right: 0; margin-bottom: 4px; width: 220px; background: rgba(10,15,30,0.95); border: 1px solid rgba(100,180,255,0.2); border-radius: 4px; padding: 8px; z-index: 100; }
.zol-section { margin-bottom: 6px; }
.zol-section-title { color: #8ab4ff; font-weight: 600; margin-bottom: 3px; border-bottom: 1px solid rgba(100,180,255,0.1); padding-bottom: 2px; }
.zol-learner-row { display: flex; justify-content: space-between; padding: 1px 0; }
.zl-name { color: #a0c0e8; }
.zl-count { color: #6a8caa; }
.zl-rate { font-weight: 600; }
.zol-offset-row { display: flex; gap: 4px; padding: 1px 0; }
.zo-domain { color: #8ab4ff; min-width: 36px; }
.zo-values { color: #a0c0e8; font-family: monospace; font-size: 9px; }
.zol-actions { text-align: right; }
.zol-btn { padding: 2px 6px; background: rgba(255,100,100,0.15); border: 1px solid rgba(255,100,100,0.3); border-radius: 2px; color: #ff8888; font-size: 9px; cursor: pointer; }
.zol-btn:hover { background: rgba(255,100,100,0.25); }
</style>
