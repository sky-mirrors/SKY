import type { NamespacedBus } from '@/kernel/bus'

/** 规格书 3.2：统一插件契约类型（见 docs/10-架构与分层.md 热插拔三层） */
export type PluginKind =
  | 'kernel'
  | 'cluster'
  | 'domain-pack'
  | 'tool-provider'
  | 'llm-provider'
  | 'knowledge-provider'

export type HookTier = 'advisory' | 'veto' | 'override'
export type LayerId = 'L0' | 'L0.5' | 'L1' | 'L2' | 'L3' | 'L4'
export type HookLayer = LayerId | 'boundary'

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/
export const HOOK_LAYERS: readonly HookLayer[] = ['L0', 'L0.5', 'L1', 'L2', 'L3', 'L4', 'boundary']
export const HOOK_TIERS: readonly HookTier[] = ['advisory', 'veto', 'override']

export interface PluginManifest {
  id: string
  version: string
  kind: PluginKind
  license?: 'open-source' | 'pro'
  display?: { name: string; description: string }
  dependencies?: Record<string, string>
  capabilities?: {
    priority?: number
    weight?: number
    hooks?: Partial<Record<HookLayer, HookTier[]>>
  }
}

export interface PluginConfigStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

export interface PluginLogger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

export interface SchemaValidationError {
  path: string
  reason: string
}

export interface SchemaValidator {
  validate(value: unknown, schemaName: string): { ok: boolean; errors: SchemaValidationError[] }
}

export interface PluginContext {
  bus: NamespacedBus
  config: PluginConfigStore
  logger: PluginLogger
  validate: SchemaValidator
}

export interface HoloPlugin {
  id: string
  version: string
  kind: PluginKind
  manifest: PluginManifest
  mount(ctx: PluginContext): Promise<void>
  unmount(): Promise<void>
}

export type MountResult = { ok: true } | { ok: false; errors: string[] }

export type UnregisterResult =
  | { ok: true; reason?: string }
  | { ok: false; errors: string[] }

export type LifecycleEvent =
  | { type: 'mounted'; id: string; kind: PluginKind }
  | { type: 'unmounted'; id: string }
  | { type: 'mount-failed'; id: string; error: string }
  | { type: 'zombie'; id: string; error: string }

export interface PluginMeta {
  id: string
  version: string
  kind: PluginKind
  state: 'active' | 'zombie'
  manifest: PluginManifest
}

/** 规格 3.6：PluginRegistry 接口汇总 */
export interface PluginRegistry {
  register(p: HoloPlugin): Promise<MountResult>
  unregister(id: string, opts?: { cascade?: boolean }): Promise<UnregisterResult>
  get<T extends HoloPlugin>(id: string): T | undefined
  list(kind?: PluginKind): PluginMeta[]
  onLifecycle(cb: (e: LifecycleEvent) => void): () => void
}

export function validateManifestShape(p: HoloPlugin): SchemaValidationError[] {
  const errors: SchemaValidationError[] = []
  const m = p.manifest
  if (!m || typeof m !== 'object') {
    return [{ path: 'manifest', reason: 'manifest is required' }]
  }
  if (m.id !== p.id) {
    errors.push({ path: 'manifest.id', reason: `manifest.id '${String(m.id)}' does not match plugin.id '${p.id}'` })
  }
  if (!/^\d+\.\d+\.\d+/.test(String(m.version))) {
    errors.push({ path: 'manifest.version', reason: `invalid semver: ${String(m.version)}` })
  }
  if (m.kind !== p.kind) {
    errors.push({ path: 'manifest.kind', reason: `manifest.kind '${String(m.kind)}' does not match plugin.kind '${p.kind}'` })
  }
  if (m.dependencies !== undefined) {
    if (!m.dependencies || typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)) {
      errors.push({ path: 'manifest.dependencies', reason: 'must be Record<pluginId, semver-range>' })
    } else {
      for (const [depId, range] of Object.entries(m.dependencies)) {
        if (!PLUGIN_ID_RE.test(depId)) {
          errors.push({ path: `manifest.dependencies.${depId}`, reason: 'invalid dependency plugin id' })
        }
        if (typeof range !== 'string' || range.length === 0) {
          errors.push({ path: `manifest.dependencies.${depId}`, reason: 'semver range must be a non-empty string' })
        }
      }
    }
  }
  if (m.capabilities !== undefined) {
    if (!m.capabilities || typeof m.capabilities !== 'object') {
      errors.push({ path: 'manifest.capabilities', reason: 'must be an object' })
    } else {
      const caps = m.capabilities
      if (caps.priority !== undefined && typeof caps.priority !== 'number') {
        errors.push({ path: 'manifest.capabilities.priority', reason: 'must be a number' })
      }
      if (caps.weight !== undefined && typeof caps.weight !== 'number') {
        errors.push({ path: 'manifest.capabilities.weight', reason: 'must be a number' })
      }
      if (caps.hooks !== undefined) {
        if (!caps.hooks || typeof caps.hooks !== 'object') {
          errors.push({ path: 'manifest.capabilities.hooks', reason: 'must be Partial<Record<HookLayer, HookTier[]>>' })
        } else {
          for (const [layer, tiers] of Object.entries(caps.hooks)) {
            if (!HOOK_LAYERS.includes(layer as HookLayer)) {
              errors.push({ path: `manifest.capabilities.hooks.${layer}`, reason: `unknown hook layer` })
              continue
            }
            if (!Array.isArray(tiers)) {
              errors.push({ path: `manifest.capabilities.hooks.${layer}`, reason: 'must be HookTier[]' })
              continue
            }
            for (const tier of tiers) {
              if (!HOOK_TIERS.includes(tier as HookTier)) {
                errors.push({ path: `manifest.capabilities.hooks.${layer}`, reason: `unknown hook tier: ${String(tier)}` })
              }
            }
          }
        }
      }
    }
  }
  return errors
}
