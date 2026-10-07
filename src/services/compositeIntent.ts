/**
 * 组合意图识别 + 组合计划引擎（2026-10-07 立，2026-10-08 接上数据驱动引擎）
 *
 * 背景（真实缺陷）：用户在无正确选项时被迫在候选里选，最终被带沟里——
 * 「将桌面上的docx文档全都放在一个新建的文件夹中」给出了 create_docx / doc_extract / 文档翻译 /
 * 合同风险审查 五个完全不沾边的候选（top=create_docx 70%），用户只能选 1，系统于是**真去建了一份 Word 文档**。
 *
 * 结构性原因：候选池 = 已编译的成品 manifest + 部分工具名，而"建目录/移动"这类**可组合算子**
 * （尤其刻意不进模型工具表的 `create_directory`）**结构性缺席** ⇒ 对"组合请求"而言，
 * **候选机制不可能给出正确选项**，给候选只会把系统的不确定性转嫁成用户的挫败。
 *
 * 因此：**候选消歧只适用于"多个成品都能满足"；需要"组合"时应转规划**（L3/L4 已有规划能力）。
 * 本模块提供三件事：
 *   ① 判据 `looksComposite()`——请求是否表现为**多个动作家族**的组合（供候选守卫用）；
 *   ② 过滤器 `resolveCollectFilter()`——"归类哪些文件"：显式扩展名 → 类型词扩展名集 → fail-closed（见下）；
 *   ③ 引擎 `matchCompositePlan()`——**读 `src/data/compositeCombos.json` 产计划**：加一条组合 = 加一条数据，不改代码。
 *
 * 计划形态的三条硬约束（都是踩过坑换来的）：
 *   · **缺能力优先于组合**：用户要求的动作我们没有算子时（解压、批量转格式、批量改后缀、多目标分拣），
 *     绝不产出"少做一半"的计划——只把 zip 搬个家却不解压 = 对用户的静默降级。
 *   · **过滤器不得无界**：`file_move` 批量形态的 `ext` 为空串 = 移动目录下**全部**文件
 *     （electron/ipc-handlers.ts 的 `!wantExt || endsWith`）。用户说了类型词却识别不出来时若回落空串，
 *     就会把用户桌面搬空；故类型词映射不出扩展名集时 fail-closed（如实澄清），不放行无界移动。
 *   · **无类型词（"文件"）才允许空过滤器**：那是用户字面要求的"全部文件"。
 */

/**
 * 组合意图表：数据在 src/data/compositeCombos.json（engine 的唯一输入）。
 * 表内字段语义见该文件 $comment；本模块只消费，不复制知识。
 */
import combosTable from '@/data/compositeCombos.json'

/** 动作家族：同一家族内的近义词只算一次（避免"新建/创建/建"被数成三个动作） */
const ACTION_FAMILIES: Array<{ name: string; words: RegExp }> = [
  // 2026-10-08：mkdir 家族补「新的/一个/另一个 + 文件夹」——用户写「移动到一个**新的**文件夹」
  // 与写「移动到**新建**的文件夹」是同一件事，只认"新建"会让前者掉出组合判据
  // （引擎要求 mkdir+move 同时成立，掉一个就退回单动作规则 → 计划从"建目录+搬"退化成"不搬"）。
  { name: 'mkdir', words: /(创建|新建|建立|建(?!议|立))[^，。；]{0,6}?(文件夹|目录|folder)|(新(?:的)?|另一个|一个)[^，。；]{0,4}?(文件夹|目录|folder)/i },
  { name: 'move', words: /(移动|移[入进过到]|搬到|挪到|放到|放进|放在|收到|收进|归到|归入|归档|归类|整理|分拣|集中)/i },
  { name: 'convert', words: /(转换|转成|转为|转成|导出|另存为|输出为)/i },
  // 2026-10-08：补「改成 X 后缀」形态——原表只认「改后缀」紧邻，而用户常写「改成 md 后缀」，
  // 于是这类请求既不进 rename 家族、也没有算子可做，最终**静默退化成"只搬不改"**（见 CI-07）。
  { name: 'rename', words: /(重命名|改名|更名|改后缀|改扩展名|改成\s*\.?[A-Za-z0-9]{1,5}\s*(?:后缀|扩展名))/i },
  { name: 'archive', words: /(解压|压缩|打包|拆包)/i },
  { name: 'delete', words: /(删除|清理掉|移除|清扫)/i },
  { name: 'copy', words: /(复制|拷贝|备份)/i },
  { name: 'extract', words: /(提取|抽取|摘出)/i }
]

