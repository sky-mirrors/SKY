<template>
  <div class="source-citation">
    <div class="source-header">
      <span class="source-type-badge" :class="`type-${source.type}`">{{ source.type.replace(/_/g, ' ') }}</span>
      <span class="source-name">{{ source.name }}</span>
    </div>
    <div class="source-meta">
      <div class="meta-row" v-if="source.article">
        <span class="meta-label">Article</span>
        <span class="meta-value">{{ source.article }}</span>
      </div>
      <div class="meta-row" v-if="source.effectiveDate">
        <span class="meta-label">Effective Date</span>
        <span class="meta-value">{{ source.effectiveDate }}</span>
      </div>
      <div class="meta-row verification-row">
        <span class="meta-label">Verification</span>
        <span class="meta-value" :class="isVerified ? 'verified' : 'pending'">
          <span v-if="isVerified" class="verify-icon">✓</span>
          <span v-else class="verify-icon pending-icon">⏳</span>
          {{ isVerified ? `Verified by ${source.verifiedBy}` : 'Pending review' }}
        </span>
      </div>
    </div>
    <div class="original-text-section" v-if="source.originalText">
      <button class="toggle-text-btn" @click="showText = !showText">
        {{ showText ? 'Hide' : 'Show' }} Original Text
      </button>
      <div class="original-text-content" v-if="showText">
        <p>{{ source.originalText }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ConstraintSource } from '@/models'

const props = defineProps<{
  source: ConstraintSource
}>()

const showText = ref(false)

const isVerified = computed(() => !!props.source.verifiedBy && !!props.source.verifiedAt)
</script>

<style scoped>
.source-citation {
  background: rgba(26, 26, 62, 0.5);
  border: 1px solid #2a2a5e;
  border-radius: 6px;
  padding: 10px 12px;
}
.source-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.source-type-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.type-law {
  background: rgba(80, 140, 255, 0.15);
  color: #6699ff;
  border: 1px solid rgba(80, 140, 255, 0.25);
}
.type-regulation {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
  border: 1px solid rgba(0, 204, 128, 0.25);
}
.type-standard {
  background: rgba(255, 170, 0, 0.12);
  color: #ffaa00;
  border: 1px solid rgba(255, 170, 0, 0.25);
}
.type-judicial_interpretation {
  background: rgba(180, 120, 255, 0.12);
  color: #b088e0;
  border: 1px solid rgba(180, 120, 255, 0.25);
}
.source-name {
  font-size: 13px;
  color: #e0e0ff;
  font-weight: 500;
}
.source-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.meta-label {
  color: #8888bb;
  min-width: 80px;
  flex-shrink: 0;
}
.meta-value {
  color: #e0e0ff;
}
.meta-value.verified {
  color: #00cc80;
}
.meta-value.pending {
  color: #ffaa00;
}
.verify-icon {
  margin-right: 4px;
}
.pending-icon {
  font-size: 10px;
}
.original-text-section {
  margin-top: 8px;
  border-top: 1px solid #2a2a5e;
  padding-top: 8px;
}
.toggle-text-btn {
  font-size: 10px;
  padding: 2px 8px;
  background: rgba(0, 204, 255, 0.08);
  border: 1px solid rgba(0, 204, 255, 0.2);
  border-radius: 3px;
  color: #00ccff;
  cursor: pointer;
  transition: all 0.2s;
}
.toggle-text-btn:hover {
  background: rgba(0, 204, 255, 0.16);
}
.original-text-content {
  margin-top: 6px;
  padding: 8px;
  background: rgba(13, 13, 43, 0.6);
  border: 1px solid #2a2a5e;
  border-radius: 4px;
}
.original-text-content p {
  font-size: 11px;
  color: #b0b0dd;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
}
</style>
