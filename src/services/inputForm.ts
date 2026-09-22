// P0-A（A3 修复批）：输入形态检测与模板输入门控。
//
// 背景（验收考试 G-16 坐实）：模板 schema 已有 routing.inputType（'file'|'text'|'file_or_text'）
// 与 paramMapping.slots[].source/required，但路由全链路零消费——"帮我把这段会议记录整理成
// 会议纪要"（无文件、纯内联文本）命中 inputType 'file_or_text' 的会议纪要模板后，计划仍带
// read_file {{user_file}} 步骤，运行时文件不存在静默失败。
//
// 本模块提供四个纯函数，供 kernels/default（finalizeRaapPlan/disambiguate/l05）、
// toolRetrieval.llmFallback、dialogStore legacy 路径统一接入：
// - detectInputForm：检测输入中的文件路径 / 附件折叠 / 内联材料
// - classifyTemplateInput：按 manifest.inputType 与输入形态给出 original/inline/reject
// - adaptPlanToInlineInput：剥离前导读取步骤并把内联材料注入 {{step_N_result}}
// - gateTemplateForInput：单一门控入口（含 {{user_file}} 路径绑定）
import type { L2ToolManifest, L2DagStep } from '@/models'

export interface InputFormInfo {
  /** DialogPanel 附件折叠格式（"以下是用户提供的附件内容：" / "=== 文件: xxx ==="） */
  hasAttachment: boolean
  /** 输入正文中含盘符路径或 ~/ 路径 */
  hasFilePath: boolean
  filePaths: string[]
  hasFileInput: boolean
  /** 提取出的内联材料（附件全文 / 冒号后正文 / 空行后正文） */
  inlineMaterial: string
  hasInlineMaterial: boolean
}

export type TemplateInputClass = 'original' | 'inline' | 'reject'

export interface TemplateGateResult {
  action: TemplateInputClass
  /** original+检测到路径 或 inline 时提供适配后的执行步骤；未提供则用 manifest 原步骤 */
  steps?: L2DagStep[]
  material?: string
  filePath?: string
  info: InputFormInfo
}

export const INLINE_MIN_CHARS = 20

const ATTACHMENT_MARKER = '以下是用户提供的附件内容：'
const ATTACHMENT_FILE_RE = /===\s*文件:/
// 盘符路径（C:\foo\bar.txt / C:/foo/bar.txt）或 ~/ 相对路径；空格路径不支持（考试素材路径无空格）
const PATH_RE = /[A-Za-z]:[\\/][^\s，。；、！？'"”’（）()【】]*|~\/[^\s，。；、！？'"”’（）()【】]*/g

/** 拆出指令部分与附件部分（无附件标记时 attachment 为空；同时剥掉标记前的 "---" 分隔线） */
export function splitAttachment(input: string): { instruction: string; attachment: string } {
  const idx = input.indexOf(ATTACHMENT_MARKER)
  if (idx < 0) return { instruction: input, attachment: '' }
  return {
    instruction: input.substring(0, idx).replace(/\s*---\s*$/, '').trim(),
    attachment: input.substring(idx + ATTACHMENT_MARKER.length).trim()
  }
}

/**
 * 提取「指令段」：供关键词匹配使用，剥掉附着材料，防止长文档正文/邮件正文里的通用词
 * 淹没用户指令（B 方案，验收考试复考 Q4/Q9 误路由的根因）。
 * - 含附件折叠标记 → 标记之前的指令部分（复用 splitAttachment）
 * - 含空行（\n\n / \r\n\r\n）→ 空行之前的指令部分
 * - 否则 → 返回整段输入（单段指令行为不变，向后兼容）
 */
export function extractInstructionSegment(input: string): string {
  const { instruction, attachment } = splitAttachment(input)
  if (attachment) return instruction
  const blankMatch = instruction.match(/\r?\n[ \t]*\r?\n/)
  if (blankMatch && blankMatch.index !== undefined) {
    const head = instruction.substring(0, blankMatch.index).trim()
    if (head) return head
  }
  return instruction
}

/** 从指令部分提取文件路径（附件正文里的路径不算用户引用） */
export function extractFilePaths(input: string): string[] {
  const { instruction } = splitAttachment(input)
  const matches = instruction.match(PATH_RE) || []
  return matches.map(s => s.trim()).filter(s => s.length > 3)
}

/** 提取内联材料：附件全文优先；否则取冒号后正文 / 空行后正文中较长者 */
export function extractInlineMaterial(input: string): string {
  const { instruction, attachment } = splitAttachment(input)
  if (attachment) return attachment
  const candidates: string[] = []
  for (const sep of ['：', ':']) {
    const idx = instruction.indexOf(sep)
    if (idx >= 0) {
      const after = instruction.substring(idx + sep.length).trim()
      if (after) candidates.push(after)
    }
  }
  const blankIdx = instruction.indexOf('\n\n')
  if (blankIdx >= 0) {
    const after = instruction.substring(blankIdx + 2).trim()
    if (after) candidates.push(after)
  }
  if (candidates.length === 0) return ''
  return candidates.reduce((best, c) => (c.length > best.length ? c : best))
}

export function detectInputForm(input: string): InputFormInfo {
  const hasAttachment = input.includes(ATTACHMENT_MARKER) || ATTACHMENT_FILE_RE.test(input)
  const filePaths = extractFilePaths(input)
  const inlineMaterial = extractInlineMaterial(input)
  return {
    hasAttachment,
    hasFilePath: filePaths.length > 0,
    filePaths,
    hasFileInput: hasAttachment || filePaths.length > 0,
    inlineMaterial,
    hasInlineMaterial: inlineMaterial.length >= INLINE_MIN_CHARS
  }
}

/**
 * 按模板 inputType 与输入形态分类：
 * - text → 恒 original（文本模板直接消费输入）
 * - file/file_or_text + 真实路径 → original（工具可自行读取，gate 会做路径绑定）
 * - file/file_or_text + 附件（无路径） → inline（附件内容已折叠进输入，剥离读取步骤）
 * - file + 无任何文件输入 → reject（模板确实需要文件；防 Q10/Q18 式误路由）
 * - file_or_text + 无文件但有内联材料 → inline（会议纪要核心修复场景）
 * - file_or_text + 两者皆无 → original（保守：保持旧行为，运行期失败由 A4 兜底接住）
 */
export function classifyTemplateInput(m: L2ToolManifest, info: InputFormInfo): TemplateInputClass {
  const t = m.routing.inputType
  if (t === 'text') return 'original'
  if (info.hasFilePath) return 'original'
  if (info.hasAttachment) return 'inline'
  if (t === 'file') return 'reject'
  if (info.hasInlineMaterial) return 'inline'
  return 'original'
}

/**
 * 内联适配：剥离 read_file/list_directory 步骤（其依赖只指向已剥离步骤或为空），
 * 重编号、remap depends_on，并把被剥离步骤的 {{step_N_result}} 引用替换为内联材料。
 * 无可剥离步骤时原样返回（同一引用），由调用方降级为 original。
 */
export function adaptPlanToInlineInput(steps: L2DagStep[], material: string): L2DagStep[] {
  const stripped = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    for (const s of steps) {
      if (stripped.has(s.step)) continue
      if ((s.tool === 'read_file' || s.tool === 'list_directory') &&
        s.depends_on.every(d => stripped.has(d))) {
        stripped.add(s.step)
        changed = true
      }
    }
  }
  if (stripped.size === 0) return steps

  const remaining = steps.filter(s => !stripped.has(s.step))
  if (remaining.length === 0) return steps
  const remap = new Map<number, number>()
  remaining.forEach((s, i) => remap.set(s.step, i + 1))

  return remaining.map(s => {
    const newParams: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.params)) {
      if (typeof v === 'string') {
        let val = v
        // 先替换被剥离步骤的引用为材料（必须先于 remap，避免新旧编号撞车）
        for (const oldStep of stripped) {
          val = val.split(`{{step_${oldStep}_result}}`).join(material)
        }
        // 再把剩余步骤的引用重编号（knowledge_search 2→1 后，其 {{step_2_result}} 须变 {{step_1_result}}）
        for (const [oldStep, newStep] of remap) {
          if (oldStep !== newStep) {
            val = val.split(`{{step_${oldStep}_result}}`).join(`{{step_${newStep}_result}}`)
          }
        }
        newParams[k] = val
      } else {
        newParams[k] = v
      }
    }
    return {
      ...s,
      step: remap.get(s.step)!,
      depends_on: s.depends_on
        .filter(d => !stripped.has(d))
        .map(d => remap.get(d)!)
        .filter(d => d !== undefined),
      params: newParams
    }
  })
}

