import { HoloEventBus, globalBus, BusLedger, scanOrphanChannels } from '@/kernel/bus'
import type {
  HoloPlugin, HookLayer, HookTier, LifecycleEvent, MountResult,
  PluginKind, PluginMeta, PluginRegistry as IPluginRegistry, UnregisterResult,
} from './types'
import { PLUGIN_ID_RE, validateManifestShape } from './types'
import { createPluginContext, createVaultConfigBackend } from './context'
import type { ConfigBackend } from './context'

/** 最小 semver 满足判断：支持 '*'、精确 x.y.z、^、~、比较符与逗号分隔 AND */
export function semverSatisfies(version: string, range: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const cmp = (a: [number, number, number], b: [number, number, number]): number => {
    if (a[0] !== b[0]) return a[0] - b[0]
    if (a[1] !== b[1]) return a[1] - b[1]
    return a[2] - b[2]
  }
  const ver = parse(version)
  if (!ver) return false
  const clauses = range.split('&&').flatMap(part => part.split(/,(?![^\s]*\|)/)).map(c => c.trim()).filter(Boolean)
  if (clauses.length === 0) return true
  for (const clause of clauses) {
    if (clause === '*' || clause === 'x') continue
    const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(clause)
    if (caret) {
      const base: [number, number, number] = [Number(caret[1]), Number(caret[2]), Number(caret[3])]
      if (cmp(ver, base) < 0) return false
      if (base[0] > 0 ? ver[0] !== base[0] : (ver[0] !== 0 || ver[1] !== base[1])) return false
      continue
    }
    const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(clause)
    if (tilde) {
      const base: [number, number, number] = [Number(tilde[1]), Number(tilde[2]), Number(tilde[3])]
      if (cmp(ver, base) < 0) return false
      if (ver[0] !== base[0] || ver[1] !== base[1]) return false
      continue
    }
    const op = /^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(clause)
    if (!op) return false
    const target: [number, number, number] = [Number(op[2]), Number(op[3]), Number(op[4])]
    const c = cmp(ver, target)
    const operator = op[1] ?? '='
    if (operator === '=' && c !== 0) return false
    if (operator === '>' && c <= 0) return false
    if (operator === '<' && c >= 0) return false
    if (operator === '>=' && c < 0) return false
    if (operator === '<=' && c > 0) return false
  }
  return true
}

interface RegistryEntry {
  plugin: HoloPlugin
  state: 'active' | 'zombie'
}

export interface PluginRegistryOptions {
  bus?: HoloEventBus
  ledger?: BusLedger
  mountTimeoutMs?: number
  configBackend?: ConfigBackend
}

/**
 * 规格 3.3/3.4/3.7：插件注册表
 * - M1 注册：id/manifest 校验 → 依赖解析+环检测 → mount 带超时 → 失败全量回滚；超时置 zombie；重入防护
 * - M2 卸载：依赖拒绝 → unmount 容错 → 台账清理 → 孤儿扫描 → 出册
 * - M14 权限：manifest.capabilities.hooks 快照进缓存，checkPermission 永不抛入主流程
 */
export class PluginRegistry implements IPluginRegistry {
  private entries = new Map<string, RegistryEntry>()
  private mounting = new Set<string>()
  private permissionCache = new Map<string, Partial<Record<HookLayer, HookTier[]>> | undefined>()
  private lifecycleCallbacks = new Set<(e: LifecycleEvent) => void>()
  private readonly ledger: BusLedger
  private readonly mountTimeoutMs: number

  constructor(private readonly opts: PluginRegistryOptions = {}) {
    this.ledger = opts.ledger ?? new BusLedger()
    this.mountTimeoutMs = opts.mountTimeoutMs ?? 10_000
  }

  private get bus(): HoloEventBus {
    return this.opts.bus ?? globalBus
  }

