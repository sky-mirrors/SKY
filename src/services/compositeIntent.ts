/**
 * 组合意图识别（2026-10-07）
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
 * 本模块提供判据——请求是否表现为**多个动作家族**的组合。
 */

/** 动作家族：同一家族内的近义词只算一次（避免"新建/创建/建"被数成三个动作） */
const ACTION_FAMILIES: Array<{ name: string; words: RegExp }> = [
  { name: 'mkdir', words: /(创建|新建|建立|建(?!议|立))[^，。；]{0,6}?(文件夹|目录|folder)/i },
  { name: 'move', words: /(移动|移[入进过到]|搬到|挪到|放到|放进|放在|收到|收进|归到|归入|归档|归类|整理|分拣|集中)/i },
  { name: 'convert', words: /(转换|转成|转为|转成|导出|另存为|输出为)/i },
  { name: 'rename', words: /(重命名|改名|更名|改后缀|改扩展名)/i },
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
