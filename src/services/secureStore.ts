type StoreValue = string | number | boolean | object | null

async function fileStoreAvailable(): Promise<boolean> {
  try {
    return !!(window.electronAPI?.storeRead)
  } catch {
    return false
  }
}

export async function storeGet(key: string): Promise<StoreValue | null> {
  try {
    if (await fileStoreAvailable()) {
      const result = await window.electronAPI.storeRead(key)
      if (result !== null) return result as StoreValue
    }
  } catch { /* fallback to localStorage */ }
  try {
    const raw = localStorage.getItem(`holo-${key}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export async function storeSet(key: string, value: StoreValue): Promise<boolean> {
  let fileOk = false
  try {
    if (await fileStoreAvailable()) {
      fileOk = await window.electronAPI.storeWrite(key, value)
    }
  } catch { /* fallback */ }
  try {
    localStorage.setItem(`holo-${key}`, JSON.stringify(value))
    return true
  } catch {
    return fileOk
  }
}

export async function storeDelete(key: string): Promise<boolean> {
  let fileOk = false
  try {
    if (await fileStoreAvailable()) {
      fileOk = await window.electronAPI.storeDelete(key)
    }
  } catch { /* fallback */ }
  try {
    localStorage.removeItem(`holo-${key}`)
    return true
  } catch {
    return fileOk
  }
}

export async function migrateFromLocalStorage(keys: string[]): Promise<number> {
  let migrated = 0
  if (!(await fileStoreAvailable())) return 0
  for (const key of keys) {
    try {
      const fileVal = await window.electronAPI.storeRead(key)
      if (fileVal !== null) continue
      const raw = localStorage.getItem(`holo-${key}`)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      await window.electronAPI.storeWrite(key, parsed)
      migrated++
    } catch { /* skip this key */ }
  }
  return migrated
}
