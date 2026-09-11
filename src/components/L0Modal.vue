<template>
  <div class="l0-overlay" v-if="visible" @click.self="close">
    <div class="l0-modal">
      <div class="l0-header">
        <h3>L0 用户本体</h3>
        <button class="btn-close" @click="close">✕</button>
      </div>
      <div class="l0-tabs">
        <button class="tab-btn" :class="{ active: tab === 'skills' }" @click="tab = 'skills'">已安装技能</button>
        <button class="tab-btn" :class="{ active: tab === 'skill-market' }" @click="tab = 'skill-market'">技能商店</button>
        <button class="tab-btn" :class="{ active: tab === 'mcp-market' }" @click="tab = 'mcp-market'">MCP 工具商店</button>
        <button class="tab-btn" :class="{ active: tab === 'mcp' }" @click="tab = 'mcp'">MCP 连接管理</button>
        <button class="tab-btn" :class="{ active: tab === 'security' }" @click="tab = 'security'">权限与沙箱</button>
      </div>

      <div class="l0-body">
        <!-- 已安装技能 -->
        <div v-if="tab === 'skills'" class="tab-content">
          <div v-if="skillStore.installedSkills.length === 0" class="empty-state">暂无已安装技能，从「技能商店」获取</div>
          <div v-for="skill in skillStore.installedSkills" :key="skill.id" class="skill-card">
            <div class="skill-info">
              <h4>{{ skill.name }}</h4>
              <p>{{ skill.description }}</p>
              <span class="skill-version">v{{ skill.version }}</span>
              <span class="skill-deps" v-if="skill.dependencies.length">依赖: {{ skill.dependencies.join(', ') }}</span>
            </div>
            <div class="skill-actions">
              <button class="btn-sm" @click="onExportSkill(skill.id)">导出</button>
              <button class="btn-sm btn-danger" @click="skillStore.uninstallSkill(skill.id)">卸载</button>
            </div>
          </div>
          <div class="import-section">
            <button class="btn-import" @click="onImportSkill">导入 .skill.json</button>
          </div>
        </div>

        <!-- 技能商店 -->
        <div v-if="tab === 'skill-market'" class="tab-content">
          <div class="market-search">
            <input v-model="skillSearch" placeholder="搜索技能..." class="search-input" />
            <div class="category-filters">
              <button
                v-for="cat in skillCategories"
                :key="cat"
                class="cat-btn"
                :class="{ active: skillCategory === cat }"
                @click="skillCategory = cat"
              >{{ cat }}</button>
            </div>
          </div>
          <div v-if="filteredSkillCatalog.length === 0" class="empty-state">没有匹配的技能</div>
          <div v-for="item in filteredSkillCatalog" :key="item.id" class="catalog-card">
            <div class="catalog-header">
              <span class="catalog-name">{{ item.name }}</span>
              <span class="catalog-cat">{{ item.category }}</span>
              <span class="catalog-version">v{{ item.version }}</span>
              <span v-if="item.mcpServerId" class="mcp-badge">MCP</span>
            </div>
            <p class="catalog-desc">{{ item.description }}</p>
            <div class="catalog-tags">
              <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
            <div v-if="item.mcpServerId" class="skill-mcp-info">
              <span class="mcp-server-label">MCP 服务:</span>
              <span class="mcp-server-name">{{ item.mcpCommand }} {{ (item.mcpArgs || []).join(' ') }}</span>
              <div v-if="item.mcpTools && item.mcpTools.length" class="mcp-tools-preview">
                <span v-for="t in item.mcpTools.slice(0, 5)" :key="t" class="mcp-tool-tag">{{ t }}</span>
                <span v-if="item.mcpTools.length > 5" class="mcp-tool-tag">+{{ item.mcpTools.length - 5 }}</span>
              </div>
              <div v-if="item.mcpEnvKeys && item.mcpEnvKeys.length" class="env-hint" style="margin-top: 4px; padding-top: 4px;">
                <span class="env-label">需要密钥:</span>
                <span v-for="key in item.mcpEnvKeys" :key="key" class="env-key">{{ key }}</span>
              </div>
            </div>
            <div class="catalog-footer">
              <span class="catalog-author">by {{ item.author }}</span>
              <button
                v-if="!skillStore.isCatalogItemInstalled(item.id)"
                class="btn-sm btn-install"
                @click="onInstallCatalogSkill(item)"
              >安装技能+MCP</button>
              <span v-else class="installed-badge">已安装</span>
            </div>
          </div>
        </div>

        <!-- MCP 工具商店 -->
        <div v-if="tab === 'mcp-market'" class="tab-content">
          <div class="market-search">
            <input v-model="mcpSearch" placeholder="搜索 MCP 工具..." class="search-input" />
            <div class="category-filters">
              <button
                v-for="cat in mcpCategories"
                :key="cat"
                class="cat-btn"
                :class="{ active: mcpCategory === cat }"
                @click="mcpCategory = cat"
              >{{ cat }}</button>
            </div>
          </div>
          <div v-if="filteredMcpCatalog.length === 0" class="empty-state">没有匹配的 MCP 工具</div>
          <div v-for="item in filteredMcpCatalog" :key="item.id" class="catalog-card">
            <div class="catalog-header">
              <span class="catalog-name">{{ item.name }}</span>
              <span class="catalog-cat">{{ item.category }}</span>
              <span class="catalog-source" :class="item.source">{{ item.source === 'official' ? '官方' : '社区' }}</span>
            </div>
            <p class="catalog-desc">{{ item.description }}</p>
            <div class="catalog-tags">
              <span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
            <div class="catalog-footer">
              <span class="catalog-command">{{ item.command }} {{ item.args.join(' ') }}</span>
              <button
                v-if="!mcpStore.isCatalogItemInstalled(item.id) && mcpStore.spawningCatalogId !== item.id"
                class="btn-sm btn-install"
                @click="onInstallCatalogMcp(item)"
              >下载并添加</button>
              <span v-else-if="mcpStore.spawningCatalogId === item.id" class="spinning-badge">启动中...</span>
              <span v-else class="installed-badge">已添加</span>
            </div>
            <div v-if="item.envKeys.length > 0 && !mcpStore.isCatalogItemInstalled(item.id)" class="env-hint">
              <span class="env-label">需要密钥:</span>
              <span v-for="key in item.envKeys" :key="key" class="env-key">{{ key }}</span>
            </div>
          </div>

          <!-- MCP 环境变量输入弹窗 -->
          <div v-if="envDialogVisible" class="env-dialog-overlay" @click.self="envDialogVisible = false">
            <div class="env-dialog">
              <h4>配置 {{ envDialogItem?.name }}</h4>
              <p class="env-dialog-desc">{{ envDialogItem?.description }}</p>
              <div v-for="key in envDialogItem?.envKeys || []" :key="key" class="env-input-row">
                <label class="env-input-label">{{ key }}</label>
                <input
                  v-model="envDialogValues[key]"
                  :type="envShowKeys[key] ? 'text' : 'password'"
                  :placeholder="`输入 ${key}...`"
                  class="env-input-field"
                />
                <button class="btn-toggle-env" @click="envShowKeys[key] = !envShowKeys[key]">
                  {{ envShowKeys[key] ? '隐藏' : '显示' }}
                </button>
              </div>
              <div class="env-dialog-actions">
                <button class="btn-sm btn-cancel-env" @click="envDialogVisible = false">取消</button>
                <button class="btn-sm btn-confirm-env" @click="confirmEnvAndInstall">确认添加</button>
              </div>
            </div>
          </div>
        </div>

        <!-- MCP 连接管理 -->
        <div v-if="tab === 'mcp'" class="tab-content">
          <div class="mcp-add">
            <input v-model="newMcpName" placeholder="名称 (如 my-server)" class="mcp-input" />
            <select v-model="newMcpMode" class="mcp-mode-select">
              <option value="url">URL</option>
              <option value="command">命令行</option>
            </select>
            <input v-if="newMcpMode === 'url'" v-model="newMcpUrl" placeholder="http://localhost:3000" class="mcp-input" />
            <input v-if="newMcpMode === 'command'" v-model="newMcpCommand" placeholder="npx -y @myorg/mcp-server" class="mcp-input" style="flex:2" />
            <button class="btn-sm btn-add" @click="onAddMcp">添加</button>
          </div>
          <div v-for="conn in mcpStore.connections" :key="conn.id" class="mcp-card">
            <div class="mcp-header">
              <span class="mcp-name">{{ conn.name }}</span>
              <span class="mcp-status" :class="conn.isConnected ? 'connected' : 'disconnected'">
                {{ mcpStore.spawningId === conn.id ? '◌ 启动中...' : conn.isConnected ? `● 已连接 (${conn.tools.length}工具)` : '○ 未连接' }}
              </span>
              <button class="btn-sm" @click="onTestMcp(conn.id)" :disabled="mcpStore.spawningId === conn.id">
                {{ conn.catalogCommand ? '重启' : '测试' }}
              </button>
              <button class="btn-sm btn-danger" @click="mcpStore.removeConnection(conn.id)" :disabled="mcpStore.spawningId === conn.id">删除</button>
            </div>
            <div v-if="!conn.isConnected && mcpStore.lastSpawnError && conn.catalogCommand" class="mcp-error">
              {{ mcpStore.lastSpawnError }}
            </div>
            <div v-if="conn.catalogCommand" class="mcp-catalog-info">
              <span class="catalog-cmd">启动: {{ conn.catalogCommand }} {{ (conn.catalogArgs ?? []).join(' ') }}</span>
              <div v-if="conn.catalogEnv && Object.keys(conn.catalogEnv).length > 0" class="env-display">
                <span v-for="(val, key) in conn.catalogEnv" :key="key" class="env-set">{{ key }}=***</span>
              </div>
            </div>
            <div v-if="conn.url" class="mcp-url-display">{{ conn.url }}</div>
            <div v-if="conn.tools.length > 0" class="mcp-tools">
              <div v-for="tool in conn.tools" :key="tool.name" class="mcp-tool-row">
                <span class="tool-name">{{ tool.name }}</span>
                <span class="tool-desc">{{ tool.description.substring(0, 60) }}</span>
                <label class="toggle-label">
                  <input type="checkbox" :checked="tool.isAutoAllowed" @change="mcpStore.toggleToolAutoAllow(conn.id, tool.name)" />
                  <span>自动允许</span>
                </label>
                <select class="tool-perm-select" :value="tool.permission || 'execute'" @change="mcpStore.setToolPermission(conn.id, tool.name, ($event.target as HTMLSelectElement).value as McpToolPermission)">
                  <option value="readonly">只读</option>
                  <option value="readwrite">读写</option>
                  <option value="execute">执行</option>
                </select>
              </div>
            </div>
            <div v-if="conn.isConnected" class="mcp-whitelist">
              <label class="toggle-label">
                <input type="checkbox" v-model="conn.isWhitelisted" @change="mcpStore.setWhitelist(conn.id, conn.isWhitelisted)" />
                <span>白名单模式(允许非自动工具)</span>
              </label>
            </div>
          </div>
          <div class="mcp-debug" v-if="memoryStore.mcpRequestLogs.length > 0">
            <h4>MCP 调试日志</h4>
            <div v-for="log in memoryStore.mcpRequestLogs.slice(0, 10)" :key="log.id" class="mcp-log-entry">
              <span class="log-time">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
              <span class="log-tool">{{ log.toolName }}</span>
              <span class="log-status" :class="log.success ? 'ok' : 'fail'">{{ log.success ? '✓' : '✗' }}</span>
              <details>
                <summary>请求/响应</summary>
                <pre class="log-detail">请求: {{ log.request.substring(0, 200) }}</pre>
                <pre class="log-detail">响应: {{ log.response.substring(0, 200) }}</pre>
              </details>
            </div>
          </div>
        </div>

        <!-- 权限与沙箱 -->
        <div v-if="tab === 'security'" class="tab-content">
          <div class="security-item">
            <h4>文件沙箱</h4>
            <p>所有 PDF/Excel 文件仅在本地解析，不上传任何云端</p>
            <div class="sandbox-badge">🔒 本地沙箱已启用</div>
          </div>
          <div class="security-item">
            <h4>操作审计日志</h4>
            <button class="btn-sm" @click="onExportAudit">导出 CSV</button>
            <div v-for="entry in memoryStore.auditLogs.slice(0, 10)" :key="entry.id" class="audit-row">
              <span class="audit-time">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
              <span class="audit-action">{{ entry.action }}</span>
              <span class="audit-details">{{ entry.details }}</span>
            </div>
          </div>
          <div class="security-item">
            <h4>MCP 白名单</h4>
            <p>非白名单连接的非自动工具需手动确认</p>
            <div v-for="conn in mcpStore.connections.filter(c => c.isConnected)" :key="conn.id" class="whitelist-row">
              <span>{{ conn.name }}</span>
              <label class="toggle-label">
                <input type="checkbox" :checked="!conn.isWhitelisted" @change="mcpStore.setWhitelist(conn.id, !conn.isWhitelisted)" />
                <span>禁止自动调用</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { useSkillStore } from '@/domains/app'
