<template>
  <transition name="onboard-fade">
    <div class="onboarding-overlay" v-if="visible">
      <div class="onboarding-wizard">
        <div class="ob-progress">
          <div
            v-for="(step, i) in steps"
            :key="i"
            class="ob-step-dot"
            :class="{ active: i === currentStep, done: i < currentStep }"
          ></div>
        </div>
        <div class="ob-content" v-if="currentStep < steps.length">
          <div class="ob-icon">{{ steps[currentStep].icon }}</div>
          <h2 class="ob-title">{{ steps[currentStep].title }}</h2>
          <p class="ob-desc">{{ steps[currentStep].description }}</p>
          <div class="ob-body">
            <div v-if="steps[currentStep].id === 'welcome'" class="ob-welcome">
              <p>这是你第一次使用 HoloStarmap，让我们花1分钟完成初始设置。</p>
            </div>
            <div v-if="steps[currentStep].id === 'role'" class="ob-role-select">
              <button
                v-for="role in roles"
                :key="role.id"
                class="ob-role-btn"
                :class="{ selected: selectedRole === role.id }"
                @click="selectedRole = role.id"
              >
                <span class="ob-role-icon">{{ role.icon }}</span>
                <span class="ob-role-name">{{ role.name }}</span>
              </button>
            </div>
            <div v-if="steps[currentStep].id === 'api'" class="ob-api-config">
              <p class="ob-api-hint">配置AI模型网关以启用智能功能（可稍后配置）</p>
              <div class="ob-api-field">
                <label>API地址</label>
                <input v-model="apiUrl" placeholder="https://api.openai.com/v1" />
              </div>
              <div class="ob-api-field">
                <label>API密钥</label>
                <input v-model="apiKey" type="password" placeholder="sk-..." />
              </div>
              <div class="ob-api-field">
                <label>模型</label>
                <input v-model="apiModel" placeholder="gpt-4" />
              </div>
            </div>
            <div v-if="steps[currentStep].id === 'terminology'" class="ob-term-select">
              <button
                v-for="opt in termOptions"
                :key="opt.value"
                class="ob-term-btn"
                :class="{ selected: terminologyStyle === opt.value }"
                @click="terminologyStyle = opt.value"
              >
                <span class="ob-term-label">{{ opt.label }}</span>
                <span class="ob-term-example">{{ opt.example }}</span>
              </button>
            </div>
            <div v-if="steps[currentStep].id === 'ready'" class="ob-ready">
              <div class="ob-checklist">
                <div class="ob-check-item" :class="{ done: selectedRole }">
                  <span>{{ selectedRole ? '✅' : '⬜' }}</span>
                  <span>角色选择{{ selectedRole ? `: ${roleName}` : '' }}</span>
                </div>
                <div class="ob-check-item" :class="{ done: !!apiUrl }">
                  <span>{{ apiUrl ? '✅' : '⬜' }}</span>
                  <span>API配置{{ apiUrl ? ': 已设置' : '（可稍后配置）' }}</span>
                </div>
                <div class="ob-check-item done">
                  <span>✅</span>
                  <span>术语风格: {{ termLabel }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="ob-actions">
            <button class="ob-btn ob-btn-skip" v-if="currentStep > 0" @click="prevStep">上一步</button>
            <button class="ob-btn ob-btn-skip" @click="skip">跳过</button>
            <button class="ob-btn ob-btn-next" @click="nextStep">
              {{ currentStep === steps.length - 1 ? '开始使用' : '下一步' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useConfigStore } from '@/domains/config'
import { useApiStore } from '@/domains/api'
import { useNodeStore } from '@/domains/node'
import { useNotificationStore } from '@/domains/app'
import { JobRole } from '@/models'
import { completeStep } from '@/services/onboardingManager'

const configStore = useConfigStore()
const apiStore = useApiStore()
const nodeStore = useNodeStore()
const notificationStore = useNotificationStore()

const visible = ref(false)
const currentStep = ref(0)
const selectedRole = ref<string | null>(null)
const apiUrl = ref('')
const apiKey = ref('')
const apiModel = ref('')
const terminologyStyle = ref<'technical' | 'plain'>('plain')

const roles = [
  { id: JobRole.HR, icon: '👥', name: '人力资源' },
  { id: JobRole.Finance, icon: '💰', name: '财务' },
  { id: JobRole.Sales, icon: '📈', name: '销售' },
  { id: JobRole.Legal, icon: '⚖️', name: '法务' },
  { id: JobRole.General, icon: '📋', name: '通用' }
]

const termOptions = [
  { value: 'technical' as const, label: '专业模式', example: '知识检索、模型调用' },
  { value: 'plain' as const, label: '轻松模式', example: '知识查询、AI对话' }
]

const steps = [
    { id: 'welcome', icon: '🌌', title: '欢迎来到 HoloStarmap', description: '你的企业 AI 工具工作台' },
  { id: 'role', icon: '👤', title: '选择你的角色', description: '我们将根据角色推荐适合的工具配置' },
  { id: 'api', icon: '🧠', title: '连接AI大脑', description: '配置模型网关以启用智能功能' },
  { id: 'terminology', icon: '📖', title: '术语偏好', description: '选择你习惯的术语风格' },
  { id: 'ready', icon: '🚀', title: '准备就绪', description: '一切设置完成，开始探索吧' }
]

const roleName = computed(() => {
  const r = roles.find(r => r.id === selectedRole.value)
  return r?.name || ''
})

const termLabel = computed(() => {
  const o = termOptions.find(o => o.value === terminologyStyle.value)
  return o?.label || ''
})

function open() {
  visible.value = true
  currentStep.value = 0
  selectedRole.value = configStore.currentJobRole || null
  terminologyStyle.value = configStore.terminologyStyle || 'plain'
  apiUrl.value = apiStore.config.baseUrl || ''
  apiModel.value = apiStore.config.activeModel || ''
}

function close() {
  visible.value = false
}

function prevStep() {
  if (currentStep.value > 0) currentStep.value--
}

function nextStep() {
  if (currentStep.value < steps.length - 1) {
    currentStep.value++
  } else {
    finish()
  }
}

function skip() {
  finish()
}

function finish() {
  if (selectedRole.value) {
    // 2026-09-25（机制体检）：改经 onboardingManager 走同一条路——此前直接调 configStore，
    // 使 onboardingManager 整个模块成为死代码（同一功能两套机制）。现由模块统一落库。
    completeStep(2, { jobRole: selectedRole.value as JobRole })
    nodeStore.applyJobRoleTemplates(selectedRole.value as JobRole)
  }

  configStore.setTerminologyStyle(terminologyStyle.value)
  configStore.setAnimationEnabled(true)

  if (apiUrl.value && apiModel.value) {
    const existing = apiStore.config.providers.find(p => p.id === 'onboarded-provider')
    if (!existing) {
      apiStore.addProvider({
        id: 'onboarded-provider',
        name: '默认服务',
        baseUrl: apiUrl.value,
        authType: apiKey.value ? 'bearer' : 'none',
        apiKey: apiKey.value || '',
        modelsEndpoint: '/v1/models',
        chatFormat: 'openai'
      })
    } else {
      existing.baseUrl = apiUrl.value
      existing.apiKey = apiKey.value || ''
      existing.authType = apiKey.value ? 'bearer' : 'none'
    }
    apiStore.config.activeModel = apiModel.value
    apiStore.saveToStorage()
    apiStore.checkConnection().then(ok => {
      if (ok) {
        notificationStore.addNotification('tool_complete', 'AI大脑已连接', apiModel.value)
      }
    }).catch(() => {})
  }

  completeStep(3, { apiConfigured: !!(apiUrl.value && apiModel.value) })
  configStore.markFirstLaunchDone()
  completeStep(5)
  close()
}

defineExpose({ open, close })
</script>

<style scoped>
.onboarding-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 6000;
}

.onboarding-wizard {
  width: 480px;
  background: rgba(10, 16, 32, 0.96);
  border: 1px solid rgba(100, 180, 255, 0.25);
  border-radius: 16px;
  padding: 32px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 1px rgba(100, 180, 255, 0.3);
}

.ob-progress {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 28px;
}

.ob-step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(100, 180, 255, 0.2);
  transition: all 0.2s;
}

