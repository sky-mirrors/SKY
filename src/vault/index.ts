interface VaultStats {
  tables: number
  rows: number
  sizeBytes: number
}

class VaultClient {
  private cache: Map<string, string> = new Map()
  private dirtyKeys: Set<string> = new Set()
  private writeQueue: Array<{ ns: string; key: string; value: string; encrypted?: boolean }> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private get electronAPI(): any {
    return typeof window !== 'undefined' ? (window as any).electronAPI : undefined
  }

  async read(namespace: string, key: string): Promise<string | null> {
    const fullKey = `${namespace}:${key}`
    if (this.cache.has(fullKey)) return this.cache.get(fullKey)!
    const api = this.electronAPI
    if (!api?.vaultRead) return this.cache.get(fullKey) ?? null
    const result = await api.vaultRead(namespace, key)
    if (result !== null && result !== undefined) {
      this.cache.set(fullKey, result)
    }
    return result ?? null
  }

  async write(namespace: string, key: string, value: string, encrypted?: boolean): Promise<void> {
    const fullKey = `${namespace}:${key}`
    this.cache.set(fullKey, value)
    const api = this.electronAPI
    if (api?.vaultWrite) await api.vaultWrite(namespace, key, value, encrypted)
  }

  async delete(namespace: string, key: string): Promise<void> {
    const fullKey = `${namespace}:${key}`
    this.cache.delete(fullKey)
    this.dirtyKeys.delete(fullKey)
    const api = this.electronAPI
    if (api?.vaultDelete) await api.vaultDelete(namespace, key)
  }

  async list(namespace?: string): Promise<string[]> {
    const api = this.electronAPI
    if (!api?.vaultList) {
      const keys: string[] = []
      for (const k of this.cache.keys()) {
        if (!namespace || k.startsWith(namespace + ':')) keys.push(k)
      }
      return keys
    }
    return api.vaultList(namespace) ?? []
  }

  async readVector(namespace: string, key: string): Promise<{ metadata: string; embedding: string } | null> {
    const api = this.electronAPI
    return api?.vaultReadVector?.(namespace, key) ?? null
  }

  async writeVector(namespace: string, key: string, metadata: string, embeddingBase64: string): Promise<void> {
    const api = this.electronAPI
    if (api?.vaultWriteVector) await api.vaultWriteVector(namespace, key, metadata, embeddingBase64)
  }

  async deleteVector(namespace: string, key: string): Promise<void> {
    const api = this.electronAPI
    if (api?.vaultDeleteVector) await api.vaultDeleteVector(namespace, key)
  }

  async listVectors(namespace?: string): Promise<string[]> {
    const api = this.electronAPI
    return api?.vaultListVectors?.(namespace) ?? []
  }

  async migrate(localStorageData: Record<string, string>): Promise<{ migrated: number; errors: number }> {
    const api = this.electronAPI
    return api?.vaultMigrate?.(localStorageData) ?? { migrated: 0, errors: 0 }
  }

  async getStats(): Promise<VaultStats> {
    const api = this.electronAPI
    return api?.vaultGetStats?.() ?? { tables: 0, rows: 0, sizeBytes: 0 }
  }

  readCache(namespace: string, key: string): string | null {
    return this.cache.get(`${namespace}:${key}`) ?? null
  }

  writeCache(namespace: string, key: string, value: string): void {
    const fullKey = `${namespace}:${key}`
    this.cache.set(fullKey, value)
    this.dirtyKeys.add(fullKey)
    this.scheduleFlush()
  }

  writeThrough(namespace: string, key: string, value: string, encrypted?: boolean): void {
    const fullKey = `${namespace}:${key}`
    this.cache.set(fullKey, value)
    this.writeQueue.push({ ns: namespace, key, value, encrypted })
    this.scheduleFlush()
  }

  async syncFromVault(): Promise<void> {
    const allKeys = await this.list()
    for (const fullKey of allKeys) {
      const colonIdx = fullKey.indexOf(':')
      if (colonIdx < 0) continue
      const ns = fullKey.slice(0, colonIdx)
      const key = fullKey.slice(colonIdx + 1)
      const value = await this.read(ns, key)
      if (value !== null) {
        this.cache.set(fullKey, value)
      }
    }
  }

  async flushToVault(): Promise<void> {
    for (const fullKey of this.dirtyKeys) {
      const colonIdx = fullKey.indexOf(':')
      if (colonIdx < 0) continue
      const ns = fullKey.slice(0, colonIdx)
      const key = fullKey.slice(colonIdx + 1)
      const value = this.cache.get(fullKey)
      if (value !== undefined) {
        await this.write(ns, key, value)
      }
    }
    this.dirtyKeys.clear()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      const items = this.writeQueue.splice(0)
      for (const item of items) {
        await this.write(item.ns, item.key, item.value, item.encrypted)
      }
    }, 100)
  }

  clearCache(): void {
    this.cache.clear()
    this.dirtyKeys.clear()
    this.writeQueue = []
  }

  collectLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {}
    if (typeof localStorage === 'undefined') return data
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('holo-')) {
        const val = localStorage.getItem(key)
        if (val !== null) data[key] = val
      }
    }
    return data
  }
}

export const vault = new VaultClient()

export function useVault(): VaultClient {
  return vault
}

export type { VaultClient, VaultStats }