import { useMcpStore } from '@/domains/mcp'
import { useMemoryStore } from '@/domains/memory'
import { Skill, SkillCatalogItem, McpCatalogItem, McpToolPermission } from '@/models'

const skillStore = useSkillStore()
const mcpStore = useMcpStore()
const memoryStore = useMemoryStore()

const visible = ref(false)
const tab = ref<'skills' | 'skill-market' | 'mcp-market' | 'mcp' | 'security'>('skills')
const newMcpName = ref('')
const newMcpUrl = ref('')
const newMcpCommand = ref('')
const newMcpMode = ref<'url' | 'command'>('command')
const skillSearch = ref('')
const skillCategory = ref('全部')
const mcpSearch = ref('')
const mcpCategory = ref('全部')

const envDialogVisible = ref(false)
const envDialogItem = ref<McpCatalogItem | null>(null)
const envDialogValues = reactive<Record<string, string>>({})
const envShowKeys = reactive<Record<string, boolean>>({})

const emit = defineEmits<{
  skillInstalled: [skillId: string]
  mcpConnected: [mcpId: string]
}>()

const skillCategories = computed(() => {
  const cats = new Set(skillStore.catalog.map(i => i.category))
  return ['全部', ...Array.from(cats)]
})

const mcpCategories = computed(() => {
  const cats = new Set(mcpStore.catalog.map(i => i.category))
  return ['全部', ...Array.from(cats)]
})

