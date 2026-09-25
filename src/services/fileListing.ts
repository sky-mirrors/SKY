/**
 * 目录清单的确定性收口（叶子模块：纯函数、零依赖，供 macroExecutor 与 l0SkillRouter 共用）。
 *
 * 背景：Q14「列桌面 .docx 清单」由 `buildExplorePlan` 产出三步探索计划
 * （list_directory → read_file{{step_1_top_files}} → llm_generate 综合），末步把
 * 「把目录清单转述成一份清单」交给本地弱模型（qwen2.5:3b）——实测 6 个文件名首尾粘连、
 * 无任何分隔符，判卷 not-deliverable（`exam-report.json` Q14 多轮恒现）。
 * 这件事本身是**确定性可做**的，不该交给模型综合。
 *
 * 修法（HANDOFF「下一步 1」做法②）：识别「列某目录下某类文件」意图时，产出**单步**
 * `list_directory` + `ext` —— 计划全为原生工具 ⇒ `confirmPlan` 的 `isAllNative` 快路径
 * 直接呈现工具结果、**不经模型**。本模块负责扩展名过滤与清单渲染。
 *
 * 渲染格式（务必保持）：结果经 `confirmPlan` 的 `stripHtml(beautify(text))` 呈现
 * （`beautify` 默认 format='html'）。`beautify` 把每个非空行包成 `<p>…</p>`、`stripHtml`
 * 再把 `<p>` 还原为换行 ⇒ **纯文本换行**的清单能保真。反之若用 markdown 列表
 * （`- x` / `1. x`）会被 beautify 渲染成 `<li>`，而 `stripHtml` 对 `<li>` 无换行处理
 * ⇒ 各条目粘连——正是本模块要消除的失败形态。故此处只用纯文本换行，绝不用 markdown 列表。
 */

export interface ListingEntry {
  name: string
  isDir?: boolean
}

/** 常见别名 → 规范扩展名（"word 文档" 视同 docx 等）。 */
const EXT_ALIAS: Record<string, string> = {
  word: 'docx',
  xls: 'xlsx',
  ppt: 'pptx',
  markdown: 'md',
  jpg: 'jpeg'
}

/**
 * 从自然语言里抽出「要列出的文件扩展名」（无则返回 null）。
 * 覆盖 `.docx` / `docx 格式` / `docx 文件` / `word 文档` 等写法；去前导点、统一小写、收编别名。
 */
export function extractListingExt(input: string): string | null {
  const m = String(input || '').match(
    /\.?(docx|word|pdf|txt|md|markdown|xlsx|xls|csv|json|pptx|ppt|html|png|jpe?g|gif)\b/i
  )
  if (!m) return null
  const raw = m[1].toLowerCase()
  return EXT_ALIAS[raw] ?? raw
}

/**
 * 判定是否为「列清单」意图（列出/有哪些…），并排除「读内容/找信息」意图。
 * 只有「列清单」才走确定性收口；「读出内容再回答」（如 Q16 报销金额）仍需 list→read→llm 三步。
 */
export function isListingIntent(input: string): boolean {
  const LIST = /(列出|列举|清单|列表|有哪些|哪些|有什么|多少个|几个|一共|共有)/
  const READ =
    /(内容|金额|多少钱|是多少|写了什么|说的是什么|读一下|读取|打开.{0,4}看|总结|概括|根据.{0,6}内容|里面写|里面说|讲的什么|翻译|译文)/
  return LIST.test(input) && !READ.test(input)
}

/**
 * 按扩展名过滤目录项：只保留文件（排除子目录），扩展名大小写不敏感，**保持原顺序**（不重排——
 * 清单如实反映目录内容，且 readdir 顺序本身即确定）。
 */
export function filterByExt(entries: ListingEntry[], ext: string): string[] {
  const suffix = '.' + String(ext || '').replace(/^\./, '').toLowerCase()
  if (suffix === '.') return []
  return entries
    .filter(e => e && typeof e.name === 'string' && !e.isDir)
    .map(e => e.name)
    .filter(name => name.toLowerCase().endsWith(suffix))
}

/**
 * 渲染确定性清单文本（纯文本换行，见模块头注释为何不用 markdown 列表）。
 * 空结果如实说明「未找到」，不编造。
 */
export function formatExtListing(dir: string, ext: string, files: string[]): string {
  const extLabel = String(ext || '').replace(/^\./, '').toLowerCase()
  if (files.length === 0) return `${dir} 目录下未找到 .${extLabel} 文件。`
  return `${dir} 目录下的 .${extLabel} 文件共 ${files.length} 个：\n${files.join('\n')}`
}
