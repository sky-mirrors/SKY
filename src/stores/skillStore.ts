import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Skill, SkillNode, SkillEdge, SkillCatalogItem } from '@/models'
import { SKILL_CATALOG } from '@/data/skillCatalog'

export const useSkillStore = defineStore('skills', () => {
  const installedSkills = ref<Skill[]>([])
  const catalog = ref<SkillCatalogItem[]>(SKILL_CATALOG)

  function installSkill(skill: Skill) {
    const missing = skill.dependencies.filter(dep => !isDependencyMet(dep))
    if (missing.length > 0) return { success: false, missing }
    const installed = { ...skill, isInstalled: true, isFromMarket: true }
    installedSkills.value.push(installed)
    saveToStorage()
    return { success: true, missing: [] }
  }

  function uninstallSkill(skillId: string) {
    installedSkills.value = installedSkills.value.filter(s => s.id !== skillId)
    saveToStorage()
  }

  function isCatalogItemInstalled(catalogId: string): boolean {
    return installedSkills.value.some(s => s.catalogId === catalogId)
  }

  function installFromCatalog(item: SkillCatalogItem): { success: boolean; missing: string[]; mcpServerId?: string; mcpCommand?: string; mcpArgs?: string[]; mcpEnvKeys?: string[] } {
    if (isCatalogItemInstalled(item.id)) {
      return { success: true, missing: [], mcpServerId: item.mcpServerId, mcpCommand: item.mcpCommand, mcpArgs: item.mcpArgs, mcpEnvKeys: item.mcpEnvKeys }
    }

    const skill: Skill = {
      id: `skill-${Date.now()}`,
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
      id: `skill-${Date.now()}`,
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
    try { localStorage.setItem('holo-skills', JSON.stringify(installedSkills.value)) } catch { /* ignore */ }
  }

  function loadFromStorage() {
    try {
      const saved = localStorage.getItem('holo-skills')
      if (saved) installedSkills.value = JSON.parse(saved) as Skill[]
    } catch { /* ignore */ }
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
