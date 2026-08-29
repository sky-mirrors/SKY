<template>
  <transition name="fade">
    <div class="job-selector-overlay" v-if="visible">
      <div class="job-selector-panel">
        <h2>选择你的岗位</h2>
        <p class="subtitle">我们将为你预配置最合适的工具组合</p>
        <div class="role-grid">
          <div
            v-for="role in roles"
            :key="role.value"
            class="role-card"
            :class="{ active: selected === role.value }"
            @click="selected = role.value"
          >
            <div class="role-icon">{{ role.icon }}</div>
            <div class="role-name">{{ role.label }}</div>
          </div>
        </div>
        <button class="btn-confirm" :disabled="!selected" @click="confirm">确认</button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { JobRole } from '@/models'

const visible = ref(true)
const selected = ref<JobRole | ''>('')

const roles = [
  { value: JobRole.HR, label: '人事', icon: '👥' },
  { value: JobRole.Finance, label: '财务', icon: '📊' },
  { value: JobRole.Sales, label: '销售', icon: '🤝' },
  { value: JobRole.Legal, label: '法务', icon: '⚖️' },
  { value: JobRole.General, label: '通用', icon: '💼' }
]

const emit = defineEmits<{
  select: [role: JobRole]
}>()

function confirm() {
  if (!selected.value) return
  visible.value = false
  emit('select', selected.value as JobRole)
}
</script>

<style scoped>
.job-selector-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(2, 5, 16, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  backdrop-filter: blur(16px);
}

.job-selector-panel {
  text-align: center;
  max-width: 520px;
}

.job-selector-panel h2 {
  color: #8ab4ff;
  font-size: 20px;
  font-weight: 500;
  margin-bottom: 8px;
}

.subtitle {
  color: #5a7a9a;
  font-size: 13px;
  margin-bottom: 32px;
}

.role-grid {
  display: flex;
  gap: 14px;
  justify-content: center;
  margin-bottom: 28px;
  flex-wrap: wrap;
}

.role-card {
  width: 80px;
  padding: 16px 8px;
  background: rgba(15, 25, 45, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.role-card:hover {
  border-color: rgba(100, 180, 255, 0.4);
  background: rgba(20, 35, 60, 0.8);
}

.role-card.active {
  border-color: rgba(100, 180, 255, 0.7);
  background: rgba(30, 60, 110, 0.6);
  box-shadow: 0 0 12px rgba(100, 180, 255, 0.15);
}

.role-icon {
  font-size: 28px;
  margin-bottom: 8px;
}

.role-name {
  color: #a0c0e8;
  font-size: 12px;
}

.btn-confirm {
  padding: 8px 32px;
  background: rgba(50, 120, 200, 0.3);
  border: 1px solid rgba(100, 180, 255, 0.3);
  border-radius: 4px;
  color: #8ab4ff;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-confirm:hover:not(:disabled) {
  background: rgba(50, 120, 200, 0.5);
}

.btn-confirm:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.fade-enter-active { transition: opacity 0.5s ease; }
.fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
