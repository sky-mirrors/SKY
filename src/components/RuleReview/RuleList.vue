<template>
  <div class="rule-list">
    <div class="list-filters">
      <select class="filter-select" :value="ruleStore.filterDomain" @change="onDomainChange">
        <option value="all">All Domains</option>
        <option value="finance">Finance</option>
        <option value="legal">Legal</option>
        <option value="geotech">岩土</option>
      </select>
      <select class="filter-select" :value="ruleStore.filterStatus" @change="onStatusChange">
        <option value="all">All Status</option>
        <option value="draft">Draft</option>
        <option value="testing">Testing</option>
        <option value="reviewed">Reviewed</option>
        <option value="active">Active</option>
        <option value="deprecated">Deprecated</option>
      </select>
      <select class="filter-select" :value="ruleStore.filterConfidence" @change="onConfidenceChange">
        <option value="all">All Confidence</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </div>
    <div class="list-count">{{ ruleStore.filteredRules.length }} rules</div>
    <div class="list-items">
      <div
        v-for="rule in ruleStore.filteredRules"
        :key="rule.id"
        class="rule-item"
        :class="{ selected: rule.id === ruleStore.selectedRuleId }"
        @click="ruleStore.selectRule(rule.id)"
      >
        <div class="rule-item-top">
          <span class="rule-id">{{ rule.id }}</span>
          <span class="domain-badge" :class="`domain-${rule.domain}`">{{ rule.domain }}</span>
          <RuleStatusBadge :status="rule.status" />
        </div>
        <div class="rule-item-category">{{ rule.category }}</div>
        <div class="rule-item-desc">{{ truncate(rule.description, 80) }}</div>
        <div class="rule-item-bottom">
          <span class="confidence-badge" :class="`conf-${rule.reliability.confidence}`">
            {{ rule.reliability.confidence }}
          </span>
        </div>
      </div>
      <div class="empty-state" v-if="ruleStore.filteredRules.length === 0">
        No rules match the current filters
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRuleStore } from '@/domains/app'
import RuleStatusBadge from './RuleStatusBadge.vue'
import type { RuleStatus } from '@/models'

const ruleStore = useRuleStore()

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

function onDomainChange(e: Event) {
  ruleStore.setFilterDomain((e.target as HTMLSelectElement).value as 'all' | 'finance' | 'legal' | 'geotech')
}

function onStatusChange(e: Event) {
  ruleStore.setFilterStatus((e.target as HTMLSelectElement).value as 'all' | RuleStatus)
}

function onConfidenceChange(e: Event) {
  ruleStore.setFilterConfidence((e.target as HTMLSelectElement).value as 'all' | 'high' | 'medium' | 'low')
}
</script>

<style scoped>
.rule-list {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.list-filters {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid #2a2a5e;
  flex-shrink: 0;
}
.filter-select {
  flex: 1;
  background: #0d0d2b;
  border: 1px solid #2a2a5e;
  border-radius: 4px;
  padding: 4px 6px;
  color: #e0e0ff;
  font-size: 11px;
  outline: none;
  cursor: pointer;
}
.filter-select:focus {
  border-color: #00ccff;
}
.filter-select option {
  background: #0d0d2b;
  color: #e0e0ff;
}
.list-count {
  padding: 4px 10px;
  font-size: var(--font-sm);
  color: #8888bb;
  border-bottom: 1px solid #2a2a5e;
  flex-shrink: 0;
}
.list-items {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.rule-item {
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  margin-bottom: 4px;
}
.rule-item:hover {
  background: rgba(0, 204, 255, 0.04);
  border-color: rgba(0, 204, 255, 0.12);
}
.rule-item.selected {
  background: rgba(0, 204, 255, 0.08);
  border-color: rgba(0, 204, 255, 0.25);
}
.rule-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.rule-id {
  font-size: 11px;
  font-family: 'Consolas', 'Courier New', monospace;
  color: #8888bb;
}
.domain-badge {
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.domain-finance {
  background: rgba(0, 204, 255, 0.12);
  color: #00ccff;
  border: 1px solid rgba(0, 204, 255, 0.25);
}
.domain-legal {
  background: rgba(180, 120, 255, 0.12);
  color: #b088e0;
  border: 1px solid rgba(180, 120, 255, 0.25);
}
.domain-hr {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
  border: 1px solid rgba(0, 204, 128, 0.25);
}
.rule-item-category {
  font-size: var(--font-sm);
  color: #8888bb;
  margin-bottom: 2px;
}
.rule-item-desc {
  font-size: 11px;
  color: #b0b0dd;
  line-height: 1.4;
  margin-bottom: 4px;
}
.rule-item-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
}
.confidence-badge {
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.conf-high {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
  border: 1px solid rgba(0, 204, 128, 0.25);
}
.conf-medium {
  background: rgba(255, 204, 0, 0.12);
  color: #ffcc00;
  border: 1px solid rgba(255, 204, 0, 0.25);
}
.conf-low {
  background: rgba(255, 68, 68, 0.12);
  color: #ff4444;
  border: 1px solid rgba(255, 68, 68, 0.25);
}
.empty-state {
  text-align: center;
  padding: 24px 12px;
  font-size: 12px;
  color: #8888bb;
}
</style>