const filteredSkillCatalog = computed(() => {
  let items = skillStore.catalog
  if (skillCategory.value !== '全部') {
    items = items.filter(i => i.category === skillCategory.value)
  }
  if (skillSearch.value.trim()) {
    const q = skillSearch.value.toLowerCase()
    items = items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      i.tags.some(t => t.toLowerCase().includes(q))
    )
  }
  return items
})

const filteredMcpCatalog = computed(() => {
  let items = mcpStore.catalog
  if (mcpCategory.value !== '全部') {
    items = items.filter(i => i.category === mcpCategory.value)
  }
  if (mcpSearch.value.trim()) {
    const q = mcpSearch.value.toLowerCase()
    items = items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q) ||
      i.tags.some(t => t.toLowerCase().includes(q))
    )
  }
  return items
})

function open() {
  visible.value = true
  tab.value = 'skills'
}

function close() {
  visible.value = false
}

async function onInstallSkill(skill: Skill) {
  const result = skillStore.installSkill(skill)
  if (result.success) {
    emit('skillInstalled', skill.id)
  } else {
    alert(`安装失败，缺少依赖: ${result.missing.join(', ')}`)
  }
}

function onInstallCatalogSkill(item: SkillCatalogItem) {
  const result = skillStore.installFromCatalog(item)
  if (result.success) {
    emit('skillInstalled', item.id)
    if (result.mcpServerId && result.mcpCommand && !mcpStore.isCatalogItemInstalled(result.mcpServerId)) {
      const mcpItem = mcpStore.catalog.find(c => c.id === result.mcpServerId)
      if (mcpItem) {
        if (mcpItem.envKeys.length > 0) {
          envDialogItem.value = mcpItem
          for (const key of mcpItem.envKeys) {
            envDialogValues[key] = ''
            envShowKeys[key] = false
          }
          envDialogVisible.value = true
        } else {
          doInstallMcp(mcpItem, {})
        }
      }
    }
  } else {
    alert(`安装失败，缺少依赖: ${result.missing.join(', ')}`)
  }
}

