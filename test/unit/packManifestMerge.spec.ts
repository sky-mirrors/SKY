import { describe, it, expect } from 'vitest'
import { mergePackManifests } from '@/host/pack/merge'
import type { PackExecutionManifest } from '@/host/pack/types'
import type { L2ToolManifest } from '@/models'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-01：pack 执行层供给 → 路由候选集（用户裁定「下载后自动接到路由，不等待认领」）
//
// 语义边界（本文件锁定）：
//   - pack 提供 routing + execution ⇒ 可执行供给：同 id 覆盖内置（字段级、pack 优先）、新 id 新增；
//   - 只写 identity（旧「认领」写法）⇒ 跳过，内置表不动（对既有 finance/hr/legal 向后兼容）。
// 纯函数：不修改入参，返回新数组。
// ─────────────────────────────────────────────────────────────────────────────

function builtin(id: string, extra: Partial<L2ToolManifest> = {}): L2ToolManifest {
  return {
    identity: { id, name: `内置-${id}`, version: '1.0.0', author: 'official', createdAt: 1, updatedAt: 1, templateId: 't' },
    visual: { baseColor: '#000', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' },
    routing: { keywords: ['内置词'], targetRoles: ['general'], requiredL1: [], inputType: 'text', retrievalSummary: '', userSummary: '', confidenceThreshold: 0.7 },
    execution: { dagPlan: { steps: [] } },
    cacheMeta: { ttlMs: 0, maxEntries: 0 },
    ...extra
  } as L2ToolManifest
}

const FULL_PACK_MANIFEST: PackExecutionManifest = {
  identity: { id: 'l2-from-pack-v1', name: 'pack 自带工具', version: '2.0.0' },
  routing: { keywords: ['pack 词'] },
  execution: { dagPlan: { steps: [{ step: 1, tool: 'llm_generate' }] } }
}

describe('mergePackManifests · pack 执行层并入路由候选集', () => {
  it('无 pack 供给 → 返回内置表副本（长度不变）', () => {
    const base = [builtin('a'), builtin('b')]
    const out = mergePackManifests(base, [])
    expect(out).toHaveLength(2)
    expect(out).not.toBe(base) // 新数组，不改入参
  })

  it('只写 identity 的「认领」包 → 跳过，内置表不动（向后兼容 3 个既有 pack）', () => {
    const base = [builtin('l2-resume-screening-v1')]
    const claimOnly: PackExecutionManifest = { identity: { id: 'l2-resume-screening-v1', name: '简历初筛助手', version: '1.0.0' } }
    const out = mergePackManifests(base, [claimOnly])
    expect(out).toHaveLength(1)
    expect(out[0].routing.keywords).toEqual(['内置词']) // 未被半截认领覆盖
    expect(out[0].identity.templateId).toBe('t') // identity 未被降级
  })

  it('pack 自带完整 manifest（新 id）→ 新增进候选集', () => {
    const base = [builtin('a')]
    const out = mergePackManifests(base, [FULL_PACK_MANIFEST])
    expect(out).toHaveLength(2)
    const added = out.find(m => m.identity.id === 'l2-from-pack-v1')
    expect(added).toBeDefined()
    expect(added!.routing.keywords).toEqual(['pack 词'])
  })

  it('pack 自带同 id → 字段级覆盖（pack 优先），identity 与内置合并保留 author 等', () => {
    const base = [builtin('l2-from-pack-v1')]
    const out = mergePackManifests(base, [FULL_PACK_MANIFEST])
    expect(out).toHaveLength(1)
    expect(out[0].routing.keywords).toEqual(['pack 词']) // pack 覆盖
    expect(out[0].identity.author).toBe('official') // 内置字段保留
    expect(out[0].identity.version).toBe('2.0.0') // pack 覆盖
  })

  it('不修改入参（内置表与 pack 供给均保持原样）', () => {
    const base = [builtin('l2-from-pack-v1')]
    const snapshot = JSON.stringify(base)
    mergePackManifests(base, [FULL_PACK_MANIFEST])
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})