.ob-step-dot.active {
  background: #88bbff;
  box-shadow: 0 0 8px rgba(100, 180, 255, 0.4);
}

.ob-step-dot.done {
  background: #44cc66;
}

.ob-icon {
  font-size: 40px;
  text-align: center;
  margin-bottom: 12px;
}

.ob-title {
  font-size: 20px;
  font-weight: 600;
  color: #c0d8f0;
  text-align: center;
  margin: 0 0 6px;
}

.ob-desc {
  font-size: 13px;
  color: rgba(130, 170, 220, 0.5);
  text-align: center;
  margin: 0 0 20px;
}

.ob-body {
  min-height: 100px;
  margin-bottom: 20px;
}

.ob-welcome p {
  font-size: 13px;
  color: #a0b8d0;
  text-align: center;
  line-height: 1.6;
}

.ob-role-select {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.ob-role-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border-radius: 10px;
  border: 1px solid rgba(100, 180, 255, 0.15);
  background: rgba(100, 180, 255, 0.04);
  color: #a0b8d0;
  cursor: pointer;
  transition: all 0.15s;
}

.ob-role-btn:hover {
  background: rgba(100, 180, 255, 0.1);
  border-color: rgba(100, 180, 255, 0.3);
}

.ob-role-btn.selected {
  background: rgba(100, 180, 255, 0.15);
  border-color: #88bbff;
  color: #c0d8f0;
}