function onInstallCatalogMcp(item: McpCatalogItem) {
  if (item.envKeys.length > 0) {
    envDialogItem.value = item
    for (const key of item.envKeys) {
      envDialogValues[key] = ''
      envShowKeys[key] = false
    }
    envDialogVisible.value = true
  } else {
    doInstallMcp(item, {})
  }
}

async function confirmEnvAndInstall() {
  if (!envDialogItem.value) return
  const item = envDialogItem.value
  for (const key of item.envKeys) {
    if (!envDialogValues[key].trim()) {
      alert(`${key} 不能为空`)
      return
    }
  }
  envDialogVisible.value = false
  const envValues: Record<string, string> = {}
  for (const key of item.envKeys) {
    envValues[key] = envDialogValues[key].trim()
  }
  await doInstallMcp(item, envValues)
}

async function doInstallMcp(item: McpCatalogItem, envValues: Record<string, string>) {
  const conn = await mcpStore.installFromCatalog(item, envValues)
  if (conn) {
    emit('mcpConnected', conn.id)
  }
}

function onExportSkill(skillId: string) {
  const json = skillStore.exportSkill(skillId)
  if (!json) return
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `skill-${skillId}.skill.json`
  a.click()
  URL.revokeObjectURL(url)
}

function onImportSkill() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.skill.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const text = await file.text()
    const result = skillStore.importSkill(text)
    if (!result.success) {
      alert(`导入失败: ${result.missing.join(', ')}`)
    }
  }
  input.click()
}

