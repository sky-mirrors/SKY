import type { DomainConstraint } from '@/models'
import { globalBus } from '@/kernel/bus'
import type { HoloEventBus } from '@/kernel/bus'
import {
  injectExternalConstraints,
  removeExternalConstraints,
  validateConstraintTestCases
} from '@/services/domainConstraints'
import { ingestPackText, deleteKnowledgeEntry } from '@/services/knowledgeBase'
import { invalidateByPack } from '@/services/semanticCache'
import { semverSatisfies } from '../pluginRegistry'
import { compilePackConstraint, validatePackConstraint } from './dsl'
import { HOOK_LAYERS } from '../types'
import type {
  PackConstraint,
  PackEvaluatorModule,
  PackExecution,
  PackExecutionManifest,
  PackKnowledgeFile,
  PackLifecycleEvent,
  PackManifest,
  PackMountError,
  PackMountResult,
  PackSource
} from './types'

/**
 * 规格书 8.4（M8）：pack 加载器。
 * 事务式分层加载（knowledge → boundary → execution），任一步失败全量回滚（逆序 disposer）；
 * mount 自检失败的单条约束标记 draft + warning（一条坏约束禁用一条，不阻挂载）；
 * 约束注入 runConstraints 管道走适配器（同 id 先装载者优先、后到跳过并告警——避免双重拦截；P3.5 起内置约束退役）。
 */

const VETO_GATES = ['pre-execute', 'pre-output'] as const
const CONSTRAINT_DOMAINS: ReadonlyArray<DomainConstraint['domain']> = ['finance', 'legal', 'hr']

interface Disposer {
  run(): Promise<void>
}

interface MountedPack {
  manifest: PackManifest
  injectedConstraintIds: string[]
  knowledgeEntryIds: string[]
  manifestIds: string[]
  /** 2026-10-01：执行层自带的 manifest 原文（供给路由候选集；随 mounted 存亡，卸载无残留） */
  executionManifests: PackExecutionManifest[]
  warnings: string[]
}

export interface PackLoaderOptions {
  source?: PackSource
  bus?: HoloEventBus
  hostVersion?: string
}

function validateManifest(manifest: unknown, packId: string): string[] {
  const errors: string[] = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['pack.json: must be an object']
  }
  const m = manifest as Record<string, unknown>
  if (m.id !== packId) {
    errors.push(`pack.json#/id: '${String(m.id)}' does not match pack directory '${packId}'`)
  }
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push('pack.json#/name: must be a non-empty string')
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push('pack.json#/version: must be a semver string')
  }
  if (typeof m.domain !== 'string' || m.domain.length === 0) {
    errors.push('pack.json#/domain: must be a non-empty string')
  }
  if (m.capabilities === undefined) {
    errors.push('pack.json#/capabilities: required')
  } else if (!m.capabilities || typeof m.capabilities !== 'object' || Array.isArray(m.capabilities)) {
    errors.push('pack.json#/capabilities: must be an object')
  } else {
    const caps = m.capabilities as Record<string, unknown>
    if (caps.hooks !== undefined) {
      if (!caps.hooks || typeof caps.hooks !== 'object') {
        errors.push('pack.json#/capabilities/hooks: must be an object')
      } else {
        const hooks = caps.hooks as Record<string, unknown>
        for (const [tier, layers] of Object.entries(hooks)) {
          if (!['advisory', 'veto', 'override'].includes(tier)) {
            errors.push(`pack.json#/capabilities/hooks/${tier}: unknown tier`)
            continue
          }
          if (!Array.isArray(layers)) {
            errors.push(`pack.json#/capabilities/hooks/${tier}: must be an array`)
            continue
          }
          const legal = tier === 'veto'
            ? (VETO_GATES as readonly string[])
            : [...HOOK_LAYERS.filter(l => l !== 'boundary')]
          for (const layer of layers) {
            if (!legal.includes(String(layer))) {
              errors.push(`pack.json#/capabilities/hooks/${tier}: unknown layer '${String(layer)}'`)
            }
          }
        }
      }
    }
  }
  return errors
}

