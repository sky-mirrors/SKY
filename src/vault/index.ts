interface VaultStats {
  tables: number
  rows: number
  sizeBytes: number
}

interface QueuedWrite {
  ns: string
  key: string
  value: string
  encrypted?: boolean
}

const FLUSH_BASE_DELAY = 100
const FLUSH_MAX_DELAY = 5000

class VaultClient {
  private cache: Map<string, string> = new Map()
  private dirtyKeys: Set<string> = new Set()
  // P1-29：按 key 合并写队列——后写覆盖前写，杜绝旧值在 flush 时倒灌覆盖新值
  private writeQueue: Map<string, QueuedWrite> = new Map()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushDelay: number = FLUSH_BASE_DELAY
  // P0-7：同步屏障之前写入的 key——syncFromVault 时磁盘优先，防默认值覆盖磁盘数据
  private preSyncKeys: Set<string> = new Set()
  private synced = false

  private get electronAPI(): any {
    return typeof window !== 'undefined' ? (window as any).electronAPI : undefined
  }

  private fullKeyOf(namespace: string, key: string): string {
    return `${namespace}:${key}`
  }

  async read(namespace: string, key: string): Promise<string | null> {
    const fullKey = this.fullKeyOf(namespace, key)
    if (this.cache.has(fullKey)) return this.cache.get(fullKey)!
    const api = this.electronAPI
    if (!api?.vaultRead) return this.cache.get(fullKey) ?? null
    const result = await api.vaultRead(namespace, key)
    if (result !== null && result !== undefined) {
      this.cache.set(fullKey, result)
    }
    return result ?? null
  }

  // A6-15：绕过缓存的强制磁盘读——syncFromVault 专用，外部修改可见
  private async readFromDisk(namespace: string, key: string): Promise<string | null> {
    const api = this.electronAPI
    if (!api?.vaultRead) return this.cache.get(this.fullKeyOf(namespace, key)) ?? null
    const result = await api.vaultRead(namespace, key)
    return result ?? null
  }

  async write(namespace: string, key: string, value: string, encrypted?: boolean): Promise<void> {
    const fullKey = this.fullKeyOf(namespace, key)
    this.cache.set(fullKey, value)
    const api = this.electronAPI
    if (api?.vaultWrite) await api.vaultWrite(namespace, key, value, encrypted)
  }

  async delete(namespace: string, key: string): Promise<void> {
    const fullKey = this.fullKeyOf(namespace, key)
    this.cache.delete(fullKey)
    this.dirtyKeys.delete(fullKey)
    this.writeQueue.delete(fullKey)
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
    return this.cache.get(this.fullKeyOf(namespace, key)) ?? null
  }

  writeCache(namespace: string, key: string, value: string): void {
    const fullKey = this.fullKeyOf(namespace, key)
    this.cache.set(fullKey, value)
    this.dirtyKeys.add(fullKey)
    if (!this.synced) this.preSyncKeys.add(fullKey)
    this.scheduleFlush()
  }

  writeThrough(namespace: string, key: string, value: string, encrypted?: boolean): void {
    const fullKey = this.fullKeyOf(namespace, key)
    this.cache.set(fullKey, value)
    this.writeQueue.set(fullKey, { ns: namespace, key, value, encrypted })
    if (!this.synced) this.preSyncKeys.add(fullKey)
    this.scheduleFlush()
  }

  async syncFromVault(): Promise<void> {
    // 先落盘本地未 flush 的写，保证随后的磁盘读反映本窗口的写入
    await this.flushNow()
    const allKeys = await this.list()
    for (const fullKey of allKeys) {
      const colonIdx = fullKey.indexOf(':')
      if (colonIdx < 0) continue
      const ns = fullKey.slice(0, colonIdx)
      const key = fullKey.slice(colonIdx + 1)
      // A6-15：绕过缓存直读磁盘，缓存中已被短路的旧值得以刷新
      const value = await this.readFromDisk(ns, key)
      if (value !== null) {
        this.cache.set(fullKey, value)
        // P0-7：同步屏障前的写入按磁盘为准——丢弃其过期排队写，防止默认值落盘覆盖真实数据
        if (this.preSyncKeys.has(fullKey)) {
          this.writeQueue.delete(fullKey)
          this.dirtyKeys.delete(fullKey)
          this.preSyncKeys.delete(fullKey)
        }
      }
    }
    // 同步屏障前写入、磁盘上不存在的 key：保留排队写（首启新数据）
    this.preSyncKeys.clear()
    this.synced = true
  }

