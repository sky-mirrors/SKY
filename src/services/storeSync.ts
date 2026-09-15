/**
 * D-13：跨窗口 store 同步的 Map 序列化/还原。
 * JSON.stringify(Map) 会得到 '{}'——回传后 $patch 把 store 里的 Map 覆盖成普通对象，
 * 渲染循环每帧 `.keys()`/`.values()` 抛 TypeError → 星图黑屏
 * （nodeStore.nodeVisualEvents / feedbackStore.weights 均受影响）。
 * 同步侧统一打 __holoMap 信封，应用侧还原 Map；目标为 Map 而传入非 Map 信封时丢弃该键（防旧格式崩溃）。
 */

interface MapEnvelope {
  __holoMap: [unknown, unknown][]
}

export function isMapEnvelope(v: unknown): v is MapEnvelope {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && Array.isArray((v as Record<string, unknown>).__holoMap)
}

export function serializeStoreState(state: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {}
  for (const k of Object.keys(state)) {
    const v = state[k]
    wrapped[k] = v instanceof Map ? { __holoMap: Array.from(v.entries()) } as MapEnvelope : v
  }
  return JSON.parse(JSON.stringify(wrapped)) as Record<string, unknown>
}

/**
 * 应用侧过滤：目标键当前是 Map 时仅接受信封并还原；否则按原值透传。
 */
export function filterPatchForStore(
  targetState: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {}
  for (const k of Object.keys(targetState)) {
    if (!(k in incoming)) continue
    const current = targetState[k]
    const value = incoming[k]
    if (current instanceof Map) {
      if (isMapEnvelope(value)) {
        filtered[k] = new Map(value.__holoMap)
      }
      // D-13：非信封（如旧格式序列化的 {}）一律丢弃，防止 Map 被覆盖成普通对象
    } else {
      filtered[k] = value
    }
  }
  return filtered
}
