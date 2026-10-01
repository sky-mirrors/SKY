import type {
  ConstraintApplicability,
  ConstraintReliability,
  ConstraintResult,
  ConstraintSource,
  ConstraintTestCase,
  DomainConstraint
} from '@/models'
import type { LayerId, HookTier } from '../types'

/**
 * 规格书 8.2 / 8.3：DomainPack schema 类型（docs/HOTPLUG-ARCHITECTURE.md 第 8 节）。
 * 修订记录（实施期）：trigger 增设 keywordGroups（各组任一命中、组间 AND），
 * 用于表达 #1 这类"两组任一关键词 AND"的触发语义。
 */

export type PackVetoGate = 'pre-execute' | 'pre-output'

export interface PackManifest {
  id: string
  name: string
  version: string
  license?: 'open-source' | 'commercial'
  domain: string
  priority?: number
  weight?: number
  needsUserKnowledge?: boolean
  capabilities?: {
    hooks?: {
      advisory?: Array<LayerId | PackVetoGate>
      veto?: PackVetoGate[]
      override?: LayerId[]
    }
    clusters?: string[]
  }
  compatibility?: { minHostVersion?: string }
}

export interface NumericCaptureRule {
  pattern: string
  captureGroup?: number
  compare: '>' | '>=' | '<' | '<=' | '=='
  threshold: number
  unitHint?: string
}

export interface EntityCountRule {
  type: string
  minCount?: number
}

export interface ConstraintTrigger {
  keywords?: string[]
  allKeywords?: string[]
  excludeKeywords?: string[]
  keywordGroups?: string[][]
  entities?: EntityCountRule[]
  numericCapture?: NumericCaptureRule[]
}

export interface ConstraintAction {
  severity: ConstraintResult['severity']
  messageTemplate: string
  requireHumanReview?: boolean
  humanJudgmentPrompt?: string | null
  matchedEntityTypes?: string[]
}

export interface PackConstraint {
  id: string
  category: string
  description: string
  severity: ConstraintResult['severity']
  applicability: ConstraintApplicability
  reliability: ConstraintReliability
  automationLevel?: 'full' | 'semi'
  reviewType?: 'auto' | 'manual'
  trigger: ConstraintTrigger
  action: ConstraintAction
  evaluator?: string | null
  testCases: ConstraintTestCase[]
  sources?: ConstraintSource[]
}

/** 逃生舱模块：与现状 check 五字段兼容签名（8.5 步骤 2） */
export interface PackEvaluatorModule {
  check(context: Parameters<DomainConstraint['check']>[0]): ConstraintResult | null
}

export interface PackRouting {
  domainBias?: Record<string, number>
}

export interface PackTerminology {
  terms?: Array<{ from: string; to: string }>
}

/**
 * 2026-10-01：pack 执行层自带的 manifest（用户裁定「下载后自动接到路由，不等待认领」）。
 * `identity` 必填；`routing` / `execution` 等实现字段可选——缺失部分由装配点与内置表
 * 深度合并补全。只写 `identity` 即等价于旧的「认领」语义（对既有 3 个 pack 向后兼容）。
 */
export interface PackExecutionManifest {
  identity: { id: string; name?: string; version?: string }
  routing?: Record<string, unknown>
  visual?: Record<string, unknown>
  execution?: Record<string, unknown>
  cacheMeta?: Record<string, unknown>
  ruleBasedFallback?: Record<string, unknown>
}

export interface PackExecution {
  routing?: PackRouting
  terminology?: PackTerminology
  manifests?: PackExecutionManifest[]
  cases?: unknown[]
}

export interface PackKnowledgeFile {
  filename: string
  text: string
}

/** pack 各层文件的统一数据源（内置 pack 由 vite import.meta.glob 实现；测试可注入内存源） */
export interface PackSource {
  listPackIds(): string[]
  readManifest(packId: string): unknown | null
  readConstraints(packId: string): unknown | null
  listKnowledge(packId: string): PackKnowledgeFile[]
  listEvaluators(packId: string): Record<string, PackEvaluatorModule>
  readExecution(packId: string): PackExecution | null
}

export type PackMountPhase = 'manifest' | 'knowledge' | 'boundary' | 'execution'

export interface PackMountError {
  packId: string
  phase: PackMountPhase
  reason: 'json-parse' | 'schema' | 'conflict' | 'already-mounted' | 'incompatible' | 'not-found' | 'internal'
  detail: string
}

export type PackMountResult =
  | {
      ok: true
      packId: string
      constraints: { total: number; disabled: number }
      warnings: string[]
    }
  | { ok: false; error: PackMountError; warnings: string[] }

export interface PackMeta {
  id: string
  version: string
  domain: string
  manifest: PackManifest
  constraintIds: string[]
  knowledgeEntryIds: string[]
}

export type PackLifecycleEvent =
  | { type: 'pack:mounted'; packId: string }
  | { type: 'pack:mount-failed'; packId: string; phase: PackMountPhase; reason: string }
  | { type: 'pack:unmounted'; packId: string }
  | { type: 'pack:reloaded'; packId: string; durationMs: number }
