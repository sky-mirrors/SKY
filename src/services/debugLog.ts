const meta = import.meta as unknown as { env?: Record<string, unknown> }

const DEBUG = meta.env?.DEV === true

export function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args)
}
