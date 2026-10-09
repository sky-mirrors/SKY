<template>
  <div class="pe">
    <header class="pe-head">
      <span class="pe-title">领域包编辑器</span>
      <span class="pe-hint">为用户包添加知识条目与规则；保存后需重启应用或重载包才能生效</span>
      <span v-if="toast" class="pe-toast" :class="{ bad: toastBad }">{{ toast }}</span>
    </header>

    <div class="pe-body">
      <aside class="pe-list">
        <div class="pe-list-head">
          <span>用户包</span>
          <button class="pe-btn small" @click="openCreate">＋ 新建</button>
        </div>
        <div v-if="!packs.length" class="pe-empty">还没有用户包</div>
        <button
          v-for="p in packs" :key="p.id"
          class="pe-item" :class="{ active: current?.id === p.id }"
          @click="select(p.id)">
          <span class="pe-item-id">{{ p.id }}</span>
          <span class="pe-item-meta">{{ p.files.length }} 个文件</span>
        </button>
        <div v-if="rootDir" class="pe-root">位置：{{ rootDir }}</div>
      </aside>

      <main class="pe-main">
        <div v-if="creating" class="pe-card">
          <div class="pe-card-title">新建用户包</div>
          <label>包 ID（小写字母/数字/-，如 my-legal）</label>
          <input v-model.trim="draftForm.id" class="pe-input" placeholder="my-legal" />
          <label>显示名称</label>
          <input v-model.trim="draftForm.name" class="pe-input" placeholder="我的法务包" />
          <label>领域</label>
          <select v-model="draftForm.domain" class="pe-input">
            <option value="legal">法务</option>
            <option value="finance">财务</option>
            <option value="geotech">岩土工程</option>
          </select>
          <div class="pe-actions">
            <button class="pe-btn primary" @click="createPack">创建</button>
            <button class="pe-btn" @click="creating = false">取消</button>
          </div>
        </div>

        <div v-else-if="!current" class="pe-empty big">左侧选一个用户包，或新建一个</div>

        <template v-else>
          <div class="pe-card">
            <div class="pe-card-title">
              {{ current.id }}
              <button class="pe-btn small danger" @click="removePack">删除整个包</button>
            </div>
            <div class="pe-sub">{{ current.name }} · 领域 {{ current.domain }}</div>
          </div>

          <div class="pe-card">
            <div class="pe-card-title">知识条目（{{ knowledges.length }}）</div>
            <p class="pe-note">
              只放**可核验的权威内容**：写清来源（规范/法律名称与条款）。不要写凭印象的释义。
            </p>
            <div v-for="(k, i) in knowledges" :key="'k' + i" class="pe-row">
              <input v-model.trim="k.filename" class="pe-input" placeholder="条目标题，如 民法典-合同编要点" />
              <textarea v-model="k.text" class="pe-area" rows="4" placeholder="内容（请标注出处）"></textarea>
              <button class="pe-btn small danger" @click="knowledges.splice(i, 1)">移除</button>
            </div>
            <button class="pe-btn" @click="knowledges.push({ filename: '', text: '' })">＋ 添加知识条目</button>
          </div>

          <div class="pe-card">
            <div class="pe-card-title">规则（{{ rules.length }}）</div>
            <p class="pe-note">
              触发词按「组」写：同组内任一命中、组与组之间需同时满足。多组用分号隔开。
              例如：<code>承载力特征值,地基承载力;极限,设计值</code>
            </p>
            <div v-for="(r, i) in rules" :key="'r' + i" class="pe-row">
              <input v-model.trim="r.keywords" class="pe-input" placeholder="触发词组，如 竞业限制,竞业禁止;补偿,期限" />
              <input v-model.trim="r.message" class="pe-input" placeholder="命中时提示什么" />
              <input v-model.trim="r.ref" class="pe-input" placeholder="依据（必填）：如 劳动合同法 第二十三条" />
              <div class="pe-actions">
                <select v-model="r.severity" class="pe-input narrow">
                  <option value="warning">警告</option>
                  <option value="info">提示</option>
                  <option value="error">错误</option>
                </select>
                <button class="pe-btn small danger" @click="rules.splice(i, 1)">移除</button>
              </div>
            </div>
            <button class="pe-btn" @click="rules.push({ keywords: '', message: '', ref: '', severity: 'warning' })">
              ＋ 添加规则
            </button>
          </div>

          <div class="pe-actions sticky">
            <button class="pe-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存到用户包' }}</button>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface PackInfo { id: string; files: string[] }
interface KnowledgeDraft { filename: string; text: string }
interface RuleDraft { keywords: string; message: string; ref: string; severity: string }

