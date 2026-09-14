import type {
  ConstraintCheckContext,
  ConstraintResult,
  DomainConstraint,
  ExtractedEntity
} from '@/models'
import type { SchemaValidationError } from '../types'
import type { PackConstraint, PackEvaluatorModule } from './types'

/**
 * 规格书 8.5（M9）：约束 DSL 评估器。
 * - evaluator 非空 → 逃生舱优先（五字段兼容签名，调用方 try/catch 包裹）；
 * - DSL 评估全部 AND：keywords 任一 / allKeywords 全部 / excludeKeywords 全不 / keywordGroups 组内任一且组间全满足（修订扩展）/
 *   entities 逐 type 计数 ≥ minCount / numericCapture 逐条正则捕获并按 compare/threshold 比较；
 * - 触发 → 按 action 生成 ConstraintResult，messageTemplate 渲染 {{capture[i]}} / {{entity[type]}} / {{keyword}}。
 */

const SEVERITIES = ['info', 'warning', 'error'] as const
const COMPARES = ['>', '>=', '<', '<=', '=='] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function err(errors: SchemaValidationError[], path: string, reason: string): void {
  errors.push({ path, reason })
}

function validateStringArray(errors: SchemaValidationError[], value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length === 0)) {
    err(errors, path, 'must be a non-empty-string array')
  }
}