/** 把检测到的文件路径绑入 {{user_file}} 槽位占位符（无变化时返回原引用） */
export function bindFilePathToSteps(steps: L2DagStep[], filePath: string): L2DagStep[] {
  let changed = false
  const bound = steps.map(s => {
    const newParams: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.params)) {
      if (typeof v === 'string' && v.includes('{{user_file}}')) {
        newParams[k] = v.split('{{user_file}}').join(filePath)
        changed = true
      } else {
        newParams[k] = v
      }
    }
    return changed ? { ...s, params: newParams } : s
  })
  return changed ? bound : steps
}

/**
 * 模板输入门控单一入口（四个接入点统一调用）：
 * - reject → 调用方按未命中处理（planTask 兜底 / 下探下一层）
 * - inline → steps 为剥离读取步骤后的适配步骤
 * - original + 检测到路径 → steps 为 {{user_file}} 已绑定的步骤（无占位符则不提供）
 */
export function gateTemplateForInput(m: L2ToolManifest, input: string): TemplateGateResult {
  const info = detectInputForm(input)
  const cls = classifyTemplateInput(m, info)
  if (cls === 'reject') return { action: 'reject', info }

  const dag = m.execution.dagPlan?.steps
  if (cls === 'inline') {
    if (dag && dag.length > 0) {
      const adapted = adaptPlanToInlineInput(dag, info.inlineMaterial)
      if (adapted !== dag) {
        return { action: 'inline', steps: adapted, material: info.inlineMaterial, info }
      }
      // 无读取步骤可剥离：材料经 {{input}} 模板变量自然进入 prompt，按原计划执行
      return { action: 'original', info }
    }
    // direct 模式：promptTemplate {{input}} 由执行层从 inputText 填充
    return { action: 'original', info }
  }

  // original：有真实路径时绑定 {{user_file}}（绿色通道无槽位填充环节的补漏）
  if (info.hasFilePath && dag && dag.length > 0) {
    const bound = bindFilePathToSteps(dag, info.filePaths[0])
    if (bound !== dag) {
      return { action: 'original', steps: bound, filePath: info.filePaths[0], info }
    }
  }
  return { action: 'original', info }
}