const packs = ref<PackInfo[]>([])
const rootDir = ref('')
const current = ref<{ id: string; name: string; domain: string } | null>(null)
const knowledges = ref<KnowledgeDraft[]>([])
const rules = ref<RuleDraft[]>([])
const creating = ref(false)
const saving = ref(false)
const draftForm = ref({ id: '', name: '', domain: 'legal' })
const toast = ref('')
const toastBad = ref(false)

function say(msg: string, bad = false) {
  toast.value = msg
  toastBad.value = bad
  setTimeout(() => { toast.value = '' }, 4000)
}

async function refresh() {
  const api = window.electronAPI
  if (!api?.userPackList) { say('当前环境没有用户包接口（需在应用内打开）', true); return }
  const res = await api.userPackList()
  if (!res?.success) { say(res?.error || '读取失败', true); return }
  packs.value = res.packs || []
}

onMounted(async () => {
  const api = window.electronAPI
  if (api?.userPackRoot) {
    const r = await api.userPackRoot()
    if (r?.success) rootDir.value = r.root || ''
  }
  await refresh()
})

function openCreate() {
  creating.value = true
  draftForm.value = { id: '', name: '', domain: 'legal' }
}

async function createPack() {
  const { id, name, domain } = draftForm.value
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) { say('包 ID 只能用小写字母、数字、- 和 _', true); return }
  if (!name) { say('请填显示名称', true); return }
  const packJson = {
    id, name, version: '1.0.0', license: 'user', domain,
    priority: 0, weight: 1.0, needsUserKnowledge: false,
    capabilities: { hooks: { advisory: ['L0', 'L1', 'L2', 'L3', 'L4'], veto: ['pre-output'], override: [] }, clusters: [] },
    compatibility: { minHostVersion: '0.1.0' }
  }
  const w = await window.electronAPI!.userPackWrite(id, 'pack.json', JSON.stringify(packJson, null, 2))
  if (!w?.success) { say(w?.error || '创建失败', true); return }
  creating.value = false
  await refresh()
  say('已创建，接着添加知识与规则')
  await select(id)
}

async function select(packId: string) {
  const api = window.electronAPI!
  const packFile = await api.userPackRead(packId, 'pack.json')
  let meta = { id: packId, name: packId, domain: 'legal' }
  if (packFile?.success) {
    try {
      const parsed = JSON.parse(packFile.content || '{}')
      meta = { id: packId, name: parsed.name || packId, domain: parsed.domain || 'legal' }
    } catch { /* 保持默认 */ }
  }
  current.value = meta

  knowledges.value = []
  const kFiles = packs.value.find(p => p.id === packId)?.files.filter(f => f.startsWith('knowledge/') && f.endsWith('.json')) || []
  for (const f of kFiles) {
    const r = await api.userPackRead(packId, f)
    if (!r?.success) continue
    try {
      const parsed = JSON.parse(r.content || '{}')
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      for (const e of entries) {
        if (e && typeof e.filename === 'string') knowledges.value.push({ filename: e.filename, text: String(e.text ?? '') })
      }
    } catch { /* 跳过坏文件 */ }
  }

  rules.value = []
  const cFile = await api.userPackRead(packId, 'boundary/constraints.json')
  if (cFile?.success) {
    try {
      const arr = JSON.parse(cFile.content || '[]')
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const groups = c?.trigger?.keywordGroups
          rules.value.push({
            keywords: Array.isArray(groups) ? groups.map((g: string[]) => g.join(',')).join(';') : '',
            message: c?.action?.messageTemplate || '',
            ref: c?.reliability?.source
              ? [c.reliability.source.name, c.reliability.source.article].filter(Boolean).join(' ')
              : '',
            severity: c?.action?.severity || 'warning'
          })
        }
      }
    } catch { /* 跳过坏文件 */ }
  }
}

function slug(s: string, fallback: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return t || fallback
}

async function save() {
  if (!current.value) return
  for (const r of rules.value) {
    if (!r.keywords.trim()) { say('有一条规则的触发词为空', true); return }
    if (!r.message.trim()) { say('有一条规则没有写提示文案', true); return }
    if (!r.ref.trim()) { say('每条规则都必须填写依据（规范/法律名称与条款）', true); return }
  }
  saving.value = true
  try {
    const api = window.electronAPI!
    const packId = current.value.id

    const existing = packs.value.find(p => p.id === packId)?.files.filter(f => f.startsWith('knowledge/') && f.endsWith('.json')) || []
    for (const f of existing) await api.userPackDeleteFile(packId, f)

    const used = new Set<string>()
    for (const k of knowledges.value) {
      if (!k.filename.trim()) continue
      let base = slug(k.filename, 'entry')
      let name = base
      let n = 2
      while (used.has(name)) { name = `${base}-${n++}` }
      used.add(name)
      const w = await api.userPackWrite(packId, `knowledge/${name}.json`, JSON.stringify({ filename: k.filename, text: k.text }, null, 2))
      if (!w?.success) { say(w?.error || '知识条目写入失败', true); return }
    }

    const constraints = rules.value.map((r, i) => {
      const groups = r.keywords.split(';').map(g => g.split(',').map(s => s.trim()).filter(Boolean)).filter(g => g.length)
      return {
        id: `${packId}-rule-${i + 1}`,
        category: '用户自定义',
        description: r.message,
        severity: r.severity,
        applicability: { jurisdiction: 'PRC' },
        reliability: {
          confidence: 'medium',
          source: { type: 'manual', name: r.ref, article: '见上', effectiveDate: '以现行版本为准' }
        },
        automationLevel: 'full',
        trigger: { keywordGroups: groups },
        action: { severity: r.severity, messageTemplate: r.message },
        evaluator: null
      }
    })
    const w = await api.userPackWrite(packId, 'boundary/constraints.json', JSON.stringify(constraints, null, 2))
    if (!w?.success) { say(w?.error || '规则写入失败', true); return }

    await refresh()
    say('已保存。重启应用后生效')
  } finally {
    saving.value = false
  }
}

