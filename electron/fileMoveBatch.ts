/**
 * 批量移动的**扩展名过滤器**（2026-10-08 从 electron/ipc-handlers.ts 的 file:move 里抽出）。
 *
 * 为什么要抽出：这段过滤逻辑原来内联在 IPC handler 里（只有 electron 环境才跑得到），
 * 于是"过滤器语义"没有单测可钉——而它恰恰是**安全边界**：
 * `ext` 为空串时含义是「移动目录下**全部**文件」，一旦调用方在不该留空的时候留空，
 * 就会把用户没点名的文件一起搬走（真实风险，见 test/unit/l0CollectFilter.spec.ts）。
 * 抽成纯函数后：集合语义、大小写、无扩展名文件、逗号分隔表这些边界都能在 vitest 里钉死。
 *
 * 兼容性：单个扩展名的行为与旧内联实现**逐字一致**（都是 `name.toLowerCase().endsWith('.' + ext)`），
 * 只是 ext 现在可以是逗号分隔的**集合**。
 */

/**
 * 解析 ext 规格：`'docx'` / `'jpg, png'` / `'.JPG'` / `''` → 扩展名集（小写、去点、去空白）。
 * 空串或全空白 ⇒ 空数组，语义 = 不过滤（移动目录下全部文件）。
 */
export function parseExtSpec(ext?: string): string[] {
  return String(ext || '')
    .split(',')
    .map(e => e.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean)
}

/**
 * 文件名是否落在扩展名集内。
 * @param exts parseExtSpec 的结果；**空数组 = 全部通过**（调用方须确保这是用户的本意）
 */
export function matchesExtSpec(name: string, exts: string[]): boolean {
  if (!exts || exts.length === 0) return true
  const lower = String(name || '').toLowerCase()
  return exts.some(e => lower.endsWith('.' + e))
}
