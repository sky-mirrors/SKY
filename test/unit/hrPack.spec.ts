import { describe, it, expect } from 'vitest'
import { PackLoader, createBuiltinPackSource } from '@/host/pack/loader'
import { getManifestById } from '@/data/l2Manifests'
import type { L2ToolManifest } from '@/models'

/**
 * A5 批（hr pack 供给扩充）：hr pack 经内置源自动发现（glob src/packs 下各目录的 pack.json），
 * 与生产 initPackRuntime 同路径挂载。顶层 await 保证归因表就绪。
 * 用独立 PackLoader 实例（真实内置源），不触碰生产 packRuntime 单例。
 */
const loader = new PackLoader()
for (const packId of loader.listPackIds()) {
  const mounted = await loader.mountPack(packId)
  if (!mounted.ok) {
    throw new Error(`pack ${packId} mount failed: ${mounted.error.phase}/${mounted.error.reason}`)
  }
}

const HR_MANIFEST_IDS = [
  'l2-resume-screening-v1',
  'l2-onboarding-guide-gen-v1',
  'l2-announcement-draft-v1',
  'l2-attendance-exception-note-v1',
  'l2-offboarding-checklist-v1'
]

describe('A5 hr pack 供给扩充', () => {
  it('hr pack 经内置源自动发现并成功挂载', () => {
    expect(loader.listPackIds()).toContain('hr')
    expect(loader.isMounted('hr')).toBe(true)
    const hrManifest = loader.listMounted().find(m => m.id === 'hr')
    expect(hrManifest).toBeDefined()
    expect(hrManifest!.domain).toBe('hr')
  })

  it('归因表：5 个 HR 宏归因 hr；policy-doc-qa 仍归因 legal（防双声明回归）', () => {
    for (const manifestId of HR_MANIFEST_IDS) {
      expect(loader.getPackIdForManifest(manifestId)).toBe('hr')
    }
    // 归因纪律：l2-policy-doc-qa-v1 为 HR/Legal 双角色宏，已由 legal 声明。
    // loader 首声明者赢（glob 字母序 finance→hr→legal），若 hr 重复声明则此断言失败。
    expect(loader.getPackIdForManifest('l2-policy-doc-qa-v1')).toBe('legal')
    expect(loader.getPackIdForManifest('l2-not-exist-v9')).toBeUndefined()
  })

  it('hr pack 权重 1.0，无约束贡献（55 条约束计数不受影响）', () => {
    expect(loader.getWeight('hr')).toBe(1.0)
    expect(loader.getMountedConstraintIds('hr')).toEqual([])
  })

  it('术语知识层：非空且符合 {filename, text} 契约', () => {
    const knowledge = createBuiltinPackSource().listKnowledge('hr')
    expect(knowledge.length).toBeGreaterThan(0)
    for (const entry of knowledge) {
      expect(typeof entry.filename).toBe('string')
      expect(entry.filename.length).toBeGreaterThan(0)
      expect(typeof entry.text).toBe('string')
      expect(entry.text.length).toBeGreaterThan(0)
    }
  })

  it('新增实战宏存在于执行真源：macro 模式、无 shell_exec', () => {
    const newIds = ['l2-attendance-exception-note-v1', 'l2-offboarding-checklist-v1']
    for (const id of newIds) {
      const manifest = getManifestById(id) as L2ToolManifest | undefined
      expect(manifest).toBeDefined()
      expect(manifest!.execution.mode).toBe('macro')
      const steps = manifest!.execution.dagPlan?.steps ?? []
      expect(steps.length).toBe(2)
      for (const step of steps) {
        expect(['knowledge_search', 'llm_generate']).toContain(step.tool)
      }
      // 知识检索步骤必须有 llm_generate fallback（知识库空时不硬失败）
      const searchStep = steps.find(s => s.tool === 'knowledge_search')
      expect(searchStep?.fallback).toBe('llm_generate')
    }
  })
})
