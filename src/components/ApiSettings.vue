<template>
  <div class="api-settings-overlay" v-if="visible" @click.self="close">
    <div class="api-settings-panel">
      <h3>模型网关配置</h3>

      <div class="section">
        <label>快速添加云端大模型</label>
        <div class="preset-grid">
          <button
            v-for="p in presets"
            :key="p.id"
            class="preset-btn"
            :class="{ added: isProviderAdded(p.id) }"
            @click="addPreset(p)"
          >{{ p.name }}</button>
        </div>
      </div>

      <div class="section">
        <label>自定义 API 地址</label>
        <input
          v-model="customUrl"
          type="text"
          placeholder="http://127.0.0.1:11434/v1"
        />
        <div class="row">
          <select v-model="customAuthType" class="auth-select">
            <option value="none">无认证</option>
            <option value="bearer">Bearer Token</option>
            <option value="api-key">API Key</option>
          </select>
          <input
            v-if="customAuthType !== 'none'"
            v-model="customApiKey"
            :type="showKey ? 'text' : 'password'"
            placeholder="输入密钥..."
            class="key-input"
          />
          <button class="toggle-key" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        </div>
        <button class="btn-add-custom" @click="addCustomProvider">+ 添加自定义 Provider</button>
      </div>

      <div class="section" v-if="apiStore.config.providers.length > 0">
        <label>已配置的 Provider</label>
        <div
          v-for="prov in apiStore.config.providers"
          :key="prov.id"
          class="provider-card"
          :class="{ active: prov.id === apiStore.config.activeProviderId }"
        >
          <div class="prov-header">
            <span class="prov-name">{{ prov.name }}</span>
            <span class="prov-status" :class="prov.isReachable ? 'ok' : 'off'">
              {{ prov.isReachable ? '已连接' : '未连接' }}
            </span>
            <button class="prov-ping" @click="pingOne(prov.id)">检测</button>
            <button class="prov-del" @click="removeProv(prov.id)">删除</button>
          </div>
          <div class="prov-url">{{ prov.baseUrl }}</div>
          <div v-if="prov.models.length > 0" class="model-list">
            <div
              v-for="m in prov.models"
              :key="m.id"
              class="model-item"
              :class="{ active: apiStore.config.activeModel === m.id && prov.id === apiStore.config.activeProviderId }"
              @click="selectModel(prov.id, m.id)"
            >{{ m.id }}</div>
          </div>
          <div v-if="prov.id === editingProviderId" class="key-edit">
            <input
              v-model="editingKey"
              :type="showEditKey ? 'text' : 'password'"
              placeholder="更新密钥..."
              class="key-input"
            />
            <button class="toggle-key" @click="showEditKey = !showEditKey">{{ showEditKey ? '隐藏' : '显示' }}</button>
            <button class="btn-save-key" @click="saveProviderKey">保存密钥</button>
          </div>
          <button v-else class="btn-edit-key" @click="startEditKey(prov)">修改密钥</button>
        </div>
      </div>

      <div v-if="checking" class="status">检测中...</div>
      <div v-if="error" class="status error">{{ error }}</div>

      <div class="buttons">
        <button class="btn-ping-all" @click="pingAll" :disabled="checking">全部检测</button>
        <button class="btn-cancel" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useApiStore } from '@/domains/api'
import { ProviderConfig } from '@/models'

const apiStore = useApiStore()

const visible = ref(false)
const checking = ref(false)
const error = ref('')
const showKey = ref(false)
const showEditKey = ref(false)
const customUrl = ref('')
const customAuthType = ref<'none' | 'bearer' | 'api-key'>('bearer')
const customApiKey = ref('')
const editingProviderId = ref('')
const editingKey = ref('')

const presets: { id: string; name: string; baseUrl: string; authType: 'bearer' | 'api-key'; modelsEndpoint: string; chatFormat: 'openai' | 'anthropic' }[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authType: 'api-key', modelsEndpoint: '/v1/models', chatFormat: 'anthropic' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'zhipu', name: '智谱AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'yi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'ollama', name: 'Ollama(本地)', baseUrl: 'http://127.0.0.1:11434/v1', authType: 'none', modelsEndpoint: '/models', chatFormat: 'openai' }
]

function isProviderAdded(id: string): boolean {
  return apiStore.config.providers.some(p => p.id === id)
}

function addPreset(preset: typeof presets[0]) {
  const existing = apiStore.config.providers.find(p => p.id === preset.id)
  if (existing) {
    apiStore.switchProvider(preset.id)
    return
  }

  const apiKey = prompt(`请输入 ${preset.name} 的 API 密钥：`)
  if (!apiKey && preset.authType !== 'none') return

  const providerId = apiStore.addProvider({
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    authType: preset.authType,
    apiKey: apiKey || '',
    modelsEndpoint: preset.modelsEndpoint,
    chatFormat: preset.chatFormat
  })

  apiStore.switchProvider(providerId)
  pingOne(providerId)
}