/** 8.3 schema 校验：错误精确到 constraints.json#/items/<i>/<字段路径> */
export function validatePackConstraint(value: unknown, index: number): SchemaValidationError[] {
  const errors: SchemaValidationError[] = []
  const base = `constraints.json#/items/${index}`
  if (!isRecord(value)) {
    return [{ path: base, reason: 'constraint must be an object' }]
  }
  const c = value

  for (const field of ['id', 'category', 'description'] as const) {
    if (typeof c[field] !== 'string' || (c[field] as string).length === 0) {
      err(errors, `${base}/${field}`, 'must be a non-empty string')
    }
  }
  if (!SEVERITIES.includes(c.severity as (typeof SEVERITIES)[number])) {
    err(errors, `${base}/severity`, `must be one of ${SEVERITIES.join('|')}`)
  }
  if (!isRecord(c.applicability) || typeof (c.applicability as Record<string, unknown>).jurisdiction !== 'string') {
    err(errors, `${base}/applicability`, 'must be { jurisdiction: string, ... }')
  }
  if (!isRecord(c.reliability)) {
    err(errors, `${base}/reliability`, 'must be { confidence, source, ... }')
  } else {
    const rel = c.reliability
    if (!['high', 'medium', 'low'].includes(String(rel.confidence))) {
      err(errors, `${base}/reliability/confidence`, 'must be high|medium|low')
    }
    if (!isRecord(rel.source) || typeof (rel.source as Record<string, unknown>).name !== 'string') {
      err(errors, `${base}/reliability/source`, 'must be { type, name, article, effectiveDate, ... }')
    } else {
      const src = rel.source as Record<string, unknown>
      if (typeof src.article !== 'string' || typeof src.effectiveDate !== 'string') {
        err(errors, `${base}/reliability/source`, 'article and effectiveDate must be strings')
      }
    }
  }
  if (c.automationLevel !== undefined && !['full', 'semi'].includes(String(c.automationLevel))) {
    err(errors, `${base}/automationLevel`, 'must be full|semi')
  }
  if (c.reviewType !== undefined && !['auto', 'manual'].includes(String(c.reviewType))) {
    err(errors, `${base}/reviewType`, 'must be auto|manual')
  }

  if (!isRecord(c.trigger)) {
    err(errors, `${base}/trigger`, 'trigger is required')
  } else {
    const t = c.trigger
    if (t.keywords !== undefined) validateStringArray(errors, t.keywords, `${base}/trigger/keywords`)
    if (t.allKeywords !== undefined) validateStringArray(errors, t.allKeywords, `${base}/trigger/allKeywords`)
    if (t.excludeKeywords !== undefined) validateStringArray(errors, t.excludeKeywords, `${base}/trigger/excludeKeywords`)
    if (t.keywordGroups !== undefined) {
      if (!Array.isArray(t.keywordGroups) || t.keywordGroups.length === 0) {
        err(errors, `${base}/trigger/keywordGroups`, 'must be a non-empty string[][]')
      } else {
        ;(t.keywordGroups as unknown[]).forEach((g, gi) => {
          if (!Array.isArray(g) || g.length === 0 || g.some(kw => typeof kw !== 'string' || kw.length === 0)) {
            err(errors, `${base}/trigger/keywordGroups/${gi}`, 'must be a non-empty-string array')
          }
        })
      }
    }
    if (t.entities !== undefined) {
      if (!Array.isArray(t.entities)) {
        err(errors, `${base}/trigger/entities`, 'must be EntityCountRule[]')
      } else {
        ;(t.entities as unknown[]).forEach((e, ei) => {
          if (!isRecord(e) || typeof e.type !== 'string') {
            err(errors, `${base}/trigger/entities/${ei}`, 'must be { type: string, minCount?: number }')
          } else if (e.minCount !== undefined && typeof e.minCount !== 'number') {
            err(errors, `${base}/trigger/entities/${ei}/minCount`, 'must be a number')
          }
        })
      }
    }
    if (t.numericCapture !== undefined) {
      if (!Array.isArray(t.numericCapture)) {
        err(errors, `${base}/trigger/numericCapture`, 'must be NumericCaptureRule[]')
      } else {
        ;(t.numericCapture as unknown[]).forEach((n, ni) => {
          if (!isRecord(n)) {
            err(errors, `${base}/trigger/numericCapture/${ni}`, 'must be { pattern, compare, threshold, ... }')
            return
          }
          if (typeof n.pattern !== 'string' || n.pattern.length === 0) {
            err(errors, `${base}/trigger/numericCapture/${ni}/pattern`, 'must be a non-empty regex-source string')
          } else {
            try {
              new RegExp(n.pattern)
            } catch (e) {
              err(errors, `${base}/trigger/numericCapture/${ni}/pattern`, `invalid regex: ${(e as Error).message}`)
            }
          }
          if (!COMPARES.includes(n.compare as (typeof COMPARES)[number])) {
            err(errors, `${base}/trigger/numericCapture/${ni}/compare`, `must be one of ${COMPARES.join('|')}`)
          }
          if (typeof n.threshold !== 'number') {
            err(errors, `${base}/trigger/numericCapture/${ni}/threshold`, 'must be a number')
          }
          if (n.captureGroup !== undefined && typeof n.captureGroup !== 'number') {
            err(errors, `${base}/trigger/numericCapture/${ni}/captureGroup`, 'must be a number')
          }
        })
      }
    }
  }

  if (!isRecord(c.action)) {
    err(errors, `${base}/action`, 'action is required')
  } else {
    const a = c.action
    if (!SEVERITIES.includes(a.severity as (typeof SEVERITIES)[number])) {
      err(errors, `${base}/action/severity`, `must be one of ${SEVERITIES.join('|')}`)
    }
    if (typeof a.messageTemplate !== 'string' || a.messageTemplate.length === 0) {
      err(errors, `${base}/action/messageTemplate`, 'must be a non-empty string')
    }
    if (a.requireHumanReview !== undefined && typeof a.requireHumanReview !== 'boolean') {
      err(errors, `${base}/action/requireHumanReview`, 'must be a boolean')
    }
    if (a.humanJudgmentPrompt !== undefined && a.humanJudgmentPrompt !== null && typeof a.humanJudgmentPrompt !== 'string') {
      err(errors, `${base}/action/humanJudgmentPrompt`, 'must be a string or null')
    }
    if (a.matchedEntityTypes !== undefined) {
      validateStringArray(errors, a.matchedEntityTypes, `${base}/action/matchedEntityTypes`)
    }
  }

  if (c.evaluator !== undefined && c.evaluator !== null && typeof c.evaluator !== 'string') {
    err(errors, `${base}/evaluator`, 'must be a string path or null')
  }

  if (!Array.isArray(c.testCases) || c.testCases.length < 2) {
    err(errors, `${base}/testCases`, 'must have at least 2 test cases')
  } else {
    ;(c.testCases as unknown[]).forEach((tc, ti) => {
      if (!isRecord(tc) || typeof tc.description !== 'string' || typeof tc.input !== 'string' || typeof tc.expectedTrigger !== 'boolean') {
        err(errors, `${base}/testCases/${ti}`, 'must be { description, input, expectedTrigger, expectedMessage? }')
      }
    })
  }

  return errors
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some(kw => text.includes(kw))
}

function compareNumber(value: number, op: NumericCompare, threshold: number): boolean {
  if (op === '>') return value > threshold
  if (op === '>=') return value >= threshold
  if (op === '<') return value < threshold
  if (op === '<=') return value <= threshold
  return value === threshold
}