.ob-role-icon {
  font-size: 24px;
}

.ob-role-name {
  font-size: 13px;
}

.ob-api-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ob-api-hint {
  font-size: 12px;
  color: rgba(130, 170, 220, 0.4);
  margin: 0 0 4px;
}

.ob-api-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ob-api-field label {
  font-size: 11px;
  color: rgba(130, 170, 220, 0.5);
}

.ob-api-field input {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(100, 180, 255, 0.15);
  background: rgba(10, 20, 40, 0.6);
  color: #c0d8f0;
  font-size: 13px;
  outline: none;
}

.ob-api-field input:focus {
  border-color: rgba(100, 180, 255, 0.4);
}

.ob-term-select {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ob-term-btn {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid rgba(100, 180, 255, 0.12);
  background: rgba(100, 180, 255, 0.04);
  color: #a0b8d0;
  cursor: pointer;
  transition: all 0.15s;
}

.ob-term-btn:hover {
  background: rgba(100, 180, 255, 0.1);
}

.ob-term-btn.selected {
  background: rgba(100, 180, 255, 0.15);
  border-color: #88bbff;
}

.ob-term-label {
  font-size: 13px;
  font-weight: 500;
}

.ob-term-example {
  font-size: 11px;
  color: rgba(130, 170, 220, 0.4);
}

.ob-ready {
  padding: 8px 0;
}

.ob-checklist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ob-check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #7a90a8;
}

.ob-check-item.done {
  color: #a0b8d0;
}

.ob-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ob-btn {
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  border: none;
}

.ob-btn-skip {
  background: rgba(100, 180, 255, 0.08);
  color: rgba(130, 170, 220, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.1);
}

.ob-btn-skip:hover {
  background: rgba(100, 180, 255, 0.15);
  color: #a0b8d0;
}

.ob-btn-next {
  background: rgba(80, 160, 255, 0.25);
  color: #88bbff;
  border: 1px solid rgba(100, 180, 255, 0.3);
}

.ob-btn-next:hover {
  background: rgba(80, 160, 255, 0.4);
}

.onboard-fade-enter-active { transition: opacity 0.2s; }
.onboard-fade-leave-active { transition: opacity 0.15s; }
.onboard-fade-enter-from, .onboard-fade-leave-to { opacity: 0; }
</style>
