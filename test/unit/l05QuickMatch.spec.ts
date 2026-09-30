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
 * 机制（`l0SkillRouter.ts` 的 `tryL05QuickMatch`）：
 *   ① hitRatio = 命中关键词数 / 该 manifest 关键词总数，须 ≥ 0.4；
 *   ② 与第二名的 hitRatio 差（margin）须 ≥ 0.1；
 *   ③ confidence = min(hitRatio × 1.5, 1.0)（① ② 任一不满足则为 0）——本函数只做这道**基本过滤**；
 *      **是否放行由 funnel 的 `l05Pass`（默认 0.6）决定**。2026-09-30 移除了内层的硬门
 *      `confidence >= 0.8`：它把过门线钉死在 hitRatio ≥ 0.533，且遮蔽了该 gate 的配置面
 *      （调低永不生效）；
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

  it('内层只做基本过滤（hitRatio ≥ 0.4 + margin ≥ 0.1）：hitRatio 0.4 → 返回候选（conf 0.6）', () => {
    // 2026-09-30：内层硬门 `confidence >= 0.8` 已移除——它把过门线钉在 hitRatio ≥ 0.533，
    // 且**遮蔽 funnel 的 l05Pass 配置面**（调低永不生效）。现在是否放行由 `l05Pass` 决定。
    const m = makeManifest({ id: 'm2', name: '临界工具', keywords: ['甲', '乙', '丙', '丁', '戊'], mode: 'direct' })
    const r = tryL05QuickMatch('甲和乙', [m])
    expect(r).not.toBeNull()
    expect(r!.confidence).toBeCloseTo(0.6, 5)
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

describe('tryL05QuickMatch · 门值校准基线（2026-09-30 实测）', () => {
  // 校准方法与数据：24 条标注输入（10 条期望命中某个单步 manifest，14 条负样本——
  // 含 6 条"含 manifest 关键词但形态不同"的对抗样本：竞品分析/合同风险/邮件分类/
  // 财报总结/会议纪要 均为 macro|chain，及一条两个单步 manifest 混搭）。扫门值的实测：
  //
  //   t ≤ 0.60 → 放行 7/24，正确 7/10，错配 0，误报 0/14
  //   t ≥ 0.65 → 放行 1/24（断崖：conf 是离散值，最小非零档即 0.6）
  //   t = 0.90 → 放行 0/24（彻底死层）
  //
  // 结论：0.60 是"放行全部通过基本过滤的候选"的下界，且在本样本集上**零误配**；
  // 再高就会把 hitRatio=0.4 那一档全部挡掉（旧门 0.8 即如此，实测覆盖率 ~8%）。
  // 本 describe 把这个不变量钉住——若将来门值/公式改动引入误配，这里会红。
  const LABELED: Array<[string, string | null]> = [
    ['把这份中文文档翻译成英文版', '文档翻译英文版'],
    ['帮我起草一份公司公告通知', '公告通知草稿'],
    ['给客户写一封跟进邮件', '客户邮件撰写'],
    ['帮我生成一个PPT大纲', 'PPT大纲生成'],
    ['公司的年假政策是怎么规定的', '政策文档问答'],
    ['帮我审一下这份保密协议ND条款', 'ND审查清单'],
    ['这段内容帮我译成英文', '文档翻译英文版'],
    ['写个公告说说下周团建', '公告通知草稿'],
    ['给张总发封邮件跟一下项目进度', '客户邮件撰写'],
    ['来个PPT的大纲', 'PPT大纲生成'],
    // 负样本：应下沉（不下沉到 L0.5）
    ['帮我生成本周周报草稿', null],
    ['检查这张报销单是否合规', null],
    ['对比这两份合同的差异条款', null],
    ['把 C:\\a.txt 复制到 C:\\b.txt', null],
    ['今天天气怎么样', null],
    ['帮我写一个快速排序函数', null],
    ['列出桌面的所有 docx 文件', null],
    ['把这份 pdf 转成 txt', null],
    ['帮我写一份竞品分析报告', null],
    ['总结一下这份合同的风险条款', null],
    ['把这几封邮件分类整理一下', null],
    ['给这份财报做个一句话总结', null],
    ['帮我做个会议纪要', null],
    ['帮我生成PPT大纲并翻译成英文', null]
  ]

  it('门值 0.6 下：放行的候选全部正确，负样本一条都不放行（零误配）', () => {
    const PASS = 0.6
    let falsePositive = 0
    let wrongManifest = 0
    let correct = 0
    for (const [input, expect] of LABELED) {
      const r = tryL05QuickMatch(input, l2Manifests)
      const passed = r !== null && r.confidence >= PASS
      if (!passed) continue
      if (expect === null) falsePositive++
      else if (r!.manifest.identity.name === expect) correct++
      else wrongManifest++
    }
    expect(falsePositive).toBe(0)
    expect(wrongManifest).toBe(0)
    expect(correct).toBeGreaterThanOrEqual(7) // 实测 7；若掉说明门值/公式收紧了
  })

  it('门值抬到 0.65 会断崖：放行数骤降（证明 0.6→0.8 的旧门等价于死层）', () => {
    const countAt = (t: number) =>
      LABELED.filter(([i]) => {
        const r = tryL05QuickMatch(i, l2Manifests)
        return r !== null && r.confidence >= t
      }).length
    expect(countAt(0.6)).toBeGreaterThan(countAt(0.65))
    expect(countAt(0.65)).toBeLessThanOrEqual(1)
  })

  it('l05Auto(0.9) 观察：本标注集内无 conf ≥ 0.9 的命中 → 自动执行门几乎不触发', () => {
    const high = LABELED.filter(([i]) => {
      const r = tryL05QuickMatch(i, l2Manifests)
      return r !== null && r.confidence >= 0.9
    })
    // conf ≥ 0.9 需 hitRatio ≥ 0.6（命中六成关键词），自然语言罕见——实测 0 例。
    // 这是**保守取舍而非缺陷**：L0.5 命中后仍需用户确认才执行（l05Auto 是风险门），
    // 不触发不造成功能损失。此断言是提醒点：若门值/公式改动让这一档大量出现，需重新评估
    // 自动执行面是否过大。
    expect(high.length).toBeLessThanOrEqual(1)
  })
})

