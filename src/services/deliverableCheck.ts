/**
 * P1-D 假完成核验（产物三关：存在性/非空/相关性）
 *
 * 复考 Q14/Q18 病理链：「文件创建器」宏写死 Desktop\新建文档.docx → 工具层仅验
 * 存在性甚至不验 → LLM 摘要忠实转述"文件已保存"→ 用户看到假完成。
 *
 * 本服务在宏/计划执行收口处对"用户明确要求了命名产物"的请求做三态核验：
 *  - no-artifact：要求的文件根本没产生
 *  - mismatch   ：文件产生了但为空文件（0 字节，内容未写入）
 *  - ok          ：文件存在且非空，直通零打扰
 * 无命名产物的请求（纯问答/摘要类）extractRequestedArtifact 返回 null → skip。
 *
 * 设计约束：fail-open——核验链路任何异常都不得阻断主流程、不得产生误报指控。
 */

import { globalBus } from '@/kernel/bus'
import { evictFingerprint } from './scheduleOptimizer'

export interface RequestedArtifact {
  /** 明确要求的文件名（含扩展名），如 采购合同.pdf */
  fileName: string | null
  /** 目标扩展名（小写，无点） */
  ext: string | null
  /** 目标目录；'~DESKTOP' 哨兵表示桌面（探测脚本内展开真实用户目录）；null=未知 */
  dir: string | null
  /** 完全可解析的绝对目标路径（dir 非 ~DESKTOP 且 fileName 已知时） */
  path: string | null
  /** 请求中提到的源文件路径（用于"同一个文件夹"推断） */
  sourcePath: string | null
}

export type ConformanceStatus = 'ok' | 'no-artifact' | 'mismatch' | 'skip'

export interface ConformanceResult {
  status: ConformanceStatus
  detail: string
}

interface StatHit {
  path: string
  size: number
}

const FORMAT_TO_EXT: Record<string, string> = {
  pdf: 'pdf', word: 'docx', doc: 'docx', docx: 'docx', excel: 'xlsx', xls: 'xlsx', xlsx: 'xlsx',
  txt: 'txt', text: 'txt', md: 'md', markdown: 'md', html: 'html', htm: 'html', csv: 'csv',
  png: 'png', jpg: 'jpg', jpeg: 'jpg', json: 'json', xml: 'xml', ppt: 'pptx', pptx: 'pptx', rtf: 'rtf'
}

const DOC_EXT_RE = /\.(docx?|xlsx?|pptx?|pdf|txt|md|markdown|csv|html?|json|xml|rtf|png|jpe?g|gif|bmp)$/i

/** Windows 绝对路径（正/反斜杠），排除常见中文标点与引号 */
const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s，。,；;:："“”'\[\]（）()【】]+/g

function baseName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx >= 0 ? norm.substring(idx + 1) : norm
}

function dirName(p: string): string {
  // 保留原始分隔符（Windows 探测两者皆可，但测试断言与展示需要原样）
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx > 0 ? p.substring(0, idx) : ''
}

function joinPath(dir: string, fileName: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  return `${d}\\${fileName}`
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.。,，;；!！?？'"“”\]）)】]+$/, '')
}

/**
 * 从用户输入解析"明确要求了命名产物"的目标。
 * 返回 null = 未要求命名产物（纯问答/开放式整理类），核验跳过。
 */
