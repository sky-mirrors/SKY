import { vault } from '@/vault'
import type { VaultClient } from '@/vault'
import { NamespacedBus, BusLedger, HoloEventBus, globalBus } from '@/kernel/bus'
import type {
  PluginConfigStore, PluginContext, PluginLogger, SchemaValidator,
  HoloPlugin, SchemaValidationError,
} from './types'
import { validateManifestShape } from './types'

export interface ConfigBackend {
  read(namespace: string, key: string): Promise<string | null>
  write(namespace: string, key: string, value: string): Promise<void>
  delete(namespace: string, key: string): Promise<void>
  list(namespace: string): Promise<string[]>
}

export function createVaultConfigBackend(v: VaultClient = vault): ConfigBackend {
  return {
    read: (ns, key) => v.read(ns, key),
    write: (ns, key, value) => v.write(ns, key, value),
    delete: (ns, key) => v.delete(ns, key),
    list: async (ns) => (await v.list(ns)).map(full => full.startsWith(ns + ':') ? full.slice(ns.length + 1) : full),
  }
}

export function pluginConfigStore(pluginId: string, backend: ConfigBackend): PluginConfigStore {
  const ns = `plugin:${pluginId}:config`
  return {
    get: (key) => backend.read(ns, key),
    set: (key, value) => backend.write(ns, key, value),
    delete: (key) => backend.delete(ns, key),
    list: () => backend.list(ns),
  }
}

export function pluginLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`
  return {
    debug: (msg, ...args) => console.debug(prefix, msg, ...args),
    info: (msg, ...args) => console.info(prefix, msg, ...args),
    warn: (msg, ...args) => console.warn(prefix, msg, ...args),
    error: (msg, ...args) => console.error(prefix, msg, ...args),
  }
}

const schemaValidator: SchemaValidator = {
  validate(value: unknown, schemaName: string): { ok: boolean; errors: SchemaValidationError[] } {
    if (schemaName === 'plugin-manifest') {
      const errors = validateManifestShape(value as HoloPlugin)
      return { ok: errors.length === 0, errors }
    }
    return { ok: false, errors: [{ path: '', reason: `unknown-schema: ${schemaName}` }] }
  },
}

export interface PluginContextDeps {
  bus?: HoloEventBus
  ledger: BusLedger
  configBackend?: ConfigBackend
}

/** 规格 3.2 PluginContext 构造：NamespacedBus + 私有配置 + 前缀日志 + schema 校验器 */
export function createPluginContext(pluginId: string, deps: PluginContextDeps): PluginContext {
  const bus = deps.bus ?? globalBus
  const nsBus = new NamespacedBus(pluginId, bus, deps.ledger)
  return {
    bus: nsBus,
    config: pluginConfigStore(pluginId, deps.configBackend ?? createVaultConfigBackend()),
    logger: pluginLogger(pluginId),
    validate: schemaValidator,
  }
}
