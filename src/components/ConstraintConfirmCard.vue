<template>
  <div class="constraint-confirm-card" :class="[`level-${automationLevel}`]">
    <div class="card-header">
      <span class="level-badge" :class="automationLevel">{{ levelLabel }}</span>
      <span class="constraint-id">{{ constraintId }}</span>
    </div>
    <div class="card-body">
      <p class="message">{{ message }}</p>
      <p v-if="lawReference" class="law-ref">📜 {{ lawReference }}</p>
      <p v-if="humanJudgmentPrompt" class="prompt">❓ {{ humanJudgmentPrompt }}</p>
    </div>
    <div class="card-actions">
      <template v-if="automationLevel === 'semi'">
        <button class="btn btn-confirm" @click="$emit('confirm')">✓ 确认合规</button>
        <button class="btn btn-violate" @click="$emit('violate')">✗ 标记违规</button>
        <button class="btn btn-dismiss" @click="$emit('dismiss')">⊘ 忽略</button>
      </template>
      <template v-else>
        <button class="btn btn-dismiss" @click="$emit('dismiss')">已阅</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  constraintId: string
  message: string
  automationLevel: 'full' | 'semi' | 'assist'
  humanJudgmentPrompt?: string
  lawReference?: string
}>()

defineEmits<{
  confirm: []
  violate: []
  dismiss: []
}>()

const levelLabel = computed(() => {
  switch (props.automationLevel) {
    case 'full': return '自动'
    case 'semi': return '待确认'
    case 'assist': return '提示'
  }
})
</script>

<style scoped>
.constraint-confirm-card {
  border-radius: 8px;
  padding: 12px 16px;
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.5;
}
.level-full {
  background: rgba(0, 204, 100, 0.08);
  border: 1px solid rgba(0, 204, 100, 0.3);
}
.level-semi {
  background: rgba(255, 200, 50, 0.08);
  border: 1px solid rgba(255, 200, 50, 0.3);
}
.level-assist {
  background: rgba(0, 180, 255, 0.08);
  border: 1px solid rgba(0, 180, 255, 0.3);
}
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.level-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.level-badge.full { background: rgba(0, 204, 100, 0.6); }
.level-badge.semi { background: rgba(255, 200, 50, 0.6); color: #000; }
.level-badge.assist { background: rgba(0, 180, 255, 0.6); }
.constraint-id {
  font-family: monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}
.card-body p {
  margin: 4px 0;
}
.message {
  color: rgba(255, 255, 255, 0.9);
}
.law-ref {
  color: rgba(255, 200, 50, 0.8);
  font-size: 12px;
}
.prompt {
  color: rgba(0, 180, 255, 0.9);
  font-size: 12px;
  font-weight: 500;
}
.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.btn {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.btn-confirm {
  border-color: rgba(0, 204, 100, 0.5);
  color: rgba(0, 204, 100, 0.9);
}
.btn-confirm:hover {
  background: rgba(0, 204, 100, 0.15);
}
.btn-violate {
  border-color: rgba(255, 60, 60, 0.5);
  color: rgba(255, 60, 60, 0.9);
}
.btn-violate:hover {
  background: rgba(255, 60, 60, 0.15);
}
.btn-dismiss {
  border-color: rgba(255, 255, 255, 0.15);
}
</style>
