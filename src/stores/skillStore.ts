import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Skill, SkillNode, SkillEdge, SkillCatalogItem, McpCatalogItem } from '@/models'
import { SKILL_CATALOG } from '@/data/skillCatalog'
import { vault } from '@/vault'

/**
 * 解析「安装某技能时，其声明的 MCP 依赖该装哪个条目」。
 *
 * 技能自带完整的 mcpServerId/mcpCommand/mcpArgs/mcpEnvKeys，而商店（MCP_CATALOG）
 * 只收录其中一部分（技能引用 21 个 vs 商店 5 个）。旧实现只在商店找得到时才安装，
 * 找不到就**静默跳过**——用户装了技能、依赖却没装上，且无任何提示。
 *
 * 这里改为：商店有则用商店条目（含更完整的元数据），没有则据技能自带字段合成一个，
 * 保证「技能声明的 MCP 一定会被安装」。返回 null 表示该技能未声明 MCP 依赖。
 */
export function resolveMcpInstallItem(
  item: SkillCatalogItem,
  catalog: McpCatalogItem[]
): McpCatalogItem | null {
  if (!item.mcpServerId || !item.mcpCommand) return null
  const found = catalog.find(c => c.id === item.mcpServerId)
  if (found) return found
  return {
    id: item.mcpServerId,
    name: `${item.name} 依赖`,
    description: `由技能「${item.name}」声明的 MCP 服务器（未收录于商店）`,
    category: item.category,
    command: item.mcpCommand,
    args: item.mcpArgs ?? [],
    envKeys: item.mcpEnvKeys ?? [],
    homepage: item.homepage ?? '',
    source: 'community',
    tags: ['skill-dependency']
  }
}

export const useSkillStore = defineStore('skills', () => {
  const installedSkills = ref<Skill[]>([])
  const catalog = ref<SkillCatalogItem[]>(SKILL_CATALOG)

  function installSkill(skill: Skill) {
    const missing = skill.dependencies.filter(dep => !isDependencyMet(dep))
    if (missing.length > 0) return { success: false, missing }
    // C-21：同 id 技能不可重复安装（与 importSkill 同口径）
    if (installedSkills.value.some(s => s.id === skill.id)) {
      return { success: false, missing: [`Skill already installed: ${skill.id}`] }
    }
    const installed = { ...skill, isInstalled: true, isFromMarket: true }
    installedSkills.value.push(installed)
    saveToStorage()
    return { success: true, missing: [] }
  }

  function uninstallSkill(skillId: string): { success: boolean; blockedBy: string[] } {
    // C-21：卸载前校验反向依赖——被其他已安装技能依赖时拒绝卸载，
    // 否则留下悬空依赖，后续安装/校验莫名失败
    const blockedBy = installedSkills.value
      .filter(s => s.id !== skillId && s.dependencies.includes(skillId))
      .map(s => s.name || s.id)
    if (blockedBy.length > 0) {
      return { success: false, blockedBy }
    }
    installedSkills.value = installedSkills.value.filter(s => s.id !== skillId)
    saveToStorage()
    return { success: true, blockedBy: [] }
  }

  function isCatalogItemInstalled(catalogId: string): boolean {
    return installedSkills.value.some(s => s.catalogId === catalogId)
  }

  function installFromCatalog(item: SkillCatalogItem): { success: boolean; missing: string[]; mcpServerId?: string; mcpCommand?: string; mcpArgs?: string[]; mcpEnvKeys?: string[] } {
    if (isCatalogItemInstalled(item.id)) {
      return { success: true, missing: [], mcpServerId: item.mcpServerId, mcpCommand: item.mcpCommand, mcpArgs: item.mcpArgs, mcpEnvKeys: item.mcpEnvKeys }
    }

    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: item.name,
      description: item.description,
      version: item.version,
      nodes: item.nodes,
      edges: item.edges,
      dependencies: item.dependencies,
      author: item.author,
      createdAt: Date.now(),
      isInstalled: true,
      isFromMarket: true,
      catalogId: item.id
    }

    const missing = skill.dependencies.filter(dep => !isDependencyMet(dep))
    if (missing.length > 0) return { success: false, missing }

    installedSkills.value.push(skill)
    saveToStorage()
    return { success: true, missing: [], mcpServerId: item.mcpServerId, mcpCommand: item.mcpCommand, mcpArgs: item.mcpArgs, mcpEnvKeys: item.mcpEnvKeys }
  }

  function exportSkill(skillId: string): string | null {
    const skill = installedSkills.value.find(s => s.id === skillId)
    if (!skill) return null
    return JSON.stringify(skill, null, 2)
  }

  function importSkill(json: string): { success: boolean; missing: string[] } {
    try {
      const skill = JSON.parse(json) as Skill
      if (!skill.id || !skill.name || !skill.nodes) return { success: false, missing: ['Invalid skill format'] }
      // C-21：重复导入同 id 产生不可区分副本——已存在则拒绝
      if (installedSkills.value.some(s => s.id === skill.id)) {
        return { success: false, missing: [`Skill already installed: ${skill.id}`] }
      }
      skill.isInstalled = true
      const missing = skill.dependencies.filter(dep => !isDependencyMet(dep))
      if (missing.length > 0) return { success: false, missing }
      installedSkills.value.push(skill)
      saveToStorage()
      return { success: true, missing: [] }
    } catch {
      return { success: false, missing: ['Invalid JSON'] }
    }
  }

  function createSkillFromWorkflow(name: string, description: string, nodes: SkillNode[], edges: SkillEdge[], dependencies: string[]): Skill {
    const skill: Skill = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      version: '1.0.0',
      nodes,
      edges,
      dependencies,
      author: 'local',
      createdAt: Date.now(),
      isInstalled: true,
      isFromMarket: false
    }
    installedSkills.value.push(skill)
    saveToStorage()
    return skill
  }

  function isDependencyMet(dep: string): boolean {
    if (dep.startsWith('l1-') || dep.startsWith('l0-')) return true
    return installedSkills.value.some(s => s.id === dep)
  }

  function saveToStorage() {
    vault.writeThrough('skill', 'holo-skills', JSON.stringify(installedSkills.value))
  }

  function loadFromStorage() {
    const saved = vault.readCache('skill', 'holo-skills')
    if (saved) {
      try { installedSkills.value = JSON.parse(saved) as Skill[] } catch { /* ignore */ }
    }
  }

  return {
    installedSkills,
    catalog,
    installSkill,
    uninstallSkill,
    exportSkill,
    importSkill,
    createSkillFromWorkflow,
    loadFromStorage,
    isCatalogItemInstalled,
    installFromCatalog
  }
})
