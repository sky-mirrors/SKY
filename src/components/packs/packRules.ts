/**
 * 领域包编辑器里「规则草稿 ⟷ boundary\constraints.json」的纯转换。
 *
 * 为什么单独抽成模块（`PackEditor.vue` 无组件挂载测试工具，抽出来才能单测）——
 * 这里修掉两个真实的**往返不幂等**缺陷：
 *  1. 约束 id 原先按下标生成（`${packId}-rule-${i+1}`），且回读时不带 id：
 *     重新打开再保存，所有规则 id 整体重排 —— 规则身份丢失，
 *     将来做「规则级反馈/统计」无法把两次保存的同一规则对齐。
 *  2. 依据（ref）写进 `reliability.source.name`，同时固定填
 *     `source.article = '见上'`；回读时又把 name + article 拼回 ref ——
 *     **每往返一次，依据尾巴就多一个「见上」**。
 * 现在把往返做成幂等：id 已有则原样复用、ref 只认 `source.name`。
 */

export interface RuleDraft {
  id: string
  keywords: string
  message: string
  ref: string
  severity: string
}

export interface UserConstraint {
  id: string
  category: string
  description: string
  severity: string
  applicability: { jurisdiction: string }
  reliability: {
    confidence: string
    source: { type: string; name: string; article: string; effectiveDate: string }
  }
  automationLevel: string
  trigger: { keywordGroups: string[][] }
  action: { severity: string; messageTemplate: string }
  evaluator: null
}

const CONFIDENCE = 'medium'
const ARTICLE_PLACEHOLDER = '见上'
const EFFECTIVE_DATE = '以现行版本为准'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 触发词组串 → 分组数组（分号分组、组内逗号；语义见编辑器提示）。 */
export function parseKeywordGroups(raw: string): string[][] {
  return raw
    .split(';')
    .map(g => g.split(',').map(s => s.trim()).filter(Boolean))
    .filter(g => g.length > 0)
}

/** 分组数组 → 触发词组串（回读展示，与 parseKeywordGroups 互逆）。 */
export function formatKeywordGroups(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  return raw
    .map(g => (Array.isArray(g) ? g.map(text).filter(Boolean).join(',') : ''))
    .filter(Boolean)
    .join(';')
}

/**
 * constraints.json 数组 → 规则草稿。
 * 容错：非数组 / 非对象项一律跳过（坏文件不阻断编辑器）。
 * ref 只取 `reliability.source.name` —— `article` 是宿主填的占位，回读会污染。
 */
export function constraintsToDrafts(raw: unknown): RuleDraft[] {
  if (!Array.isArray(raw)) return []
  const out: RuleDraft[] = []
  for (const item of raw) {
    const c = asRecord(item)
    if (!c) continue
    const action = asRecord(c.action)
    const source = asRecord(asRecord(c.reliability)?.source)
    const trigger = asRecord(c.trigger)
    out.push({
      id: text(c.id),
      keywords: formatKeywordGroups(trigger?.keywordGroups),
      message: text(action?.messageTemplate) || text(c.description),
      ref: source ? text(source.name) : '',
      severity: text(action?.severity) || text(c.severity) || 'warning'
    })
  }
  return out
}

/**
 * 规则草稿 → constraints.json 数组。
 * id 已有则原样复用；空 id 或缺省时用 `genId()` 生成，并在本批内去重
 * （`genId` 偶发重复时会重试到唯一）。
 */
export function draftsToConstraints(drafts: RuleDraft[], genId: () => string): UserConstraint[] {
  const used = new Set<string>()
  return drafts.map((d) => {
    let id = d.id.trim()
    if (!id || used.has(id)) {
      do {
        id = genId()
      } while (used.has(id))
    }
    used.add(id)
    return {
      id,
      category: '用户自定义',
      description: d.message,
      severity: d.severity,
      applicability: { jurisdiction: 'PRC' },
      reliability: {
        confidence: CONFIDENCE,
        source: { type: 'manual', name: d.ref, article: ARTICLE_PLACEHOLDER, effectiveDate: EFFECTIVE_DATE }
      },
      automationLevel: 'full',
      trigger: { keywordGroups: parseKeywordGroups(d.keywords) },
      action: { severity: d.severity, messageTemplate: d.message },
      evaluator: null
    }
  })
}
