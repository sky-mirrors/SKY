<template>
  <div class="test-panel">
    <h4 class="section-title">Rule Testing</h4>
    <div class="test-input-section">
      <textarea
        class="test-input"
        v-model="testInput"
        placeholder="Enter text to test against this rule..."
        rows="4"
      ></textarea>
      <button class="test-btn" @click="runTest" :disabled="!testInput.trim()">
        Run Test
      </button>
    </div>
    <div class="test-result" v-if="testResult">
      <div class="result-header">
        <span class="result-triggered" :class="testResult.triggered ? 'triggered' : 'not-triggered'">
          {{ testResult.triggered ? 'Triggered' : 'Not Triggered' }}
        </span>
        <span class="result-severity" :class="`sev-${testResult.severity}`">{{ testResult.severity }}</span>
      </div>
      <div class="result-message" v-if="testResult.message">{{ testResult.message }}</div>
      <div class="result-reliability" v-if="testResult.reliability">
        <span class="meta-label">Confidence:</span>
        <span class="confidence-val" :class="`conf-${testResult.reliability.confidence}`">{{ testResult.reliability.confidence }}</span>
        <span class="meta-label" style="margin-left: 10px;">Source:</span>
        <span class="meta-value">{{ testResult.reliability.source.name }}</span>
      </div>
    </div>
    <div class="divider"></div>
    <div class="batch-section">
      <button class="batch-btn" @click="runAllTests">
        Run All Test Cases
      </button>
      <div class="batch-results" v-if="batchResult">
        <div class="batch-summary">
          <span class="batch-pass">{{ batchResult.passed }} passed</span>
          <span class="batch-sep">/</span>
          <span class="batch-fail" v-if="batchResult.failed > 0">{{ batchResult.failed }} failed</span>
          <span class="batch-fail-zero" v-else>{{ batchResult.failed }} failed</span>
        </div>
        <div class="batch-details">
          <div
            v-for="(r, idx) in batchResult.results"
            :key="idx"
            class="batch-item"
            :class="{ 'item-pass': r.passed, 'item-fail': !r.passed }"
          >
            <span class="batch-icon">{{ r.passed ? '✓' : '✗' }}</span>
            <span class="batch-desc">{{ r.description }}</span>
            <span class="batch-expected">expected: {{ r.expected ? 'trigger' : 'no trigger' }}</span>
            <span class="batch-actual">actual: {{ r.actual ? 'trigger' : 'no trigger' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRuleStore } from '@/domains/app'
import type { ConstraintResult } from '@/models'

const props = defineProps<{
  ruleId: string
}>()

const ruleStore = useRuleStore()

const testInput = ref('')
const testResult = ref<ConstraintResult | null>(null)

interface BatchResult {
  passed: number
  failed: number
  results: { description: string; passed: boolean; actual: boolean; expected: boolean }[]
}

const batchResult = ref<BatchResult | null>(null)

function runTest() {
  if (!testInput.value.trim()) return
  testResult.value = ruleStore.runTestOnRule(props.ruleId, testInput.value)
}

function runAllTests() {
  batchResult.value = ruleStore.runAllTestCases(props.ruleId)
}
</script>

<style scoped>
.test-panel {
  background: rgba(26, 26, 62, 0.5);
  border: 1px solid #2a2a5e;
  border-radius: 6px;
  padding: 10px 12px;
}
.section-title {
  font-size: 12px;
  color: #e0e0ff;
  font-weight: 600;
  margin: 0 0 8px;
}
.test-input-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.test-input {
  width: 100%;
  background: #0d0d2b;
  border: 1px solid #2a2a5e;
  border-radius: 4px;
  padding: 8px;
  color: #e0e0ff;
  font-size: 11px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  font-family: 'Consolas', 'Courier New', monospace;
}
.test-input:focus {
  border-color: #00ccff;
}
.test-btn {
  align-self: flex-end;
  padding: 5px 14px;
  background: rgba(0, 204, 255, 0.12);
  border: 1px solid rgba(0, 204, 255, 0.3);
  border-radius: 4px;
  color: #00ccff;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.test-btn:hover:not(:disabled) {
  background: rgba(0, 204, 255, 0.22);
}
.test-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.test-result {
  margin-top: 8px;
  padding: 8px;
  background: rgba(13, 13, 43, 0.6);
  border: 1px solid #2a2a5e;
  border-radius: 4px;
}
.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.result-triggered {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
}
.result-triggered.triggered {
  background: rgba(255, 68, 68, 0.12);
  color: #ff4444;
  border: 1px solid rgba(255, 68, 68, 0.25);
}
.result-triggered.not-triggered {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
  border: 1px solid rgba(0, 204, 128, 0.25);
}
.result-severity {
  font-size: 10px;
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
.result-message {
  font-size: 11px;
  color: #b0b0dd;
  margin-bottom: 4px;
}
.result-reliability {
  font-size: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.meta-label {
  color: #8888bb;
}
.meta-value {
  color: #e0e0ff;
}
.confidence-val {
  font-weight: 600;
}
.conf-high { color: #00cc80; }
.conf-medium { color: #ffcc00; }
.conf-low { color: #ff4444; }
.divider {
  height: 1px;
  background: #2a2a5e;
  margin: 10px 0;
}
.batch-section {
  margin-top: 0;
}
.batch-btn {
  padding: 5px 14px;
  background: rgba(0, 204, 128, 0.12);
  border: 1px solid rgba(0, 204, 128, 0.3);
  border-radius: 4px;
  color: #00cc80;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.batch-btn:hover {
  background: rgba(0, 204, 128, 0.22);
}
.batch-results {
  margin-top: 8px;
}
.batch-summary {
  font-size: 12px;
  margin-bottom: 6px;
}
.batch-pass {
  color: #00cc80;
  font-weight: 600;
}
.batch-sep {
  color: #8888bb;
  margin: 0 2px;
}
.batch-fail {
  color: #ff4444;
  font-weight: 600;
}
.batch-fail-zero {
  color: #00cc80;
}
.batch-details {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.batch-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 3px 6px;
  border-radius: 3px;
}
.item-pass {
  background: rgba(0, 204, 128, 0.05);
}
.item-fail {
  background: rgba(255, 68, 68, 0.05);
}
.batch-icon {
  font-size: 11px;
  flex-shrink: 0;
}
.item-pass .batch-icon { color: #00cc80; }
.item-fail .batch-icon { color: #ff4444; }
.batch-desc {
  color: #e0e0ff;
  flex: 1;
}
.batch-expected,
.batch-actual {
  font-size: 9px;
  color: #8888bb;
}
</style>
