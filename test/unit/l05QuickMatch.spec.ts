import { describe, it, expect } from 'vitest'
import { tryL05QuickMatch } from '@/services/l0SkillRouter'
import l2Manifests from '@/data/l2Manifests'
import type { L2ToolManifest } from '@/models'

/**
 * L0.5 关键词快配（`tryL05QuickMatch`）的真实行为测试（2026-09-30 补）。
 *
 * 此前该函数在任何测试里都是 `vi.mock` 掉的（`funnelMainPath.spec.ts` / `defaultKernel.spec.ts`），
 * **零真实覆盖** —— 任何门值/公式改动都没有保护网。本文件钉住**机制**（准入条件），
 * 而不是钉死具体个案：个案会随门值校准（G-15：门值均未经校准）而变，机制不该变。
 *
 * 机制（`l0SkillRouter.ts:732` 起）：
 *   ① hitRatio = 命中关键词数 / 该 manifest 关键词总数，须 ≥ 0.4；
 *   ② 与第二名的 hitRatio 差（margin）须 ≥ 0.1；
 *   ③ confidence = min(hitRatio × 1.5, 1.0) 须 ≥ 0.8 —— **这一条最严，等价于 hitRatio ≥ 0.533**；
 *   ④ 只接受单步形态（mode === 'direct'，或 dagPlan 仅 1 步）。
 */

function makeManifest(opts: {
  id: string
  name: string
  keywords: string[]
  mode: 'direct' | 'macro' | 'chain'
  steps?: number
}): L2ToolManifest {
  return {
    identity: { id: opts.id, name: opts.name, version: '1.0.0', author: 'official', createdAt: 0, updatedAt: 0, templateId: 't' },
    routing: { keywords: opts.keywords, targetRoles: [], requiredL1: [], inputType: 'text', retrievalSummary: '', userSummary: '', confidenceThreshold: 0.5 },
    execution: opts.mode === 'direct'
      ? { mode: 'direct', directCall: { l1Target: 'l1-model-gateway', promptTemplate: 'p', maxTokens: 128 } }
      : { mode: opts.mode, dagPlan: { steps: Array.from({ length: opts.steps ?? 2 }, (_, i) => ({ step: i + 1, description: 'd', tool: 'llm_generate', depends_on: [], params: {}, expectedOutput: 'o' })), fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false, cacheTTL: 0 }
  } as L2ToolManifest
}

describe('tryL05QuickMatch · 准入机制', () => {
  it('单步 direct + 命中过门（hitRatio 0.6 → conf 0.9）→ 命中', () => {
    const m = makeManifest({ id: 'm1', name: '单步工具', keywords: ['翻译', '英文', '文档', '格式', '语言'], mode: 'direct' })
    const r = tryL05QuickMatch('帮我把这份文档翻译成英文', [m])
    expect(r).not.toBeNull()
    expect(r!.manifest.identity.id).toBe('m1')
    expect(r!.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('置信门等价于 hitRatio ≥ 0.533：hitRatio = 0.4（conf 0.6）→ 不命中', () => {
    // 5 个关键词命中 2 个 → hitRatio 0.4 → conf 0.6 < 0.8
    const m = makeManifest({ id: 'm2', name: '临界工具', keywords: ['甲', '乙', '丙', '丁', '戊'], mode: 'direct' })
    expect(tryL05QuickMatch('甲和乙', [m])).toBeNull()
  })

  it('hitRatio 0.333（1/3，conf 0.5）→ 不命中', () => {
    const m = makeManifest({ id: 'm3', name: '弱命中', keywords: ['甲', '乙', '丙'], mode: 'direct' })
    expect(tryL05QuickMatch('只提到甲', [m])).toBeNull()
  })

  it('多步 manifest（macro 2 步）即便关键词全中也不进 L0.5（结构性排除）', () => {
    const m = makeManifest({ id: 'm4', name: '多步工具', keywords: ['周报', '草稿'], mode: 'macro', steps: 2 })
    expect(tryL05QuickMatch('生成周报草稿', [m])).toBeNull()
  })

  it('单步 dagPlan（macro 但仅 1 步）→ 可命中', () => {
    const m = makeManifest({ id: 'm5', name: '单步宏', keywords: ['摘要', '总结'], mode: 'macro', steps: 1 })
    const r = tryL05QuickMatch('帮我摘要总结一下', [m])
    expect(r).not.toBeNull()
    expect(r!.manifest.identity.id).toBe('m5')
  })

  it('两名候选 margin 不足（并列）→ 不命中（歧义交下游消解）', () => {
    const a = makeManifest({ id: 'a', name: 'A', keywords: ['甲', '乙'], mode: 'direct' })
    const b = makeManifest({ id: 'b', name: 'B', keywords: ['甲', '乙'], mode: 'direct' })
    expect(tryL05QuickMatch('甲和乙', [a, b])).toBeNull()
  })

  it('manifest 无关键词 / 空列表 → null', () => {
    const empty = makeManifest({ id: 'e', name: '空', keywords: [], mode: 'direct' })
    expect(tryL05QuickMatch('任意输入', [empty])).toBeNull()
    expect(tryL05QuickMatch('任意输入', [])).toBeNull()
  })
})

describe('tryL05QuickMatch · 对现网 27 个 manifest 的实测覆盖（2026-09-30 记录）', () => {
  it('典型自然语言输入的命中是少数（记录现状，非期望值——门值待校准 G-15）', () => {
    const inputs = [
      '把这份中文文档翻译成英文版',
      '帮我起草一份公司公告通知',
      '给客户写一封跟进邮件',
      '帮我生成一个PPT大纲',
      '公司的年假政策是怎么规定的',
      '帮我审一下这份保密协议ND条款'
    ]
    const hits = inputs.filter(i => tryL05QuickMatch(i, l2Manifests) !== null)
    // 记录：实测 6 个针对 direct 型的输入中仅少数命中（本轮测得 1 个）。
    // 这里不断言具体数字（会随门值校准而变），只断言"确实能命中至少一个"——
    // 若某天门值收紧到连一个都不中，说明这层已彻底失效，测试会红。
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.length).toBeLessThan(inputs.length)
  })
})
