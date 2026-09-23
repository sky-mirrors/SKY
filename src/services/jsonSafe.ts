/**
 * JSON 容错工具（2026-09-23 事故后补）
 *
 * 事故复盘：`api-config.json` 被写成「BOM + `{}`」共 5 字节 ⇒ 加载时 `JSON.parse` 抛
 * `Unexpected token '', "{}" is not valid JSON` ⇒ 应用表现为「没有模型配置」⇒ 所有 LLM 调用失败
 * （考试 0%、普通对话无回复）。更糟的是：vault 读取处**静默返回 null**，使故障长期隐形。
 *
 * 因此：解析持久化/外部字符串一律走本模块——**剥 BOM + 容错 + 失败可见**。
 */

/** 剥离 UTF-8 BOM（U+FEFF）。Windows 侧工具/编辑器常写入：`EF BB BF`。 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * 容错解析：先剥 BOM，再 `JSON.parse`；失败**返回 null 并打可见告警**（不再静默）。
 * @param raw 待解析字符串（可为 null/undefined）
 * @param context 出错时用于定位的上下文名（如 `vault:api-config`）
 */
export function parseJsonSafe<T = unknown>(raw: string | null | undefined, context = 'json'): T | null {
  if (raw == null) return null
  try {
    return JSON.parse(stripBom(raw)) as T
  } catch (err) {
    console.warn(`[jsonSafe] ${context} 解析失败（已剥离 BOM 仍失败，内容前 80 字）：${stripBom(String(raw)).slice(0, 80)}`, String(err).slice(0, 120))
    return null
  }
}