function addCustomProvider() {
  if (!customUrl.value.trim()) return
  const apiKey = customAuthType.value !== 'none' ? customApiKey.value : ''
  const providerId = apiStore.addProvider({
    id: `custom-${Date.now()}`,
    name: customUrl.value.replace(/https?:\/\//, '').split('/')[0],
    baseUrl: customUrl.value.trim().replace(/\/+$/, ''),
    authType: customAuthType.value,
    apiKey,
    modelsEndpoint: '/v1/models',
    chatFormat: 'openai'
  })
  apiStore.switchProvider(providerId)
  pingOne(providerId)
  customUrl.value = ''
  customApiKey.value = ''
}

function removeProv(id: string) {
  apiStore.removeProvider(id)
}

async function pingOne(id: string) {
  checking.value = true
  error.value = ''
  const provider = apiStore.config.providers.find(p => p.id === id)
  if (!provider) { checking.value = false; return }
  const ok = await apiStore.pingProvider(provider)
  if (!ok) {
    error.value = `${provider.name} 连接失败，请检查地址和密钥`
  }
  checking.value = false
}

async function pingAll() {
  checking.value = true
  error.value = ''
  await apiStore.pingAllProviders()
  checking.value = false
}

function selectModel(providerId: string, modelId: string) {
  apiStore.switchProvider(providerId)
  apiStore.setActiveModel(modelId)
}

function startEditKey(prov: ProviderConfig) {
  editingProviderId.value = prov.id
  editingKey.value = ''
  showEditKey.value = false
}

function saveProviderKey() {
  if (!editingKey.value.trim()) return
  const provider = apiStore.config.providers.find(p => p.id === editingProviderId.value)
  if (provider) {
    provider.apiKey = editingKey.value.trim()
    apiStore.saveToStorage()
  }
  editingProviderId.value = ''
  editingKey.value = ''
}

function open() {
  error.value = ''
  checking.value = false
  visible.value = true
}

function close() {
  visible.value = false
}

defineExpose({ open, close })
</script>

<style scoped>
.api-settings-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  backdrop-filter: blur(4px);
}
.api-settings-panel {
  background: rgba(10, 20, 40, 0.95);
  border: 1px solid rgba(100, 180, 255, 0.25);
  border-radius: 8px;
  padding: 24px;
  min-width: 520px;
  max-width: 600px;
  max-height: 80vh;
  overflow-y: auto;
  backdrop-filter: blur(12px);
}
.api-settings-panel h3 {
  color: #8ab4ff;
  font-size: 15px;
  margin-bottom: 16px;
  font-weight: 500;
}
.section {
  margin-bottom: 18px;
}
.section label {
  display: block;
  color: #7a9cc6;
  font-size: 12px;
  margin-bottom: 8px;
}
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset-btn {
  padding: 5px 12px;
  background: rgba(20, 40, 80, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 14px;
  color: #8ab4ff;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.preset-btn:hover {
  background: rgba(40, 80, 160, 0.5);
  border-color: rgba(100, 180, 255, 0.4);
}
.preset-btn.added {
  background: rgba(30, 80, 60, 0.5);
  border-color: rgba(80, 200, 120, 0.3);
  color: #6fd89a;
}
.section input {
  width: 100%;
  padding: 8px 12px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  margin-bottom: 8px;
}
.section input:focus {
  border-color: rgba(100, 180, 255, 0.5);
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.auth-select {
  padding: 6px 10px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 12px;
  outline: none;
  min-width: 100px;
}
.key-input {
  flex: 1;
  padding: 6px 10px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.toggle-key {
  padding: 4px 8px;
  background: rgba(30, 50, 80, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 3px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-custom {
  padding: 6px 14px;
  background: rgba(50, 120, 200, 0.2);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #8ab4ff;
  font-size: 12px;
  cursor: pointer;
}
.btn-add-custom:hover {
  background: rgba(50, 120, 200, 0.35);
}
.provider-card {
  padding: 10px 12px;
  margin-bottom: 8px;
  background: rgba(20, 30, 50, 0.5);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 6px;
}
.provider-card.active {
  border-color: rgba(100, 180, 255, 0.4);
  background: rgba(30, 50, 90, 0.4);
}
.prov-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.prov-name {
  color: #c0d8ff;
  font-size: 13px;
  font-weight: 500;
}
.prov-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
}
.prov-status.ok {
  background: rgba(40, 160, 80, 0.2);
  color: #5fd89a;
}
.prov-status.off {
  background: rgba(160, 40, 40, 0.2);
  color: #d88a5f;
}
.prov-ping, .prov-del {
  margin-left: auto;
  padding: 2px 8px;
  background: rgba(30, 50, 80, 0.5);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 3px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
}
.prov-del {
  border-color: rgba(200, 80, 80, 0.2);
  color: #c88;
}
.prov-url {
  color: #556;
  font-size: 10px;
  margin-bottom: 6px;
  word-break: break-all;
}
.model-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.model-item {
  padding: 3px 8px;
  background: rgba(20, 40, 70, 0.5);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 3px;
  color: #8ab4ff;
  font-size: 11px;
  cursor: pointer;
}
.model-item.active {
  border-color: rgba(100, 180, 255, 0.5);
  background: rgba(40, 80, 160, 0.3);
  color: #fff;
}
.key-edit {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
}
.btn-save-key {
  padding: 3px 10px;
  background: rgba(50, 120, 200, 0.25);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 3px;
  color: #8ab4ff;
  font-size: 11px;
  cursor: pointer;
}
.btn-edit-key {
  margin-top: 6px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 3px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
}
.status {
  color: #7a9cc6;
  font-size: 12px;
  margin-top: 10px;
}
.status.error {
  color: #ff6a6a;
}
.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.btn-ping-all {
  padding: 6px 16px;
  background: rgba(50, 120, 200, 0.25);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #8ab4ff;
  font-size: 13px;
  cursor: pointer;
}
.btn-ping-all:disabled {
  opacity: 0.4;
}
.btn-cancel {
  padding: 6px 18px;
  background: transparent;
  border: 1px solid rgba(100, 180, 255, 0.25);
  border-radius: 4px;
  color: #7a9cc6;
  font-size: 13px;
  cursor: pointer;
}
</style>
