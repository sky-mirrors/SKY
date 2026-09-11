import type { CommandPaletteResult } from '@/models'
import { globalBus } from '@/kernel/bus'
import type { useDialogStore } from '@/stores/dialogStore'

interface SearchableItem {
  type: CommandPaletteResult['type']
  id: string
  label: string
  description: string
  category: string
  keywords: string[]
  roleBoost: number
  recentBoost: number
}

const STATIC_SETTINGS: SearchableItem[] = [
  { type: 'setting', id: 'setting-api', label: 'API服务', description: '配置AI服务提供商和模型', category: '设置', keywords: ['api', '模型', 'provider', '密钥'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-appearance', label: '外观设置', description: '主题、动效、术语风格', category: '设置', keywords: ['主题', '外观', '动效', '术语'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-shortcuts', label: '快捷键设置', description: '自定义键盘快捷键', category: '设置', keywords: ['快捷键', '键盘'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-data', label: '数据管理', description: '导出、导入、清理数据', category: '设置', keywords: ['数据', '导出', '导入', '清理'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-notifications', label: '通知设置', description: '管理通知类型和弹出方式', category: '设置', keywords: ['通知', '提醒'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-language', label: '语言设置', description: '界面语言和Prompt模板语言', category: '设置', keywords: ['语言', 'language'], roleBoost: 0, recentBoost: 0 },
  { type: 'setting', id: 'setting-about', label: '关于', description: '版本信息和系统信息', category: '设置', keywords: ['关于', '版本', '更新'], roleBoost: 0, recentBoost: 0 },
]

const STATIC_ACTIONS: SearchableItem[] = [
  { type: 'action', id: 'action-toggle-mode', label: '切换工作台/星图模式', description: '切换UI布局模式', category: '视图', keywords: ['模式', '工作台', '星图', '切换'], roleBoost: 0, recentBoost: 0 },
  { type: 'action', id: 'action-toggle-theme', label: '切换主题', description: '深色/浅色/护眼三态切换', category: '视图', keywords: ['主题', '深色', '浅色'], roleBoost: 0, recentBoost: 0 },
  { type: 'action', id: 'action-open-debug', label: '打开调试探针', description: '查看执行记录和调试信息', category: '工具', keywords: ['调试', '探针'], roleBoost: 0, recentBoost: 0 },
  { type: 'action', id: 'action-open-benchmark', label: '打开基准测试', description: 'Token优化压测', category: '工具', keywords: ['基准', '测试', '压测'], roleBoost: 0, recentBoost: 0 },
  { type: 'action', id: 'action-open-rules', label: '打开规则审核', description: '法律约束规则管理', category: '工具', keywords: ['规则', '审核', '法律'], roleBoost: 0, recentBoost: 0 },
  { type: 'action', id: 'action-open-notifications', label: '打开通知中心', description: '查看所有通知和提醒', category: '视图', keywords: ['通知', '提醒', '消息'], roleBoost: 0, recentBoost: 0 },
]

function prefixScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 3
  if (t.includes(q)) return 2
  for (const word of q.split(/\s+/)) {
    if (t.includes(word.toLowerCase())) return 1
  }
  return 0
}

export function search(
  query: string,
  scope: 'all' | 'skills' | 'settings' | 'history' = 'all',
  dialogStore?: ReturnType<typeof useDialogStore>
): CommandPaletteResult[] {
  if (!query.trim()) return []

  const config = globalBus.request<{ currentJobRole: string; recentSkills?: { id: string; lastUsed: number }[] }>('config:get', {})
  const currentRole = config.currentJobRole
  const recentSkillIds = (config.recentSkills ?? []).map(s => s.id)
  const now = Date.now()
  const skills = globalBus.request<{ id: string; name: string; description: string; catalogId?: string; jobRoles?: string[] }[]>('skill:list', {})

  const items: SearchableItem[] = []

  if (scope === 'all' || scope === 'skills') {
    for (const skill of skills) {
      const roleMatch = skill.jobRoles
      const roleBoost = roleMatch?.includes(currentRole) ? 1.5 : 1.0
      const recentIdx = recentSkillIds.indexOf(skill.id)
      const recentBoost = recentIdx >= 0 && (now - (config.recentSkills?.[recentIdx]?.lastUsed ?? 0)) < 86400000 ? 1.3 : 1.0

      items.push({
        type: 'skill',
        id: skill.id,
        label: skill.name,
        description: skill.description,
        category: '技能',
        keywords: [skill.name, skill.description, skill.catalogId ?? ''],
        roleBoost,
        recentBoost
      })
    }
  }

  if (scope === 'all' || scope === 'settings') {
    items.push(...STATIC_SETTINGS)
  }

  if (scope === 'all') {
    items.push(...STATIC_ACTIONS)
  }

  if (scope === 'all' || scope === 'history') {
    if (dialogStore) {
      const recentMessages = dialogStore.messages
        .filter(m => m.role === 'user')
        .slice(-20)
      for (const msg of recentMessages) {
        items.push({
          type: 'history',
          id: msg.id,
          label: msg.content.slice(0, 60),
          description: `对话历史 · ${new Date(msg.timestamp).toLocaleTimeString()}`,
          category: '历史',
          keywords: [msg.content],
          roleBoost: 0.5,
          recentBoost: 1.0
        })
      }
    }
  }

  const scored: CommandPaletteResult[] = []

  for (const item of items) {
    let score = 0
    score += prefixScore(query, item.label) * 3
    score += prefixScore(query, item.description) * 1.5

    for (const kw of item.keywords) {
      score += prefixScore(query, kw) * 0.5
    }

    if (score > 0) {
      score *= item.roleBoost * item.recentBoost
      scored.push({
        type: item.type,
        id: item.id,
        label: item.label,
        description: item.description,
        category: item.category,
        weight: score
      })
    }
  }

  scored.sort((a, b) => b.weight - a.weight)
  return scored.slice(0, 20)
}
