<template>
  <div class="feedback-chart">
    <div class="stat-row">
      <span class="stat-label">Triggers</span>
      <div class="bar-container">
        <div class="bar-fill bar-triggers" :style="{ width: triggerPercent + '%' }"></div>
      </div>
      <span class="stat-value">{{ triggerCount }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">False Positives</span>
      <div class="bar-container">
        <div class="bar-fill bar-fp" :style="{ width: fpPercent + '%' }"></div>
      </div>
      <span class="stat-value">{{ falsePositiveCount }}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">FP Rate</span>
      <div class="bar-container">
        <div class="bar-fill bar-rate" :class="{ 'rate-warning': fpRate > 20 }" :style="{ width: fpRate.toFixed(1) + '%' }"></div>
      </div>
      <span class="stat-value" :class="{ 'rate-warning-text': fpRate > 20 }">{{ fpRate.toFixed(1) }}%</span>
    </div>
    <div class="downgrade-warning" v-if="fpRate > 20">
      <span class="warning-icon">⚠</span>
      <span>FP rate exceeds 20% — auto-downgrade risk</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  triggerCount: number
  falsePositiveCount: number
}>()

const fpRate = computed(() => {
  if (props.triggerCount === 0) return 0
  return (props.falsePositiveCount / props.triggerCount) * 100
})

const maxCount = computed(() => Math.max(props.triggerCount, props.falsePositiveCount, 1))

const triggerPercent = computed(() => (props.triggerCount / maxCount.value) * 100)
const fpPercent = computed(() => (props.falsePositiveCount / maxCount.value) * 100)
</script>

<style scoped>
.feedback-chart {
  background: rgba(26, 26, 62, 0.5);
  border: 1px solid #2a2a5e;
  border-radius: 6px;
  padding: 10px 12px;
}
.stat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.stat-row:last-of-type {
  margin-bottom: 0;
}
.stat-label {
  font-size: 11px;
  color: #8888bb;
  min-width: 90px;
  flex-shrink: 0;
}
.bar-container {
  flex: 1;
  height: 6px;
  background: rgba(42, 42, 94, 0.6);
  border-radius: 3px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}
.bar-triggers {
  background: linear-gradient(90deg, #00ccff, #0088cc);
}
.bar-fp {
  background: linear-gradient(90deg, #ff6600, #cc4400);
}
.bar-rate {
  background: linear-gradient(90deg, #00cc80, #009966);
}
.bar-rate.rate-warning {
  background: linear-gradient(90deg, #ff4444, #cc2222);
}
.stat-value {
  font-size: 11px;
  color: #e0e0ff;
  min-width: 40px;
  text-align: right;
  font-family: 'Consolas', 'Courier New', monospace;
}
.rate-warning-text {
  color: #ff4444;
  font-weight: 600;
}
.downgrade-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(255, 68, 68, 0.1);
  border: 1px solid rgba(255, 68, 68, 0.2);
  border-radius: 4px;
  font-size: 11px;
  color: #ff6600;
}
.warning-icon {
  font-size: 12px;
}
</style>
