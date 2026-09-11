import type { PersistencePort } from '../types'

export const localStoragePersistence: PersistencePort = {
  get(key: string): string | null {
    return localStorage.getItem(key)
  },
  set(key: string, value: string): void {
    localStorage.setItem(key, value)
  },
  delete(key: string): void {
    localStorage.removeItem(key)
  },
  keys(): string[] {
    const result: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null) result.push(k)
    }
    return result
  },
}

export function createNamespacedPersistence(prefix: string, inner?: PersistencePort): PersistencePort {
  const port = inner ?? localStoragePersistence
  return {
    get(key: string): string | null {
      return port.get(`${prefix}${key}`)
    },
    set(key: string, value: string): void {
      port.set(`${prefix}${key}`, value)
    },
    delete(key: string): void {
      port.delete(`${prefix}${key}`)
    },
    keys(): string[] {
      return port.keys().filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
    },
  }
}