async function onAddMcp() {
  if (!newMcpName.value) return
  if (newMcpMode.value === 'command' && newMcpCommand.value) {
    const parts = newMcpCommand.value.trim().split(/\s+/)
    const command = parts[0]
    const args = parts.slice(1)
    const conn = mcpStore.addConnection(newMcpName.value, '')
    conn.catalogCommand = command
    conn.catalogArgs = args
    conn.catalogEnv = {}
    newMcpName.value = ''
    newMcpCommand.value = ''
    const ok = await mcpStore.testConnection(conn.id)
    if (ok) emit('mcpConnected', conn.id)
  } else if (newMcpUrl.value) {
    const conn = mcpStore.addConnection(newMcpName.value, newMcpUrl.value)
    newMcpName.value = ''
    newMcpUrl.value = ''
    const ok = await mcpStore.testConnection(conn.id)
    if (ok) emit('mcpConnected', conn.id)
  }
}

async function onTestMcp(id: string) {
  await mcpStore.testConnection(id)
}

function onExportAudit() {
  const csv = memoryStore.exportAuditCsv()
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'audit-log.csv'
  a.click()
  URL.revokeObjectURL(url)
}

defineExpose({ open, close })
</script>

<style scoped>
.l0-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
  backdrop-filter: blur(6px);
}

.l0-modal {
  background: rgba(8, 14, 28, 0.95);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 12px;
  width: 780px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(20px);
}