  async register(p: HoloPlugin): Promise<MountResult> {
    if (!p || !PLUGIN_ID_RE.test(p.id ?? '')) {
      return { ok: false, errors: ['invalid-id'] }
    }
    if (this.mounting.has(p.id)) {
      return { ok: false, errors: ['reentrant: mount in progress'] }
    }
    const existing = this.entries.get(p.id)
    if (existing) {
      if (existing.state === 'zombie') {
        return { ok: false, errors: ['zombie: previous mount timed out'] }
      }
      return { ok: false, errors: [`duplicate-id: ${p.id}`] }
    }

    const shapeErrors = validateManifestShape(p)
    if (shapeErrors.length > 0) {
      return { ok: false, errors: shapeErrors.map(e => `${e.path}: ${e.reason}`) }
    }

    // M1.3 依赖解析
    const missing: string[] = []
    const versionMismatch: string[] = []
    const deps = p.manifest.dependencies ?? {}
    for (const [depId, range] of Object.entries(deps)) {
      const dep = this.entries.get(depId)
      if (!dep || dep.state === 'zombie') {
        missing.push(depId)
      } else if (!semverSatisfies(dep.plugin.version, range)) {
        versionMismatch.push(`${depId}@${dep.plugin.version} does not satisfy ${range}`)
      }
    }
    if (missing.length > 0 || versionMismatch.length > 0) {
      const errors: string[] = []
      if (missing.length > 0) errors.push(`missing-deps: [${missing.join(', ')}]`)
      if (versionMismatch.length > 0) errors.push(`version-mismatch: [${versionMismatch.join('; ')}]`)
      return { ok: false, errors }
    }

    // M1.4 环检测
    const cycle = this.findDependencyCycle(p)
    if (cycle) {
      return { ok: false, errors: [`dependency-cycle: ${cycle.join(' -> ')}`] }
    }

    // M1.5/M1.6 mount 带超时
    this.mounting.add(p.id)
    const ctx = createPluginContext(p.id, {
      bus: this.bus,
      ledger: this.ledger,
      configBackend: this.opts.configBackend ?? createVaultConfigBackend(),
    })
    try {
      await withTimeout(p.mount(ctx), this.mountTimeoutMs, `mount-timeout: ${p.id}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 全量回滚：台账中该插件已记录的全部 disposer 容错执行
      this.ledger.runAll(p.id)
      if (message.startsWith('mount-timeout')) {
        this.entries.set(p.id, { plugin: p, state: 'zombie' })
        this.emitLifecycle({ type: 'zombie', id: p.id, error: message })
        return { ok: false, errors: [`mount-failed: ${message}`] }
      }
      this.emitLifecycle({ type: 'mount-failed', id: p.id, error: message })
      return { ok: false, errors: [`mount-failed: ${message}`] }
    } finally {
      this.mounting.delete(p.id)
    }

    this.entries.set(p.id, { plugin: p, state: 'active' })
    this.permissionCache.set(p.id, p.manifest.capabilities?.hooks)
    this.emitLifecycle({ type: 'mounted', id: p.id, kind: p.kind })
    return { ok: true }
  }

  async unregister(id: string, opts?: { cascade?: boolean }): Promise<UnregisterResult> {
    const entry = this.entries.get(id)
    if (!entry) {
      console.warn(`[plugin-registry] unregister: id not found: ${id}`)
      return { ok: true, reason: 'not-present' }
    }
    if (entry.state === 'zombie') {
      return { ok: false, errors: ['zombie: previous mount timed out'] }
    }
    // M2.1 依赖检查
    const dependents: string[] = []
    for (const other of this.entries.values()) {
      if (other.plugin.id === id || other.state !== 'active') continue
      if (other.plugin.manifest.dependencies && id in other.plugin.manifest.dependencies) {
        dependents.push(other.plugin.id)
      }
    }
    if (dependents.length > 0) {
      if (opts?.cascade) {
        return { ok: false, errors: [`cascade-not-supported: [${dependents.join(', ')}]`] }
      }
      return { ok: false, errors: [`has-dependents: [${dependents.join(', ')}]`] }
    }
    // M2.2 unmount 容错
    try {
      await entry.plugin.unmount()
    } catch (err) {
      console.error(`[plugin-registry] unmount-error: ${id}`, err)
    }
    // M2.3 台账清理
    this.ledger.runAll(id)
    // M2.4 孤儿扫描
    scanOrphanChannels(this.bus, new Set(this.activeIds()))
    // M2.5 出册
    this.entries.delete(id)
    this.permissionCache.delete(id)
    this.emitLifecycle({ type: 'unmounted', id })
    return { ok: true }
  }

  get<T extends HoloPlugin>(id: string): T | undefined {
    const entry = this.entries.get(id)
    return entry && entry.state === 'active' ? (entry.plugin as T) : undefined
  }

  list(kind?: PluginKind): PluginMeta[] {
    const result: PluginMeta[] = []
    for (const entry of this.entries.values()) {
      if (kind && entry.plugin.kind !== kind) continue
      result.push({
        id: entry.plugin.id,
        version: entry.plugin.version,
        kind: entry.plugin.kind,
        state: entry.state,
        manifest: entry.plugin.manifest,
      })
    }
    return result
  }

  onLifecycle(cb: (e: LifecycleEvent) => void): () => void {
    this.lifecycleCallbacks.add(cb)
    return () => this.lifecycleCallbacks.delete(cb)
  }

  /** M14: 运行时权限校验——永不抛入主流程 */
  checkPermission(pluginId: string, layer: HookLayer, tier: HookTier): boolean {
    const entry = this.entries.get(pluginId)
    if (!entry || entry.state !== 'active') {
      console.error(`[plugin-registry] permission-cache-missing: ${pluginId}`)
      return false
    }
    const hooks = this.permissionCache.get(pluginId)
    if (!hooks) return false
    const tiers = hooks[layer]
    if (!tiers || !tiers.includes(tier)) {
      console.warn(`[plugin-registry] permission-denied: ${pluginId} ${tier}@${layer}`)
      return false
    }
    return true
  }

  ledgerSize(ownerId: string): number {
    return this.ledger.size(ownerId)
  }

  private activeIds(): string[] {
    const ids: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.state === 'active') ids.push(entry.plugin.id)
    }
    return ids
  }

  private findDependencyCycle(candidate: HoloPlugin): string[] | null {
    const visiting: string[] = [candidate.id]
    const visited = new Set<string>()
    const dfs = (pluginId: string): string[] | null => {
      const entry = pluginId === candidate.id ? { plugin: candidate } : this.entries.get(pluginId)
      if (!entry) return null
      const deps = Object.keys(entry.plugin.manifest.dependencies ?? {})
      for (const depId of deps) {
        if (depId === candidate.id) {
          return [...visiting, depId]
        }
        if (visited.has(depId)) continue
        visiting.push(depId)
        const found = dfs(depId)
        if (found) return found
        visiting.pop()
      }
      visited.add(pluginId)
      return null
    }
    return dfs(candidate.id)
  }

  private emitLifecycle(e: LifecycleEvent): void {
    for (const cb of this.lifecycleCallbacks) {
      try {
        cb(e)
      } catch (err) {
        console.error('[plugin-registry] lifecycle-callback error:', err)
      }
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      err => { clearTimeout(timer); reject(err) }
    )
  })
}
