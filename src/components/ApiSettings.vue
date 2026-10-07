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
              placeholder="输入 API 密钥，保存后自动检测连接..."
              class="key-input"
            />
            <button class="toggle-key" @click="showEditKey = !showEditKey">{{ showEditKey ? '隐藏' : '显示' }}</button>
            <button class="btn-save-key" @click="saveProviderKey">保存密钥</button>
          </div>
          <button v-else class="btn-edit-key" @click="startEditKey(prov)">修改密钥</button>
        </div>
      </div>

      <div class="section" v-if="apiStore.config.providers.length > 0">
        <label>模型协同（大模型掌舵 + 小模型辅助）</label>
        <div class="row">
          <span class="prov-name">主模型（大：理解/规划/产出/兜底）</span>
          <select class="auth-select" :value="mainSlot" @change="applySlot('main', $event)">
            <option value="">跟随「当前模型」（不启用）</option>
            <option v-for="opt in modelOptions" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
          </select>
        </div>
        <div class="row">
          <span class="prov-name">辅助模型（小：分类/抽取/规范化）</span>
          <select class="auth-select" :value="auxSlot" @change="applySlot('aux', $event)">
            <option value="">跟随「当前模型」（不启用）</option>
            <option v-for="opt in modelOptions" :key="opt.key" :value="opt.key">{{ opt.label }}</option>
          </select>
        </div>
        <div class="prov-url">主模型负责主线与兜底；辅助模型承担确定性小活。未设置者回退「当前模型」。</div>
      </div>

      <div v-if="checking" class="status">检测中...</div>
      <div v-if="successMsg && !checking && !error" class="status ok">{{ successMsg }}</div>
      <div v-if="error" class="status error">{{ error }}</div>

      <div class="buttons">
        <button class="btn-ping-all" @click="pingAll" :disabled="checking">全部检测</button>
        <button class="btn-cancel" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useApiStore } from '@/domains/api'
import { ProviderConfig } from '@/models'

const apiStore = useApiStore()

const visible = ref(false)
const checking = ref(false)
const error = ref('')
const successMsg = ref('')
const showKey = ref(false)
const showEditKey = ref(false)
const customUrl = ref('')
const customAuthType = ref<'none' | 'bearer' | 'api-key'>('bearer')
const customApiKey = ref('')
const editingProviderId = ref('')
const editingKey = ref('')

const presets: { id: string; name: string; baseUrl: string; authType: 'none' | 'bearer' | 'api-key'; modelsEndpoint: string; chatFormat: 'openai' | 'anthropic' | 'ollama' }[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', authType: 'api-key', modelsEndpoint: '/v1/models', chatFormat: 'anthropic' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'zhipu', name: '智谱AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  { id: 'yi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1', authType: 'bearer', modelsEndpoint: '/models', chatFormat: 'openai' },
  // M17：Ollama 预设改原生协议（/api/tags + /api/chat NDJSON），渲染进程直连不走 IPC
  { id: 'ollama', name: 'Ollama(本地)', baseUrl: 'http://127.0.0.1:11434', authType: 'none', modelsEndpoint: '/api/tags', chatFormat: 'ollama' }
]

function isProviderAdded(id: string): boolean {
  return apiStore.config.providers.some(p => p.id === id)
}

// ── 模型协同（2026-09-23 用户要求）：主模型（大，掌舵+兜底）／辅助模型（小，分类抽取等活）──
// 注意：这是**协同分工**（同一任务里各司其职），不是"快速/强力二选一"。
const modelOptions = computed(() =>
  apiStore.config.providers.flatMap(p => p.models.map(m => ({ key: `${p.id}::${m.id}`, label: `${p.name} / ${m.id}` })))
)
function slotKey(role: 'main' | 'aux'): string {
  const rm = apiStore.config.roleModels as Record<string, { providerId: string; model: string }> | undefined
  const b = rm ? rm[role] : undefined
  return b ? `${b.providerId}::${b.model}` : ''
}
const mainSlot = computed(() => slotKey('main'))
const auxSlot = computed(() => slotKey('aux'))

function applySlot(role: 'main' | 'aux', ev: Event): void {
  const key = (ev.target as HTMLSelectElement).value
  const rm: Record<string, { providerId: string; model: string }> = {
    ...((apiStore.config.roleModels as Record<string, { providerId: string; model: string }> | undefined) || {})
  }
  if (!key) {
    delete rm[role]
  } else {
    const [providerId, model] = key.split('::')
    if (providerId && model) rm[role] = { providerId, model }
  }
  apiStore.config.roleModels = Object.keys(rm).length > 0
    ? (rm as typeof apiStore.config.roleModels)
    : undefined
  apiStore.saveToStorage()
  successMsg.value = '模型协同已保存（大模型掌舵与兜底，小模型做辅助活）'
}

function addPreset(preset: typeof presets[0]) {
  const existing = apiStore.config.providers.find(p => p.id === preset.id)
  if (existing) {
    apiStore.switchProvider(preset.id)
    return
  }

  const providerId = apiStore.addProvider({
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    authType: preset.authType,
    apiKey: '',
    modelsEndpoint: preset.modelsEndpoint,
    chatFormat: preset.chatFormat
  })

  apiStore.switchProvider(providerId)
  if (preset.authType === 'none') {
    pingOne(providerId)
  } else {
    startEditKeyById(providerId)
  }
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
  successMsg.value = ''
  const provider = apiStore.config.providers.find(p => p.id === id)
  if (!provider) { checking.value = false; return }
  const ok = await apiStore.pingProvider(provider)
  checking.value = false
  if (ok) {
    successMsg.value = `${provider.name} 连接成功`
  } else {
    error.value = `${provider.name} 连接失败，请检查地址和密钥`
  }
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
  startEditKeyById(prov.id)
}

function startEditKeyById(id: string) {
  editingProviderId.value = id
  editingKey.value = ''
  showEditKey.value = false
}

async function saveProviderKey() {
  const key = editingKey.value.trim()
  if (!key) return
  const provider = apiStore.config.providers.find(p => p.id === editingProviderId.value)
  editingProviderId.value = ''
  editingKey.value = ''
  if (provider) {
    provider.apiKey = key
    apiStore.saveToStorage()
    await pingOne(provider.id)
  }
}

function open() {
  error.value = ''
  checking.value = false
  visible.value = true
}

function close() {
  visible.value = false
}

// P1-47：暴露 visible 供 App.vue Esc 链判断弹层是否打开
defineExpose({ open, close, visible })
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
  font-size: var(--font-sm);
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
  font-size: var(--font-sm);
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
  font-size: var(--font-sm);
  cursor: pointer;
}
.prov-del {
  border-color: rgba(200, 80, 80, 0.2);
  color: #c88;
}
.prov-url {
  color: #556;
  font-size: var(--font-sm);
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
  font-size: var(--font-sm);
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
.status.ok {
  color: #5fd89a;
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
