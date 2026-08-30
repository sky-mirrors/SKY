const DEBUG = (typeof import.meta !== 'undefined' && (import.meta as Record<string, unknown>).env)
  ? (import.meta as Record<string, Record<string, string>>).env?.DEV === true
  : process.env.HOLO_DEBUG === '1'

export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args)
}