/** 顺序/并列连接词：出现它往往意味着"不止一个动作" */
const SEQUENCE_MARKERS = /(然后|再(?:把|将|去|接)|接着|之后|并(?:且)?(?:把|将)|同时|顺便|以及|另(?:外)?把)/

/** 命中的动作家族名（去重） */
export function actionFamilies(input: string): string[] {
  const s = input || ''
  return ACTION_FAMILIES.filter(f => f.words.test(s)).map(f => f.name)
}

/**
 * 是否表现为"组合意图"。
 * 判据（任一成立，且必须至少有一个动作家族）：① ≥2 个动作家族；② 顺序连接词 + ≥1 个动作家族。
 * 纯问答/单动作请求不会命中（无动作家族 ⇒ false）。
 */
export function looksComposite(input: string): boolean {
  const fams = actionFamilies(input)
  if (fams.length === 0) return false
  if (fams.length >= 2) return true
  return SEQUENCE_MARKERS.test(input || '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 表结构（与 compositeCombos.json 对齐）
// ─────────────────────────────────────────────────────────────────────────────

export interface ComboWhen {
  familiesAllOf?: string[]
  familiesNoneOf?: string[]
  categoriesAnyOf?: string[]
  typeWordsAnyOf?: string[]
  patternsAllOf?: string[]
  forbidPatterns?: string[]
  requireSequenceMarker?: boolean
}

export interface ComboPlanStep {
  tool: string
  description?: string
  params?: Record<string, string>
}

export interface ComboEntry {
  id: string
  name: string
  enabled?: boolean
  intent?: string
  when?: ComboWhen
  plan: ComboPlanStep[]
}

export interface ComboMissingEntry {
  id: string
  reason: string
  alternative?: string
  when?: ComboWhen
}

export interface ComboTable {
  typeWords: Record<string, { words: string[]; exts: string[] }>
  ambiguousTypeWords: string[]
  combos: ComboEntry[]
  $missing?: ComboMissingEntry[]
}

const TABLE = combosTable as unknown as ComboTable

/** 组合计划（与 l0SkillRouter 的 L0DirectPlan 结构兼容） */
export interface CompositePlan {
  intent: string
  steps: { step: number; description: string; tool: string; params: Record<string, string>; expectedOutput: string }[]
  isExploration: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 过滤器：归类哪些文件
// ─────────────────────────────────────────────────────────────────────────────

/** 显式扩展名（.docx / docx / 10.md 都认；前导字符不得是字母数字，避免 'cmd' 里的 'md'） */
const EXT_TOKEN = /(?:^|[^A-Za-z0-9])\.?(docx?|pdf|xlsx?|pptx?|txt|md|csv|png|jpe?g|gif|bmp|webp|tiff?|zip|rar|7z|mp[34]|wav|mov|avi|mkv)\b/i
const EXT_ALIAS: Record<string, string> = { jpeg: 'jpg', doc: 'docx', xls: 'xlsx', ppt: 'pptx', tif: 'tiff' }

export interface CollectFilter {
  /** 允许搬动的扩展名集合；空数组 = 不过滤（用户字面要求"全部文件"） */
  exts: string[]
  /** 人话标签：显式扩展名 → 'docx'；类型词 → '图片'；无 → '' */
  label: string
  /** 类型词类别（images / media / archives / tables / slides），显式扩展名按表反查，无则 null */
  category: string | null
  /** 命中的类型词原文（无则 null） */
  word: string | null
  /** 认得出是"类型词"却映射不出扩展名集（如"文档"）⇒ 调用方必须 fail-closed */
  unmapped: boolean
}

function categoryOfExt(ext: string): string | null {
  for (const [cat, def] of Object.entries(TABLE.typeWords || {})) {
    if (def.exts.includes(ext)) return cat
  }
  return null
}

/**
 * 解析"要归类哪些文件"。
 * 优先级：① 显式扩展名 → 单扩展名；② 类型词（图片/音视频/压缩包/表格/幻灯片）→ 扩展名集；
 *        ③ 认得出是类型词但无映射（文档/资料…）→ unmapped（**不得**回落成"全部文件"）；
 *        ④ 都没有 → 空过滤器（用户说的是"文件"，字面即全部）。
 */
export function resolveCollectFilter(input: string): CollectFilter {
  const s = String(input || '')
  const m = s.match(EXT_TOKEN)
  if (m) {
    const raw = m[1].toLowerCase()
    const ext = EXT_ALIAS[raw] || raw
    return { exts: [ext], label: ext, category: categoryOfExt(ext), word: null, unmapped: false }
  }
  for (const [category, def] of Object.entries(TABLE.typeWords || {})) {
    const word = def.words.find(w => s.includes(w))
    if (word) return { exts: [...def.exts], label: word, category, word, unmapped: false }
  }
  for (const word of TABLE.ambiguousTypeWords || []) {
    if (s.includes(word)) return { exts: [], label: word, category: null, word, unmapped: true }
  }
  return { exts: [], label: '', category: null, word: null, unmapped: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎
// ─────────────────────────────────────────────────────────────────────────────

export interface CompositeContext {
  /** 源目录（绝对路径或 %USERPROFILE% 模板）*/
  dir: string
  /** 目标目录全路径 */
  target: string
  /** 目标目录名（用于 intent 文案）*/
  folderName: string
  filter: CollectFilter
}

/** 通用动作家族：它们是"组合"的粘合词而非内容动作，故不参与特异性打分 */
const GENERIC_FAMILIES = ['mkdir', 'move']

function safeTest(pattern: string, s: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(s)
  } catch {
    return false
  }
}

function whenMatches(when: ComboWhen | undefined, s: string, families: string[], filter: CollectFilter): boolean {
  if (!when) return true
  if (when.familiesAllOf?.some(f => !families.includes(f))) return false
  if (when.familiesNoneOf?.some(f => families.includes(f))) return false
  if (when.categoriesAnyOf?.length && !(filter.category && when.categoriesAnyOf.includes(filter.category))) return false
  if (when.typeWordsAnyOf?.length && !(filter.word && when.typeWordsAnyOf.includes(filter.word))) return false
  if (when.patternsAllOf?.length && !when.patternsAllOf.every(p => safeTest(p, s))) return false
  if (when.forbidPatterns?.length && when.forbidPatterns.some(p => safeTest(p, s))) return false
  if (when.requireSequenceMarker && !SEQUENCE_MARKERS.test(s)) return false
  return true
}

/**
 * 特异性打分：命中**内容动作**（convert/rename/archive… 而非 mkdir/move）的 combo 优先，
 * 其次命中家族更多者优先。
 * 为什么必须打分：「把桌面上所有的 md 转成 pdf，然后放进新建文件夹」同时满足 mkdir-collect 与
 * convert-collect，按表序取第一条会得到"只搬不转"——那正是 CI-03 登记的失败形态。
 */
function comboScore(combo: ComboEntry): number {
  const fams = combo.when?.familiesAllOf || []
  const specific = fams.filter(f => !GENERIC_FAMILIES.includes(f)).length
  return specific * 100 + fams.length
}

function render(template: string, ctx: CompositeContext): string {
  const extLabel = ctx.filter.label ? ` ${ctx.filter.label} ` : ''
  return template
    .replace(/\{dir\}/g, ctx.dir)
    .replace(/\{target\}/g, ctx.target)
    .replace(/\{folderName\}/g, ctx.folderName)
    .replace(/\{extLabel\}/g, extLabel)
    .replace(/\{ext\}/g, ctx.filter.exts.join(','))
}

/** 如实说明缺哪一步能力 + 给替代做法（不假装完成、不编造产物）*/
function gapPlan(input: string, reason: string, alternative: string): CompositePlan {
  return {
    intent: `组合意图缺口：${input.substring(0, 40)}`,
    steps: [{
      step: 1,
      description: '如实说明缺哪一步能力，并给出可操作的替代做法',
      tool: 'llm_generate',
      params: {
        prompt: `用户请求：${input}\n\n系统现状（组合能力缺口）：${reason}\n\n请用中文简短直接地告诉用户：这件事的哪一步现在做不到 + 他可以怎么做。不要假装已经完成，不要编造已生成 / 已解压 / 已改名的文件。可用的替代做法：${alternative}`
      },
      expectedOutput: '缺口说明与替代做法'
    }],
    isExploration: false
  }
}

/**
 * 组合计划引擎：读表产计划。
 * 顺序（顺序本身就是契约）：
 *   ① `$missing`（用户要求的动作我们没有算子）→ 诚实说明，**绝不**产出"少做一半"的计划；
 *   ② 过滤器 unmapped（说了类型词却映射不出扩展名集）→ 诚实澄清，**绝不**放行无界批量移动；
 *   ③ `combos` 按特异性打分取最优 → 渲染占位符成计划；
 *   ④ 都不命中 → null（下沉给下游层，不猜）。
 * @param table 供测试注入合成表（证明"加一条组合 = 加一条数据，不改代码"）
 */
export function matchCompositePlan(
  input: string,
  ctx: CompositeContext,
  table: ComboTable = TABLE
): CompositePlan | null {
  const s = String(input || '')
  const families = actionFamilies(s)
  if (families.length === 0) return null

  // ① 缺能力优先
  const missing = (table.$missing || []).find(m => whenMatches(m.when, s, families, ctx.filter))
  if (missing) return gapPlan(s, missing.reason, missing.alternative || '请把请求拆成单个能做的动作，我逐步做。')

  // ② 过滤器映射不出 ⇒ fail-closed（空过滤器 = 移动目录下全部文件）
  if (ctx.filter.unmapped) {
    return gapPlan(
      s,
      `用户说了文件类型「${ctx.filter.label}」，但这个说法覆盖多种格式（扩展名），而批量移动必须先确定"移动哪些"——按"全部文件"执行会把目录里其它文件也搬走，风险由用户承担。`,
      `明确到一类：「把桌面上的 docx 都放进一个新建的文件夹」或「把桌面上的图片都放进一个新建的文件夹」（图片/音视频/压缩包/表格/幻灯片这几类我都认）。`
    )
  }

  // ③ 组合取最优
  let best: ComboEntry | null = null
  let bestScore = -1
  for (const combo of table.combos || []) {
    if (combo.enabled === false) continue
    if (!whenMatches(combo.when, s, families, ctx.filter)) continue
    const score = comboScore(combo)
    if (score > bestScore) {
      best = combo
      bestScore = score
    }
  }
  if (!best) return null

  const fallbackIntent = `组合意图：${best.name}（${ctx.folderName}）`
  return {
    intent: render(best.intent || fallbackIntent, ctx),
    steps: best.plan.map((step, i) => ({
      step: i + 1,
      description: render(step.description || `${best!.name} 第 ${i + 1} 步`, ctx),
      tool: step.tool,
      params: Object.fromEntries(
        Object.entries(step.params || {}).map(([k, v]) => [k, render(String(v), ctx)])
      ),
      expectedOutput: `${best!.name} 第 ${i + 1} 步结果`
    })),
    isExploration: false
  }
}
