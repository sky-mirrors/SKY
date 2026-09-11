<template>
  <span class="status-badge" :class="`status-${status}`">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { RuleStatus } from '@/models'

const props = defineProps<{
  status: RuleStatus
}>()

const labelMap: Record<RuleStatus, string> = {
  draft: 'Draft',
  testing: 'Testing',
  reviewed: 'Reviewed',
  active: 'Active',
  deprecated: 'Deprecated'
}

const label = computed(() => labelMap[props.status] ?? props.status)
</script>

<style scoped>
.status-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 3px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.status-draft {
  background: rgba(128, 128, 128, 0.15);
  color: #999;
  border: 1px solid rgba(128, 128, 128, 0.25);
}
.status-testing {
  background: rgba(255, 204, 0, 0.12);
  color: #ffcc00;
  border: 1px solid rgba(255, 204, 0, 0.25);
}
.status-reviewed {
  background: rgba(80, 140, 255, 0.12);
  color: #6699ff;
  border: 1px solid rgba(80, 140, 255, 0.25);
}
.status-active {
  background: rgba(0, 204, 128, 0.12);
  color: #00cc80;
  border: 1px solid rgba(0, 204, 128, 0.25);
}
.status-deprecated {
  background: rgba(255, 68, 68, 0.12);
  color: #ff4444;
  border: 1px solid rgba(255, 68, 68, 0.25);
}
</style>