export function extractRequestedArtifact(input: string): RequestedArtifact | null {
  const text = input.trim()
  if (!text || text.length > 2000) return null

  const absPaths: string[] = []
  for (const m of text.match(ABS_PATH_RE) ?? []) {
    absPaths.push(stripTrailingPunct(m))
  }

  // 目标目录：显式目录路径
  const dirAfter = text.match(/(?:保存到|输出到|放到|存储到|存到|目录(?:为|是)?|文件夹(?:为|是)?)\s*([A-Za-z]:[\\/][^\s，。,；;：:"“”']+)/)
  const explicitDir = dirAfter ? stripTrailingPunct(dirAfter[1]).replace(/[\\/]+$/, '') : null

  // "同一个文件夹/同一目录" → 源文件所在目录
  const sameDir = /(?:保存|输出|放|存储|存|写入)到?(?:同一个|同)\s*(?:文件夹|目录)/.test(text)

  // 桌面提及（且存在写动作动词，避免"看一下桌面上的文件"误触发）
  const desktopMention = /桌面|Desktop/i.test(text) && /新建|创建|保存|生成|写入|输出|导出|建立/.test(text)

  // 显式命名："文件名叫 X.pdf" / "命名为 X" / "名字叫 X"
  const nameAfter = text.match(/(?:文件名(?:字)?(?:叫|为|是)?|名(?:字)?(?:叫|为|是)|命名为)\s*([^\s，。,；;：:"“”'\]）)【】]+?\.[A-Za-z0-9]{1,5})/)

  // 创建动词直接携带文件名："新建一个测试.txt" / "创建 test.md 文件"
  const createAfter = text.match(/(?:新建|创建|生成|建立)\s*(?:一个|一份)?\s*(?:名为)?\s*([^\s，。,；;：:"“”'\]）)【】]+?\.[A-Za-z0-9]{1,5})/)

  // 格式转换动词："转成 PDF" / "另存为 docx"
  const convertFmt = text.match(/(?:转成|转为|转换成|转换为|导出为|另存为|输出为|保存为|输出成)\s*(pdf|word|docx?|excel|xlsx?|txt|text|md|markdown|html?|csv|png|jpe?g|json|xml|pptx?|rtf)\b/i)

  let fileName: string | null = null
  if (nameAfter) {
    fileName = stripTrailingPunct(nameAfter[1])
  } else if (createAfter && !/[A-Za-z]:[\\/]/.test(createAfter[1])) {
    // 排除"创建文件 C:\path\x.txt"这类显式路径场景（路径已由 absPaths 捕获）
    fileName = stripTrailingPunct(createAfter[1])
  } else if (convertFmt) {
    const newExt = FORMAT_TO_EXT[convertFmt[1].toLowerCase()]
    const src = absPaths.find(p => DOC_EXT_RE.test(p))
    if (src && newExt) {
      const srcBase = baseName(src)
      const stem = srcBase.replace(DOC_EXT_RE, '')
      fileName = `${stem}.${newExt}`
    }
  }

  // 源文件：请求中出现的第一个带文档扩展名的绝对路径（目标名通常不带完整路径）
  const sourcePath = absPaths.find(p => DOC_EXT_RE.test(p)) ?? null

  let dir: string | null = null
  if (explicitDir) {
    dir = explicitDir
  } else if (sameDir && sourcePath) {
    const d = dirName(sourcePath)
    dir = d || null
  } else if (desktopMention) {
    dir = '~DESKTOP'
  }

  // 目标路径若以绝对路径形式直书（"保存到 C:\a\b\X.pdf"），absPaths 里可能同时含源与目标
  if (!fileName && !sourcePath && absPaths.length > 0) {
    fileName = baseName(absPaths[absPaths.length - 1])
    if (!DOC_EXT_RE.test(fileName)) fileName = null
  }

  if (!fileName) return null
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ?? '').toLowerCase() || null

  let path: string | null = null
  if (dir && dir !== '~DESKTOP') {
    path = joinPath(dir, fileName)
  } else if (!dir && absPaths.length > 1) {
    // 多个绝对路径且无显式目录：末尾路径若与 fileName 同名则视为目标路径
    const last = absPaths[absPaths.length - 1]
    if (baseName(last).toLowerCase() === fileName.toLowerCase()) path = last
  }

  return { fileName, ext, dir, path, sourcePath }
}

/**
 * 探测候选路径，返回第一个存在的命中（优先非空；全为 0 字节则返回首个 0 字节命中）。
 * '~DESKTOP' 前缀由探测脚本内展开为真实桌面目录。
 * 三态返回：
 *  - undefined = 探测不可用（无 electronAPI / 空列表 / 探测异常）→ 调用方 fail-open
 *  - null       = 探测已运行但全部不存在
 *  - StatHit    = 首个命中
 */
export async function statCandidates(paths: string[]): Promise<StatHit | null | undefined> {
  if (paths.length === 0) return undefined
  const api = (window as unknown as {
    electronAPI?: { shellExec?: (args: { command: string; timeout?: number }) => Promise<{ stdout?: string }> }
  }).electronAPI
  if (!api?.shellExec) return undefined
  const script = "const fs=require('fs'),p=require('path');const home=process.env.USERPROFILE||process.env.HOME;const paths=process.argv.slice(1).map(x=>x.startsWith('~DESKTOP')?p.join(home,'Desktop',x.substring('~DESKTOP'.length+1)):x);const hits=[];for(const fp of paths){try{const st=fs.statSync(fp);hits.push({fp,sz:st.size})}catch{}}for(const h of hits){if(h.sz>0){console.log('STATHIT:'+h.sz+':'+h.fp)}}if(hits.length>0){console.log('STATHIT:'+hits[0].sz+':'+hits[0].fp)}console.log('STATDONE')"
  const args = paths.map(q => `"${q}"`).join(' ')
  try {
    const result = await api.shellExec({ command: `node -e "${script}" ${args}`, timeout: 6000 })
    const out = String(result.stdout || '')
    const lines = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('STATHIT:'))
    for (const l of lines) {
      const m = l.match(/^STATHIT:(\d+):(.+)$/)
      if (m && Number(m[1]) > 0) return { path: m[2], size: Number(m[1]) }
    }
    if (lines.length > 0) {
      const m = lines[0].match(/^STATHIT:(\d+):(.+)$/)
      if (m) return { path: m[2], size: Number(m[1]) }
    }
    return null
  } catch {
    return undefined
  }
}

/**
 * 产物符合性核验（三态 + skip）。
 * @param userInput 用户原始输入
 * @param producedArtifacts 本次执行实际产生的文件路径（副作用记录）
 */
export async function conformanceCheck(
  userInput: string,
  producedArtifacts: string[]
): Promise<ConformanceResult> {
  let requested: RequestedArtifact | null = null
  try {
    requested = extractRequestedArtifact(userInput)
  } catch {
    return { status: 'skip', detail: '' }
  }
  if (!requested || !requested.fileName) return { status: 'skip', detail: '' }

  const candidates: string[] = []
  if (requested.path) candidates.push(requested.path)
  if (requested.dir === '~DESKTOP') candidates.push(`~DESKTOP\\${requested.fileName}`)
  for (const art of producedArtifacts) {
    if (baseName(art).toLowerCase() === requested.fileName.toLowerCase()) candidates.push(art)
  }
  // 去重
  const unique = Array.from(new Set(candidates))

  // 无法定位任何候选路径：靠副作用记录做名称级判断
  if (unique.length === 0) {
    if (producedArtifacts.length === 0) {
      return {
        status: 'no-artifact',
        detail: `用户要求生成「${requested.fileName}」，但本次执行未产生任何文件产物。`
      }
    }
    const names = producedArtifacts.map(a => baseName(a)).join('、')
    return {
      status: 'no-artifact',
      detail: `用户要求生成「${requested.fileName}」，但实际产生的文件为：${names}，均与要求不符。`
    }
  }

  const hit = await statCandidates(unique)
  if (hit === undefined) {
    // 探测不可用 → fail-open，不指控
    return { status: 'skip', detail: '' }
  }
  if (hit === null) {
    const expected = requested.path ?? (requested.dir === '~DESKTOP' ? `桌面\\${requested.fileName}` : requested.fileName)
    const actualNote = producedArtifacts.length > 0
      ? `本次实际产生的文件为：${producedArtifacts.map(a => baseName(a)).join('、')}。`
      : '本次执行未产生任何文件产物。'
    return {
      status: 'no-artifact',
      detail: `用户要求生成「${requested.fileName}」（期望位置：${expected}），但执行后未找到该文件。${actualNote}`
    }
  }
  if (hit.size > 0) return { status: 'ok', detail: '' }
  return {
    status: 'mismatch',
    detail: `目标文件「${hit.path}」已生成但为空文件（0 字节），实际内容未写入。`
  }
}

/**
 * 收口闸门：核验失败时 (1) 发系统通知 (2) 前置核验事实到 lastResult
 * (3) 清除该执行指纹，防止假成功结果被下次重放（复考 Q14 totalTokens=0 病理）。
 * 一切异常均 fail-open 返回原 lastResult。
 */
export async function applyDeliverableGate(
  userInput: string,
  producedArtifacts: string[],
  lastResult: string,
  manifestId: string,
  inputFingerprint: string
): Promise<string> {
  try {
    const check = await conformanceCheck(userInput, producedArtifacts)
    if (check.status === 'skip' || check.status === 'ok') return lastResult

    const note = `⚠️ 产物核验：${check.detail}本次执行未达成用户要求的产物，请如实向用户说明，不得宣称任务已完成。`
    try {
      globalBus.emit('dialog:add-notice', { message: note })
    } catch { /* notice 链路不可用不阻断 */ }
    try {
      globalBus.emit('debug:log-event', { level: 'warn', tag: 'shell', message: `[产物核验] ${check.status}: ${check.detail}` })
    } catch { /* ignore */ }

    // D4：清指纹——假成功结果不得入库/残留，下次同输入必须真实重跑
    if (manifestId && inputFingerprint) {
      try { evictFingerprint(manifestId, inputFingerprint) } catch { /* ignore */ }
    }

    return `${note}\n\n${lastResult}`
  } catch {
    return lastResult
  }
}