.l0-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.1);
}
.l0-header h3 {
  color: #e0eaff;
  font-size: 15px;
  font-weight: 500;
  margin: 0;
}
.btn-close {
  background: transparent;
  border: none;
  color: #5a7a9a;
  font-size: 14px;
  cursor: pointer;
}
.btn-close:hover { color: #aaccff; }

.l0-tabs {
  display: flex;
  padding: 0 20px;
  border-bottom: 1px solid rgba(100, 180, 255, 0.08);
  gap: 2px;
}
.tab-btn {
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #5a7a9a;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.tab-btn.active {
  color: #aaccff;
  border-bottom-color: rgba(100, 180, 255, 0.5);
}
.tab-btn:hover { color: #8ab4ff; }

.l0-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.tab-content { min-height: 200px; }

.empty-state {
  color: #5a7a9a;
  font-size: 12px;
  text-align: center;
  padding: 40px 0;
}

.skill-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(15, 25, 45, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 6px;
}
.skill-card:hover { border-color: rgba(100, 180, 255, 0.25); }

.skill-info { flex: 1; }
.skill-info h4 { color: #e0eaff; font-size: 13px; margin: 0 0 4px; }
.skill-info p { color: #7a9cc6; font-size: 11px; margin: 0 0 4px; }
.skill-version { font-size: 9px; color: #4a6a8a; margin-right: 8px; }
.skill-deps { font-size: 9px; color: #ffaa44; }

.skill-actions { display: flex; flex-direction: column; gap: 4px; }

.btn-sm {
  padding: 4px 10px;
  background: rgba(50, 120, 200, 0.15);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 3px;
  color: #8ab4ff;
  font-size: 10px;
  cursor: pointer;
}
.btn-sm:hover { background: rgba(50, 120, 200, 0.3); }
.btn-danger { color: #ff6a6a; border-color: rgba(255, 100, 100, 0.2); }
.btn-danger:hover { background: rgba(255, 100, 100, 0.15); }
.btn-install { color: #44ff88; border-color: rgba(68, 255, 136, 0.2); }
.btn-add { color: #44ff88; border-color: rgba(68, 255, 136, 0.2); white-space: nowrap; }

.import-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(100, 180, 255, 0.06);
}
.btn-import {
  padding: 6px 16px;
  background: rgba(50, 120, 200, 0.15);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #8ab4ff;
  font-size: 12px;
  cursor: pointer;
}

.market-search { margin-bottom: 16px; }
.search-input {
  width: 100%;
  padding: 8px 12px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
  margin-bottom: 8px;
}
.search-input:focus { border-color: rgba(100, 180, 255, 0.5); }

.category-filters { display: flex; flex-wrap: wrap; gap: 4px; }
.cat-btn {
  padding: 3px 10px;
  background: rgba(20, 40, 80, 0.4);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 10px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
}
.cat-btn.active {
  background: rgba(50, 120, 200, 0.3);
  border-color: rgba(100, 180, 255, 0.4);
  color: #aaccff;
}
.cat-btn:hover { border-color: rgba(100, 180, 255, 0.3); color: #8ab4ff; }

.catalog-card {
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(15, 25, 45, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 6px;
  transition: border-color 0.2s;
}
.catalog-card:hover { border-color: rgba(100, 180, 255, 0.25); }

.catalog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.catalog-name {
  color: #e0eaff;
  font-size: 13px;
  font-weight: 500;
}
.catalog-cat {
  font-size: 9px;
  padding: 1px 6px;
  background: rgba(100, 180, 255, 0.1);
  border-radius: 8px;
  color: #6a8aaa;
}
.catalog-version {
  font-size: 9px;
  color: #4a6a8a;
}
.catalog-source {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 8px;
}
.catalog-source.official {
  background: rgba(68, 255, 136, 0.1);
  color: #44ff88;
}
.catalog-source.community {
  background: rgba(255, 170, 68, 0.1);
  color: #ffaa44;
}

.catalog-desc {
  color: #7a9cc6;
  font-size: 11px;
  margin: 0 0 8px;
}

.catalog-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.tag {
  font-size: 9px;
  padding: 1px 6px;
  background: rgba(160, 100, 220, 0.1);
  border-radius: 8px;
  color: #b088e0;
}

.catalog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.catalog-author {
  font-size: 9px;
  color: #5a7a9a;
}
.catalog-command {
  font-size: 9px;
  color: #4a6a8a;
  font-family: 'Consolas', monospace;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.installed-badge {
  font-size: 10px;
  color: #44ff88;
  padding: 2px 8px;
  background: rgba(68, 255, 136, 0.08);
  border-radius: 3px;
}

.env-hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(100, 180, 255, 0.04);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.env-label { font-size: 9px; color: #5a7a9a; }
.env-key {
  font-size: 9px;
  padding: 1px 6px;
  background: rgba(255, 170, 68, 0.08);
  border-radius: 3px;
  color: #ffaa44;
  font-family: 'Consolas', monospace;
}

.mcp-add { display: flex; gap: 8px; margin-bottom: 16px; }
.mcp-input {
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
.mcp-input:focus { border-color: rgba(100, 180, 255, 0.5); }
.mcp-mode-select {
  padding: 6px 8px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 12px;
  outline: none;
}
.mcp-mode-select option { background: #0a0c14; }

.mcp-card {
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(15, 25, 45, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.1);
  border-radius: 6px;
}
.mcp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.mcp-name { color: #e0eaff; font-size: 13px; font-weight: 500; }
.mcp-status { font-size: 10px; margin-left: auto; }
.mcp-status.connected { color: #44ff88; }
.mcp-status.disconnected { color: #5a7a9a; }

.mcp-catalog-info {
  margin-bottom: 6px;
  padding: 6px 8px;
  background: rgba(20, 40, 60, 0.3);
  border-radius: 4px;
}
.catalog-cmd {
  font-size: 10px;
  color: #6a8aaa;
  font-family: 'Consolas', monospace;
  display: block;
}
.env-display { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.env-set {
  font-size: 9px;
  color: #4a6a8a;
  font-family: 'Consolas', monospace;
}
.mcp-url-display {
  font-size: 10px;
  color: #4a6a8a;
  font-family: 'Consolas', monospace;
  margin-bottom: 6px;
}

.mcp-error {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(255, 80, 80, 0.08);
  border: 1px solid rgba(255, 80, 80, 0.15);
  border-radius: 4px;
  color: #ff8888;
  font-size: 10px;
  word-break: break-all;
}

.mcp-tools { margin-top: 8px; }
.mcp-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px solid rgba(100, 180, 255, 0.04);
}
.mcp-tool-row .tool-name {
  font-size: 11px;
  color: #b088e0;
  font-family: 'Consolas', monospace;
  min-width: 100px;
}
.mcp-tool-row .tool-desc { font-size: 10px; color: #5a7a9a; flex: 1; }
.mcp-whitelist {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(100, 180, 255, 0.04);
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #7a9cc6;
  cursor: pointer;
}
.toggle-label input { width: 12px; height: 12px; }

.tool-perm-select {
  background: rgba(20, 30, 50, 0.8);
  color: #88aacc;
  border: 1px solid rgba(100, 180, 255, 0.2);
  border-radius: 3px;
  font-size: 10px;
  padding: 1px 4px;
  cursor: pointer;
}
.tool-perm-select:focus { outline: none; border-color: rgba(100, 180, 255, 0.5); }

.mcp-debug {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(100, 180, 255, 0.08);
}
.mcp-debug h4 { color: #7a9cc6; font-size: 12px; margin-bottom: 8px; }
.mcp-log-entry {
  padding: 6px 0;
  border-top: 1px solid rgba(100, 180, 255, 0.04);
  font-size: 11px;
}
.log-time { color: #4a6a8a; margin-right: 8px; font-size: 10px; }
.log-tool { color: #b088e0; margin-right: 8px; }
.log-status.ok { color: #44ff88; }
.log-status.fail { color: #ff4444; }
.log-detail {
  background: rgba(10, 15, 30, 0.8);
  padding: 6px;
  border-radius: 3px;
  font-size: 9px;
  color: #5a7a9a;
  margin: 4px 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.security-item { margin-bottom: 16px; }
.security-item h4 { color: #e0eaff; font-size: 13px; margin-bottom: 6px; }
.security-item p { color: #7a9cc6; font-size: 11px; margin-bottom: 8px; }
.sandbox-badge {
  display: inline-block;
  padding: 4px 12px;
  background: rgba(68, 255, 136, 0.1);
  border: 1px solid rgba(68, 255, 136, 0.2);
  border-radius: 3px;
  color: #44ff88;
  font-size: 11px;
}

.audit-row {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px solid rgba(100, 180, 255, 0.04);
  font-size: 10px;
}
.audit-time { color: #4a6a8a; }
.audit-action { color: #8ab4ff; }
.audit-details { color: #5a7a9a; flex: 1; }

.whitelist-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 11px;
  color: #8aacc8;
}

.spinning-badge {
  font-size: 10px;
  color: #8ab4ff;
  padding: 2px 8px;
  background: rgba(100, 180, 255, 0.08);
  border-radius: 3px;
  animation: spin-pulse 1.5s ease-in-out infinite;
}
@keyframes spin-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.env-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 4000;
  backdrop-filter: blur(4px);
}
.env-dialog {
  background: rgba(8, 14, 28, 0.97);
  border: 1px solid rgba(100, 180, 255, 0.3);
  border-radius: 10px;
  padding: 24px;
  width: 420px;
  max-width: 90vw;
}
.env-dialog h4 {
  color: #e0eaff;
  font-size: 14px;
  font-weight: 500;
  margin: 0 0 8px;
}
.env-dialog-desc {
  color: #7a9cc6;
  font-size: 11px;
  margin: 0 0 16px;
}
.env-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.env-input-label {
  font-size: 11px;
  color: #b088e0;
  font-family: 'Consolas', monospace;
  min-width: 180px;
  flex-shrink: 0;
}
.env-input-field {
  flex: 1;
  padding: 7px 10px;
  background: rgba(20, 30, 50, 0.8);
  border: 1px solid rgba(100, 180, 255, 0.25);
  border-radius: 4px;
  color: #c0d8ff;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}
.env-input-field:focus { border-color: rgba(100, 180, 255, 0.5); }
.btn-toggle-env {
  padding: 4px 8px;
  background: rgba(30, 50, 80, 0.6);
  border: 1px solid rgba(100, 180, 255, 0.15);
  border-radius: 3px;
  color: #6a8aaa;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.env-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.btn-cancel-env {
  color: #7a9cc6;
  border-color: rgba(100, 180, 255, 0.2);
}
.btn-confirm-env {
  color: #44ff88;
  border-color: rgba(68, 255, 136, 0.3);
  background: rgba(68, 255, 136, 0.1);
}
.btn-confirm-env:hover { background: rgba(68, 255, 136, 0.2); }

.mcp-badge {
  font-size: 8px;
  padding: 1px 5px;
  background: rgba(100, 180, 255, 0.2);
  border: 1px solid rgba(100, 180, 255, 0.3);
  border-radius: 3px;
  color: #8ab4ff;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.skill-mcp-info {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(20, 40, 60, 0.3);
  border: 1px solid rgba(100, 180, 255, 0.06);
  border-radius: 4px;
}
.mcp-server-label {
  font-size: 9px;
  color: #5a7a9a;
  margin-right: 4px;
}
.mcp-server-name {
  font-size: 10px;
  color: #6a8aaa;
  font-family: 'Consolas', monospace;
}
.mcp-tools-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 4px;
}
.mcp-tool-tag {
  font-size: 8px;
  padding: 1px 5px;
  background: rgba(160, 100, 220, 0.08);
  border-radius: 3px;
  color: #9a78c0;
  font-family: 'Consolas', monospace;
}
</style>
