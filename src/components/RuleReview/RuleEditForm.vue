<template>
  <div class="edit-form" v-if="source">
    <h4 class="section-title">Source Details</h4>
    <div class="field-row">
      <span class="field-label">Source Name</span>
      <span class="field-value">{{ source.name }}</span>
    </div>
    <div class="field-row">
      <span class="field-label">Article</span>
      <span class="field-value">{{ source.article }}</span>
    </div>
    <div class="field-row">
      <span class="field-label">Effective Date</span>
      <span class="field-value">{{ source.effectiveDate }}</span>
    </div>
    <div class="field-row" v-if="source.originalText">
      <span class="field-label">Original Text</span>
      <span class="field-value original-text">{{ source.originalText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConstraintSource } from '@/models'

defineProps<{
  source?: ConstraintSource
}>()
</script>

<style scoped>
.edit-form {
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
.field-row {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
}
.field-label {
  color: #8888bb;
  min-width: 90px;
  flex-shrink: 0;
}
.field-value {
  color: #e0e0ff;
}
.original-text {
  white-space: pre-wrap;
  line-height: 1.5;
}
</style>
