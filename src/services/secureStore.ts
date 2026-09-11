type StoreValue = string | number | boolean | object | null

import { vault } from '@/vault'

export async function storeGet(key: string): Promise<StoreValue | null> {
  try {
    const result = await vault.read('secure', `holo-${key}`)
    if (result !== null) return JSON.parse(result)
  } catch { /* fallback */ }
  try {
    const raw = vault.readCache('secure', `holo-${key}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function storeSet(key: string, value: StoreValue): Promise<boolean> {
  try {
    await vault.write('secure', `holo-${key}`, JSON.stringify(value))
    return true
  } catch {
    try {
      vault.writeThrough('secure', `holo-${key}`, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }
}

export async function storeDelete(key: string): Promise<boolean> {
  try {
    await vault.delete('secure', `holo-${key}`)
    return true
  } catch {
    return false
  }
}

export async function migrateFromLocalStorage(keys: string[]): Promise<number> {
  let migrated = 0
  for (const key of keys) {
    try {
      const existing = await vault.read('secure', `holo-${key}`)
      if (existing !== null) continue
      const raw = vault.readCache('secure', `holo-${key}`)
      if (!raw) continue
      await vault.write('secure', `holo-${key}`, raw)
      migrated++
    } catch { /* skip this key */ }
  }
  return migrated
}
