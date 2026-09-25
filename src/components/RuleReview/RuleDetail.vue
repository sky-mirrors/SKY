<template>
  <div class="rule-detail" v-if="rule">
    <div class="detail-header">
      <RuleStatusBadge :status="rule.status" />
      <span class="detail-id">{{ rule.id }}</span>
    </div>

    <div class="detail-section">
      <div class="detail-row">
        <span class="detail-label">Domain</span>
        <span class="domain-badge" :class="`domain-${rule.domain}`">{{ rule.domain }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Category</span>
        <span class="detail-value">{{ rule.category }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Severity</span>
        <span class="severity-badge" :class="`sev-${rule.severity}`">{{ rule.severity }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Confidence</span>
        <span class="confidence-badge" :class="`conf-${rule.reliability.confidence}`">{{ rule.reliability.confidence }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Automation</span>
        <span class="automation-badge" :class="`auto-${rule.automationLevel}`">{{ automationLabel }}</span>
      </div>
      <div class="detail-row" v-if="rule.humanJudgmentPrompt">
        <span class="detail-label">Prompt</span>
        <span class="detail-value prompt-value">{{ rule.humanJudgmentPrompt }}</span>
      </div>
      <div class="detail-row" v-if="rule.reliability.caveat">
        <span class="detail-label">Caveat</span>
        <span class="detail-value caveat-value">{{ rule.reliability.caveat }}</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-heading">Description</div>
      <p class="detail-description">{{ rule.description }}</p>
    </div>

    <div class="detail-section">
      <div class="section-heading">Applicability</div>
      <div class="detail-row">
        <span class="detail-label">Jurisdiction</span>
        <span class="detail-value">{{ rule.applicability.jurisdiction }}</span>
      </div>
      <div class="detail-row" v-if="rule.applicability.companySize">
        <span class="detail-label">Company Size</span>
        <span class="detail-value">{{ rule.applicability.companySize }}</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-heading">Source Citation</div>
      <RuleSourceCitation :source="rule.reliability.source" />
    </div>

    <div class="detail-section">
      <div class="section-heading">Source Details (Read-only)</div>
      <RuleEditForm :source="rule.reliability.source" />
    </div>

    <div class="detail-section" v-if="rule.testCases.length > 0">
      <div class="section-heading">Test Cases ({{ rule.testCases.length }})</div>
      <div class="test-case-list">
        <div v-for="(tc, idx) in rule.testCases" :key="idx" class="test-case-item">
          <div class="tc-header">
            <span class="tc-num">#{{ idx + 1 }}</span>
            <span class="tc-desc">{{ tc.description }}</span>
          </div>
          <div class="tc-input"><span class="tc-label">Input:</span> {{ tc.input }}</div>
          <div class="tc-expected">
            <span class="tc-label">Expected:</span>
            <span :class="tc.expectedTrigger ? 'tc-trigger' : 'tc-no-trigger'">
              {{ tc.expectedTrigger ? 'Trigger' : 'No trigger' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="detail-section" v-if="rule.reliability.source.verifiedBy">
      <div class="section-heading">Review Info</div>
      <div class="detail-row">
        <span class="detail-label">Verified By</span>
        <span class="detail-value">{{ rule.reliability.source.verifiedBy }}</span>
      </div>
      <div class="detail-row" v-if="rule.reliability.source.verifiedAt">
        <span class="detail-label">Verified At</span>
        <span class="detail-value">{{ formatDate(rule.reliability.source.verifiedAt) }}</span>
      </div>
    </div>

    <div class="detail-section">
      <div class="section-heading">Trigger Stats</div>
      <RuleFeedbackChart
        :triggerCount="rule.triggerCount"
        :falsePositiveCount="rule.falsePositiveCount"
      />
    </div>

    <div class="detail-section">
      <RuleTestPanel :ruleId="rule.id" />
    </div>

    <div class="detail-section">
      <RuleReviewForm :ruleId="rule.id" :ruleStatus="rule.status" />
    </div>
  </div>

  <div class="no-selection" v-else>
    <div class="no-selection-icon">📋</div>
    <div class="no-selection-text">Select a rule from the list to view details</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRuleStore } from '@/domains/app'
import RuleStatusBadge from './RuleStatusBadge.vue'
import RuleSourceCitation from './RuleSourceCitation.vue'
import RuleEditForm from './RuleEditForm.vue'
import RuleFeedbackChart from './RuleFeedbackChart.vue'
import RuleTestPanel from './RuleTestPanel.vue'
import RuleReviewForm from './RuleReviewForm.vue'

const ruleStore = useRuleStore()

const rule = computed(() => ruleStore.selectedRule)

const automationLabel = computed(() => {
  if (!rule.value) return ''
  switch (rule.value.automationLevel) {
    case 'full': return '全自动'
    case 'semi': return '半自动(需确认)'
    // 2026-09-25：原有一个 case 'assist'（'辅助提示'），但 Rule.automationLevel 的联合类型
    // 只有 'full' | 'semi'（models/index.ts:1055 与 :1073），该分支永远不可达 ⇒ 移除。
    // 若将来真要引入"辅助提示"档，得先在类型与数据源里把它落地，而不是只写个 case。
  }
})

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<style scoped>
.rule-detail {
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}
.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid #2a2a5e;
}
.detail-id {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0ff;
  font-family: 'Consolas', 'Courier New', monospace;
}
.detail-section {
  margin-bottom: 14px;
}
.section-heading {
  font-size: 11px;
  color: #00ccff;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 11px;
}
.detail-label {
  color: #8888bb;
  min-width: 90px;
  flex-shrink: 0;
}
.detail-value {
  color: #e0e0ff;
}
.caveat-value {
  font-style: italic;
  color: #ffaa00;
}
.domain-badge {
  font-size: 9px;
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
.severity-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.sev-info {
  background: rgba(80, 140, 255, 0.12);
  color: #6699ff;
}
.sev-warning {
  background: rgba(255, 170, 0, 0.12);
  color: #ffaa00;
}
.sev-error {
  background: rgba(255, 68, 68, 0.12);
  color: #ff4444;
}
.confidence-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.conf-high {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
}
.conf-medium {
  background: rgba(255, 204, 0, 0.12);
  color: #ffcc00;
}
.conf-low {
  background: rgba(255, 68, 68, 0.12);
  color: #ff4444;
}
.automation-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.auto-full {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
}
.auto-semi {
  background: rgba(255, 200, 50, 0.12);
  color: #ffc832;
}
.auto-assist {
  background: rgba(0, 180, 255, 0.12);
  color: #00b4ff;
}
.prompt-value {
  font-style: italic;
  color: #00b4ff;
}
.detail-description {
  font-size: 12px;
  color: #b0b0dd;
  line-height: 1.6;
  margin: 0;
}
.test-case-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.test-case-item {
  padding: 6px 8px;
  background: rgba(13, 13, 43, 0.6);
  border: 1px solid #2a2a5e;
  border-radius: 4px;
  font-size: 11px;
}
.tc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.tc-num {
  color: #8888bb;
  font-size: 10px;
  font-weight: 600;
}
.tc-desc {
  color: #e0e0ff;
}
.tc-input {
  color: #b0b0dd;
  margin-bottom: 2px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 10px;
}
.tc-label {
  color: #8888bb;
}
.tc-expected {
  font-size: 10px;
}
.tc-trigger {
  color: #ff4444;
}
.tc-no-trigger {
  color: #00cc80;
}
.no-selection {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
}
.no-selection-icon {
  font-size: 32px;
  opacity: 0.4;
}
.no-selection-text {
  font-size: 13px;
  color: #8888bb;
}
</style>