type NumericCompare = (typeof COMPARES)[number]

function renderTemplate(
  template: string,
  captures: string[],
  entities: ExtractedEntity[],
  firstKeyword: string
): string {
  return template
    .replace(/\{\{capture\[(\d+)\]\}\}/g, (_m, i) => captures[Number(i)] ?? '')
    .replace(/\{\{entity\[([^\]]+)\]\}\}/g, (_m, type) => {
      const e = entities.find(ent => ent.type === type)
      return e ? e.raw : ''
    })
    .replace(/\{\{keyword\}\}/g, firstKeyword)
}

export interface CompileOptions {
  packId: string
  domain: DomainConstraint['domain']
  evaluator?: PackEvaluatorModule | null
  now?: number
}

/**
 * 规格书 8.5：DSL 约束 → DomainConstraint（含 check 闭包）。
 * 状态初始化沿用原内置装载规则（P3.5 退役后此处即唯一规则来源）：
 * automationLevel==='full' && reviewType==='auto' → 'active'，其余 → 'testing'。
 */
export function compilePackConstraint(pc: PackConstraint, opts: CompileOptions): DomainConstraint {
  const automationLevel = pc.automationLevel ?? 'full'
  const reviewType = pc.reviewType ?? 'auto'
  const now = opts.now ?? Date.now()

  const constraint: DomainConstraint = {
    id: pc.id,
    domain: opts.domain,
    category: pc.category,
    description: pc.description,
    severity: pc.severity,
    applicability: pc.applicability,
    reliability: pc.reliability,
    testCases: pc.testCases,
    status: automationLevel === 'full' && reviewType === 'auto' ? 'active' : 'testing',
    triggerCount: 0,
    falsePositiveCount: 0,
    lastTriggeredAt: 0,
    createdAt: now,
    updatedAt: now,
    automationLevel,
    humanJudgmentPrompt: pc.action.humanJudgmentPrompt ?? undefined,
    reviewType,
    check(ctx) {
      if (opts.evaluator) {
        return opts.evaluator.check(ctx)
      }
      return evaluateDsl(pc, ctx)
    }
  }
  return constraint
}

function evaluateDsl(pc: PackConstraint, ctx: ConstraintCheckContext): ConstraintResult | null {
  const merged = ctx.sourceText + ' ' + ctx.outputText
  const t = pc.trigger

  let firstKeyword = ''
  if (t.keywords && t.keywords.length > 0) {
    const hit = t.keywords.find(kw => merged.includes(kw))
    if (!hit) return null
    firstKeyword = hit
  }
  if (t.allKeywords && !t.allKeywords.every(kw => merged.includes(kw))) return null
  if (t.excludeKeywords && t.excludeKeywords.some(kw => merged.includes(kw))) return null
  if (t.keywordGroups) {
    for (const group of t.keywordGroups) {
      if (!hasKeyword(merged, group)) return null
    }
  }
  if (t.entities) {
    for (const rule of t.entities) {
      const count = ctx.entities.filter(e => e.type === rule.type).length
      if (count < (rule.minCount ?? 1)) return null
    }
  }

  const captures: string[] = []
  if (t.numericCapture) {
    for (const rule of t.numericCapture) {
      let re: RegExp
      try {
        re = new RegExp(rule.pattern)
      } catch {
        return null
      }
      const m = re.exec(merged)
      if (!m) return null
      const group = rule.captureGroup ?? 1
      const raw = m[group]
      if (raw === undefined) return null
      const value = parseFloat(raw)
      if (Number.isNaN(value)) return null
      if (!compareNumber(value, rule.compare, rule.threshold)) return null
      captures.push(raw)
    }
  }

  const matchedEntities: ExtractedEntity[] = []
  if (pc.action.matchedEntityTypes) {
    for (const type of pc.action.matchedEntityTypes) {
      matchedEntities.push(...ctx.entities.filter(e => e.type === type))
    }
  }

  return {
    triggered: true,
    constraintId: pc.id,
    severity: pc.action.severity,
    message: renderTemplate(pc.action.messageTemplate, captures, ctx.entities, firstKeyword),
    reliability: pc.reliability,
    matchedEntities: matchedEntities.length > 0 ? matchedEntities : undefined,
    requiresHumanConfirmation: pc.action.requireHumanReview === true ? true : undefined,
    humanJudgmentPrompt: pc.action.humanJudgmentPrompt ?? undefined,
    automationLevel: pc.automationLevel
  }
}