function normalizeEvaluatorModule(mod: unknown): PackEvaluatorModule | null {
  if (!mod || typeof mod !== 'object') return null
  const record = mod as Record<string, unknown>
  if (typeof record.check === 'function') return record as unknown as PackEvaluatorModule
  const def = record.default
  if (def && typeof def === 'object' && typeof (def as Record<string, unknown>).check === 'function') {
    return def as unknown as PackEvaluatorModule
  }
  return null
}

/** 内置 pack 源：src/packs/ 目录经 vite import.meta.glob 静态收集（eager，随包编译） */
export function createBuiltinPackSource(): PackSource {
  const manifestModules = import.meta.glob('/src/packs/*/pack.json', { eager: true, import: 'default' }) as Record<string, unknown>
  const constraintModules = import.meta.glob('/src/packs/*/boundary/constraints.json', { eager: true, import: 'default' }) as Record<string, unknown>
  const knowledgeModules = import.meta.glob('/src/packs/*/knowledge/*.json', { eager: true, import: 'default' }) as Record<string, unknown>
  const evaluatorModules = import.meta.glob('/src/packs/*/boundary/evaluators/*.ts', { eager: true }) as Record<string, unknown>
  const executionModules = import.meta.glob('/src/packs/*/execution/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

  const packIdOf = (modulePath: string): string => {
    const m = /^\/src\/packs\/([^/]+)\//.exec(modulePath)
    return m ? m[1] : ''
  }
  const packIds = (): string[] => {
    const ids = new Set<string>()
    for (const path of Object.keys(manifestModules)) {
      const id = packIdOf(path)
      if (id) ids.add(id)
    }
    return [...ids]
  }

  return {
    listPackIds: packIds,
    readManifest(packId) {
      return manifestModules[`/src/packs/${packId}/pack.json`] ?? null
    },
    readConstraints(packId) {
      return constraintModules[`/src/packs/${packId}/boundary/constraints.json`] ?? null
    },
    listKnowledge(packId) {
      const files: PackKnowledgeFile[] = []
      for (const [path, data] of Object.entries(knowledgeModules)) {
        if (packIdOf(path) !== packId) continue
        if (!data || typeof data !== 'object') continue
        const rec = data as Record<string, unknown>
        if (typeof rec.filename === 'string' && typeof rec.text === 'string') {
          files.push({ filename: rec.filename, text: rec.text })
        }
      }
      return files
    },
    listEvaluators(packId) {
      const evaluators: Record<string, PackEvaluatorModule> = {}
      for (const [path, mod] of Object.entries(evaluatorModules)) {
        if (packIdOf(path) !== packId) continue
        const rel = /^\/src\/packs\/[^/]+\/(boundary\/evaluators\/.+)$/.exec(path)
        if (!rel) continue
        const normalized = normalizeEvaluatorModule(mod)
        if (normalized) evaluators[rel[1]] = normalized
      }
      return evaluators
    },
    readExecution(packId) {
      const merged: PackExecution = {}
      let found = false
      for (const [path, data] of Object.entries(executionModules)) {
        if (packIdOf(path) !== packId) continue
        found = true
        const file = /^\/src\/packs\/[^/]+\/execution\/([^/]+)\.json$/.exec(path)
        const section = file ? file[1] : ''
        if (!data || typeof data !== 'object') continue
        if (section === 'routing') merged.routing = data as PackExecution['routing']
        else if (section === 'terminology') merged.terminology = data as PackExecution['terminology']
        else if (section === 'manifests') merged.manifests = data as PackExecutionManifest[]
        else if (section === 'cases') merged.cases = data as unknown[]
      }
      return found ? merged : null
    }
  }
}

export class PackLoader {
  private mounted = new Map<string, MountedPack>()
  private lifecycleCallbacks = new Set<(e: PackLifecycleEvent) => void>()
  private readonly source: PackSource
  private readonly hostVersion: string
  private reloadChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: PackLoaderOptions = {}) {
    this.source = opts.source ?? createBuiltinPackSource()
    this.hostVersion = opts.hostVersion ?? '0.1.0'
  }

  private get bus(): HoloEventBus {
    return this.opts.bus ?? globalBus
  }

  listPackIds(): string[] {
    return this.source.listPackIds()
  }

  listMounted(): PackManifest[] {
    return [...this.mounted.values()].map(m => m.manifest)
  }

  isMounted(packId: string): boolean {
    return this.mounted.has(packId)
  }

  /**
   * P1-13：domain → 挂载 packId 归因（内置 finance/legal 与 domain 1:1）。
   * 语义缓存 packId 隔离由此获得真实 packId 来源；pack 卸载后返回 undefined，
   * 旧缓存条目因 packMatch 严格相等而不可达（双保险，另有 invalidateByPack）。
   */
  getPackIdForDomain(domain: string): string | undefined {
    for (const [packId, m] of this.mounted) {
      if (m.manifest.domain === domain) return packId
    }
    return undefined
  }

  /**
   * M16：manifest → 挂载 packId 归因（execution/manifests.json 声明的 identity.id）。
   * 竞争模式用它把 L2 候选归因到 pack；pack 未声明或已卸载返回 undefined。
   */
  getPackIdForManifest(manifestId: string): string | undefined {
    for (const [packId, m] of this.mounted) {
      if (m.manifestIds.includes(manifestId)) return packId
    }
    return undefined
  }

  /**
   * 2026-10-01：汇总已挂载 pack 自带的执行层 manifest（路由候选集装配用）。
   * 直接遍历 mounted ⇒ 卸载即消失，无需单独清理步骤（热插拔可逆、不留痕迹）。
   */
  getExecutionManifests(): PackExecutionManifest[] {
    const out: PackExecutionManifest[] = []
    for (const m of this.mounted.values()) out.push(...m.executionManifests)
    return out
  }

  /** M16：pack 竞标权重（manifest.weight ?? 1.0；未挂载同样返回默认值） */
  getWeight(packId: string): number {
    const m = this.mounted.get(packId)
    const w = m?.manifest.weight
    return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : 1.0
  }

  /** A2-9：pack 注入 runConstraints 管道的约束 id 集（快照副本；未挂载返回空） */
  getMountedConstraintIds(packId: string): string[] {
    const m = this.mounted.get(packId)
    return m ? [...m.injectedConstraintIds] : []
  }

  onLifecycle(cb: (e: PackLifecycleEvent) => void): () => void {
    this.lifecycleCallbacks.add(cb)
    return () => this.lifecycleCallbacks.delete(cb)
  }

  private emit(e: PackLifecycleEvent): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(e)
      } catch { /* listener errors never break the loader */ }
    }
    this.bus.emit(e.type, e)
  }

  private async fail(packId: string, warnings: string[], error: PackMountError, disposers: Disposer[]): Promise<PackMountResult> {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try {
        await disposers[i].run()
      } catch { /* rollback is best-effort */ }
    }
    this.emit({ type: 'pack:mount-failed', packId, phase: error.phase, reason: error.reason })
    return { ok: false, error, warnings }
  }

  async mountPack(packId: string): Promise<PackMountResult> {
    const warnings: string[] = []
    const disposers: Disposer[] = []

    if (this.mounted.has(packId)) {
      const error: PackMountError = { packId, phase: 'manifest', reason: 'already-mounted', detail: `pack ${packId} is already mounted` }
      return await this.fail(packId, warnings, error, disposers)
    }

    // 步骤 1：发现
    const rawManifest = this.source.readManifest(packId)
    if (rawManifest === null || rawManifest === undefined) {
      const error: PackMountError = { packId, phase: 'manifest', reason: 'not-found', detail: 'pack.json not found' }
      return await this.fail(packId, warnings, error, disposers)
    }

    // 步骤 3：manifest 校验
    const manifestErrors = validateManifest(rawManifest, packId)
    if (manifestErrors.length > 0) {
      const error: PackMountError = { packId, phase: 'manifest', reason: 'schema', detail: manifestErrors.join('; ') }
      return await this.fail(packId, warnings, error, disposers)
    }
    const manifest = rawManifest as PackManifest

    // 步骤 4：依赖/兼容解析
    const minHost = manifest.compatibility?.minHostVersion
    if (minHost && !semverSatisfies(this.hostVersion, minHost)) {
      const error: PackMountError = { packId, phase: 'manifest', reason: 'incompatible', detail: `host ${this.hostVersion} does not satisfy minHostVersion ${minHost}` }
      return await this.fail(packId, warnings, error, disposers)
    }

    // 步骤 5a：knowledge 层（事务式）
    const knowledgeEntryIds: string[] = []
    let knowledgeFiles: PackKnowledgeFile[]
    try {
      knowledgeFiles = this.source.listKnowledge(packId)
    } catch (err) {
      const error: PackMountError = { packId, phase: 'knowledge', reason: 'internal', detail: `list knowledge failed: ${(err as Error).message}` }
      return await this.fail(packId, warnings, error, disposers)
    }
    for (const file of knowledgeFiles) {
      try {
        const entry = await ingestPackText(file.text, packId, file.filename)
        knowledgeEntryIds.push(entry.id)
        disposers.push({
          run: async () => {
            await deleteKnowledgeEntry(entry.id)
          }
        })
      } catch (err) {
        const error: PackMountError = { packId, phase: 'knowledge', reason: 'internal', detail: `ingest failed for ${file.filename}: ${(err as Error).message}` }
        return await this.fail(packId, warnings, error, disposers)
      }
    }

    // 步骤 5b：boundary 层
    const rawConstraints = this.source.readConstraints(packId)
    const constraintItems: unknown[] = rawConstraints === null || rawConstraints === undefined
      ? []
      : rawConstraints as unknown[]
    if (!Array.isArray(constraintItems)) {
      const error: PackMountError = { packId, phase: 'boundary', reason: 'schema', detail: 'constraints.json: must be an array' }
      return await this.fail(packId, warnings, error, disposers)
    }

    const evaluators = this.source.listEvaluators(packId)
    const compiled: DomainConstraint[] = []
    let disabled = 0
    for (let i = 0; i < constraintItems.length; i++) {
      const item = constraintItems[i]
      const schemaErrors = validatePackConstraint(item, i)
      if (schemaErrors.length > 0) {
        const detail = schemaErrors.map(e => `${e.path}: ${e.reason}`).join('; ')
        const error: PackMountError = { packId, phase: 'boundary', reason: 'schema', detail }
        return await this.fail(packId, warnings, error, disposers)
      }
      const pc = item as PackConstraint

      let evaluatorModule: PackEvaluatorModule | null = null
      if (pc.evaluator) {
        evaluatorModule = evaluators[pc.evaluator] ?? null
        if (!evaluatorModule) {
          const error: PackMountError = { packId, phase: 'boundary', reason: 'schema', detail: `constraints.json#/items/${i}/evaluator: module not found: ${pc.evaluator}` }
          return await this.fail(packId, warnings, error, disposers)
        }
      }

      const domain = CONSTRAINT_DOMAINS.includes(manifest.domain as DomainConstraint['domain'])
        ? manifest.domain as DomainConstraint['domain']
        : 'legal'
      const dc = compilePackConstraint(pc, { packId, domain, evaluator: evaluatorModule })

      // mount 自检：坏一条禁一条，不阻挂载
      const selfCheck = validateConstraintTestCases(dc)
      if (!selfCheck.valid) {
        dc.status = 'draft'
        disabled++
        warnings.push(`constraint-self-check-failed:${pc.id} (${selfCheck.errors.slice(0, 2).join('; ')})`)
      }
      compiled.push(dc)
    }

    const injection = injectExternalConstraints(compiled)
    for (const s of injection.skipped) {
      warnings.push(`constraint-skipped:${s.id} (${s.reason})`)
    }
    if (injection.injected.length > 0) {
      disposers.push({
        run: async () => {
          removeExternalConstraints(injection.injected)
        }
      })
    }

    // 步骤 5c：execution 层（读入即合法空层；服务侧适配器随真实数据接入）
    const execution = this.source.readExecution(packId)
    if (execution === null) {
      // 缺 execution/ 子目录 → 视为空层，合法（规格 8.4 边界情况）
    }
    // M16：收集 execution/manifests.json 声明的 manifest identity.id（manifest→packId 归因表）
    const manifestIds: string[] = []
    const executionManifests: PackExecutionManifest[] = []
    if (Array.isArray(execution?.manifests)) {
      for (const item of execution.manifests) {
        const id = (item as { identity?: { id?: unknown } } | null)?.identity?.id
        if (typeof id === 'string' && id.length > 0) {
          manifestIds.push(id)
          executionManifests.push(item as PackExecutionManifest)
        }
      }
    }

    this.mounted.set(packId, {
      manifest,
      injectedConstraintIds: injection.injected,
      knowledgeEntryIds,
      manifestIds,
      executionManifests,
      warnings
    })
    this.emit({ type: 'pack:mounted', packId })

    return {
      ok: true,
      packId,
      constraints: { total: compiled.length, disabled },
      warnings
    }
  }

  /** 规格书 8.4 回滚路径：unmount 复用 mount 失败的同一清理序列 */
  async unmountPack(packId: string): Promise<{ ok: boolean; removedConstraints: number; removedKnowledge: number; warnings: string[] }> {
    const m = this.mounted.get(packId)
    if (!m) {
      return { ok: false, removedConstraints: 0, removedKnowledge: 0, warnings: ['not-mounted'] }
    }
    const removedConstraints = removeExternalConstraints(m.injectedConstraintIds)
    let removedKnowledge = 0
    for (const entryId of m.knowledgeEntryIds) {
      try {
        if (await deleteKnowledgeEntry(entryId)) removedKnowledge++
      } catch { /* best-effort */ }
    }
    invalidateByPack(packId)
    this.mounted.delete(packId)
    this.emit({ type: 'pack:unmounted', packId })
    return { ok: true, removedConstraints, removedKnowledge, warnings: [] }
  }

  /**
   * 规格书 8.7（M19）：开发模式热重载——完整 unmount + mount 循环（不增量更新）。
   * 限制（实施期记录）：内置 pack 经 import.meta.glob 静态编译，磁盘文件变更需整页重载后
   * glob 产物才更新；reloadPack 用于同数据下的干净重挂与显式演练。
   */
  async reloadPack(packId: string): Promise<{ ok: boolean; durationMs: number; warnings: string[] }> {
    const startedAt = Date.now()
    const run = async (): Promise<{ ok: boolean; durationMs: number; warnings: string[] }> => {
      if (this.isMounted(packId)) {
        await this.unmountPack(packId)
      }
      const result = await this.mountPack(packId)
      const durationMs = Date.now() - startedAt
      if (result.ok) {
        this.emit({ type: 'pack:reloaded', packId, durationMs })
        return { ok: true, durationMs, warnings: result.warnings }
      }
      return { ok: false, durationMs, warnings: result.warnings }
    }
    this.reloadChain = this.reloadChain.then(run, run)
    return this.reloadChain as Promise<{ ok: boolean; durationMs: number; warnings: string[] }>
  }
}