async function removePack() {
  if (!current.value) return
  const id = current.value.id
  if (!window.confirm(`确定删除用户包 ${id} 及其全部文件？此操作不可撤销。`)) return
  const r = await window.electronAPI!.userPackDeletePack(id)
  if (!r?.success) { say(r?.error || '删除失败', true); return }
  current.value = null
  knowledges.value = []
  rules.value = []
  await refresh()
  say('已删除')
}
</script>

<style scoped>
.pe { display: flex; flex-direction: column; height: 100%; color: #b0d4f1; font-size: 13px; background: #050510; }
.pe-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid rgba(100,180,255,0.12); }
.pe-title { font-weight: 600; color: #8ab4ff; }
.pe-hint { color: #5a7a9a; font-size: 12px; }
.pe-toast { margin-left: auto; color: #7ee0a8; }
.pe-toast.bad { color: #ff8a8a; }
.pe-body { flex: 1; display: flex; min-height: 0; }
.pe-list { width: 220px; border-right: 1px solid rgba(100,180,255,0.12); padding: 10px; overflow: auto; }
.pe-list-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; color: #8ab4ff; }
.pe-item { display: block; width: 100%; text-align: left; padding: 8px; margin-bottom: 6px; background: rgba(20,30,50,0.6); border: 1px solid rgba(100,180,255,0.1); border-radius: 3px; color: inherit; cursor: pointer; }
.pe-item.active { background: rgba(100,180,255,0.14); border-color: rgba(100,180,255,0.35); }
.pe-item-id { display: block; font-weight: 600; }
.pe-item-meta { font-size: 11px; color: #5a7a9a; }
.pe-root { margin-top: 10px; font-size: 11px; color: #46617a; word-break: break-all; }
.pe-main { flex: 1; padding: 14px; overflow: auto; }
.pe-card { background: rgba(20,30,50,0.45); border: 1px solid rgba(100,180,255,0.12); border-radius: 4px; padding: 12px; margin-bottom: 12px; }
.pe-card-title { color: #8ab4ff; font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.pe-sub { color: #5a7a9a; }
.pe-note { color: #6d8ba5; font-size: 12px; margin-bottom: 8px; line-height: 1.6; }
.pe-note code { background: rgba(100,180,255,0.1); padding: 1px 4px; border-radius: 2px; }
.pe-empty { color: #46617a; padding: 8px; }
.pe-empty.big { text-align: center; padding: 60px 0; }
.pe-row { border-top: 1px dashed rgba(100,180,255,0.12); padding-top: 10px; margin-top: 10px; }
.pe-input, .pe-area { width: 100%; margin-bottom: 6px; padding: 6px 8px; background: rgba(10,16,28,0.9); border: 1px solid rgba(100,180,255,0.18); border-radius: 3px; color: inherit; font-family: inherit; font-size: 13px; }
.pe-input.narrow { width: 120px; display: inline-block; }
.pe-area { resize: vertical; }
.pe-actions { display: flex; gap: 8px; align-items: center; }
.pe-actions.sticky { position: sticky; bottom: 0; padding: 10px 0; background: linear-gradient(transparent, #050510 40%); }
.pe-btn { padding: 5px 12px; background: rgba(100,180,255,0.12); border: 1px solid rgba(100,180,255,0.3); border-radius: 3px; color: #b0d4f1; cursor: pointer; font-size: 12px; }
.pe-btn:hover { background: rgba(100,180,255,0.2); }
.pe-btn.primary { background: rgba(100,180,255,0.25); color: #d8ecff; }
.pe-btn.small { padding: 3px 8px; font-size: 11px; }
.pe-btn.danger { border-color: rgba(255,120,120,0.4); color: #ffb0b0; }
.pe-btn:disabled { opacity: 0.5; cursor: default; }
</style>