  async flushToVault(): Promise<void> {
    await this.flushNow()
  }

  // P1-28：统一 flush 入口——逐条捕获失败、失败重新入队、指数退避
  async flushNow(): Promise<void> {
    const entries = Array.from(this.writeQueue.values())
    for (const entry of entries) {
      this.writeQueue.delete(this.fullKeyOf(entry.ns, entry.key))
    }
    let failed = 0
    for (const entry of entries) {
      try {
        await this.write(entry.ns, entry.key, entry.value, entry.encrypted)
      } catch (err) {
        failed++
        console.error('[vault] 写入失败，重新入队待重试:', err)
        this.writeQueue.set(this.fullKeyOf(entry.ns, entry.key), entry)
      }
    }
    const dirty = Array.from(this.dirtyKeys)
    for (const fullKey of dirty) {
      const colonIdx = fullKey.indexOf(':')
      if (colonIdx < 0) {
        this.dirtyKeys.delete(fullKey)
        continue
      }
      const ns = fullKey.slice(0, colonIdx)
      const key = fullKey.slice(colonIdx + 1)
      const value = this.cache.get(fullKey)
      if (value === undefined) {
        this.dirtyKeys.delete(fullKey)
        continue
      }
      try {
        await this.write(ns, key, value)
        this.dirtyKeys.delete(fullKey)
      } catch (err) {
        failed++
        console.error('[vault] 脏键 flush 失败，保留待重试:', err)
      }
    }
    if (failed > 0) {
      // 指数退避：持续失败时 100ms → 200ms → ... → 5s 封顶，成功后归位
      this.flushDelay = Math.min(this.flushDelay * 2, FLUSH_MAX_DELAY)
      this.scheduleFlush()
    } else {
      this.flushDelay = FLUSH_BASE_DELAY
    }
  }

  // A6-14：退出前的尽力 flush——invoke 的 IPC 消息在调用时即同步发出，
  // 即便渲染层随后被销毁，主进程通常仍能收到
  flushBeforeUnload(): void {
    const api = this.electronAPI
    if (!api?.vaultWrite) return
    const pending: QueuedWrite[] = Array.from(this.writeQueue.values())
    this.writeQueue.clear()
    for (const fullKey of this.dirtyKeys) {
      const colonIdx = fullKey.indexOf(':')
      if (colonIdx < 0) continue
      const value = this.cache.get(fullKey)
      if (value === undefined) continue
      pending.push({ ns: fullKey.slice(0, colonIdx), key: fullKey.slice(colonIdx + 1), value })
    }
    this.dirtyKeys.clear()
    for (const entry of pending) {
      try {
        const p = api.vaultWrite(entry.ns, entry.key, entry.value, entry.encrypted)
        if (p && typeof p.catch === 'function') p.catch(() => { /* best-effort */ })
      } catch { /* best-effort */ }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null
      try {
        await this.flushNow()
      } catch (err) {
        console.error('[vault] flush 循环异常，退避后重试:', err)
        this.flushDelay = Math.min(this.flushDelay * 2, FLUSH_MAX_DELAY)
        this.scheduleFlush()
      }
    }, this.flushDelay)
  }

  clearCache(): void {
    this.cache.clear()
    this.dirtyKeys.clear()
    this.writeQueue.clear()
    this.preSyncKeys.clear()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushDelay = FLUSH_BASE_DELAY
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

// A6-14：窗口卸载时尽力排空写队列与脏键，避免丢失最后 100ms 的写入
if (typeof window !== 'undefined') {
  const flushOnQuit = () => { vault.flushBeforeUnload() }
  window.addEventListener('beforeunload', flushOnQuit)
  window.addEventListener('pagehide', flushOnQuit)
}

export function useVault(): VaultClient {
  return vault
}

export type { VaultClient, VaultStats }
