import type { L2ToolManifest } from '@/models'
import { getLLM } from '@/kernel/plugins/llm'
import { debugLog } from '@/services/debugLog'
import { extractInstructionSegment } from '@/services/inputForm'
import { extractListingExt, isListingIntent } from '@/services/fileListing'
import { stripSessionFilesContext } from '@/services/sessionFilesContext'

interface L0SkillRule {
  name: string
  domain: string
  triggerPatterns: RegExp[]
  forbiddenPatterns?: RegExp[]
  buildPlan: (input: string) => Promise<L0DirectPlan | null>
}

interface L0DirectPlan {
  intent: string
  steps: { step: number; description: string; tool: string; params: Record<string, string>; expectedOutput: string; depends_on?: number[] }[]
  isExploration: boolean
}

interface L05QuickMatchResult {
  manifest: L2ToolManifest
  confidence: number
  matchedKeywords: string[]
}

interface L1CapabilityCheck {
  canHandle: boolean
  nodeId: string
  nodeName: string
  confidence: number
  plan: L0DirectPlan | null
}

const FILE_EXT_MAP: Record<string, string> = {
  md: 'docx',
  txt: 'docx',
  html: 'pdf',
  csv: 'xlsx'
}

function extractFilePath(input: string): string | null {
  const m = input.match(/["']?([A-Za-z]:\\[^\s"']+\.\w{1,5})["']?/i)
  if (m) return m[1]
  const m2 = input.match(/["']?(~?\/[^\s"']+\.\w{1,5})["']?/)
  return m2 ? m2[1] : null
}

/**
 * 抽出一个**文件夹**路径（无扩展名即可，不要求存在）。
 * 2026-09-25（HANDOFF 下一步 5）：Q15 用——`extractFilePath` 要求带扩展名，抓不到目录。
 * 排除中文标点/括号，避免把「（例如 20260315-01.jpg）」这类示例吞进路径。
 */
function extractDirPath(input: string): string | null {
  const m = input.match(/([A-Za-z]:\\[^\s"'，。；、（）()【】]+)/)
  if (m) return m[1].replace(/[\\/]+$/, '')
  const m2 = input.match(/(~?\/[^\s"'，。；、（）()【】]+)/)
  return m2 ? m2[1].replace(/[\\/]+$/, '') : null
}

/**
 * 2026-09-30：为 L0「文件移动重命名」规则抽 from/to 两个路径。
 *
 * **只接受能同时确定两者的情形**——抽不全返回 null 下沉给下游，不伪造路径
 * （与规则 1「拿不到真实路径就不产出必失败的假计划」同款原则，见本文件 :222 注释）。
 * 两种形态：
 *   - 两个绝对路径：`把 <A> 移到 <B>` → { from: A, to: B }
 *   - 同目录改名：`<A> 重命名为 b.txt`（to 无目录段）→ { from: A, to: <A 的目录>\b.txt }
 */
function extractMovePaths(input: string): { from: string; to: string } | null {
  const abs: string[] = []
  for (const m of input.matchAll(/([A-Za-z]:\\[^\s"'，。；、！？（）()【】]+)/g)) {
    abs.push(m[1].replace(/[\\/]+$/, ''))
  }

  if (abs.length >= 2) {
    const [from, to] = abs
    if (!from || !to || from === to) return null
    return { from, to }
  }

  if (abs.length === 1) {
    const from = abs[0]
    const dir = from.replace(/[\\/][^\\/]*$/, '')   // 去掉文件名，取所在目录
    if (!dir || dir === from) return null
    const m = input.match(/(?:重命名为|改名为|更名为|重命名成|改名成)\s*["'「『]?([^"'」』\s\\/:*?<>|]{1,60})/i)
    if (m) {
      const name = m[1].trim()
      if (name && !name.includes('\\') && !name.includes('/')) {
        return { from, to: `${dir}\\${name}` }
      }
    }
  }

  return null
}

/**
 * 第二波·图像能力：从自然语言里抽出**可确定执行**的图像操作。
 * 抽不到任何一项就返回空对象——由调用方决定是"直调"还是交给下游层（不猜用户意图）。
 */
export function extractImageOp(input: string): {
  resize?: { width?: number; height?: number; percent?: number }
  format?: string
  quality?: number
  grayscale?: boolean
} {
  const op: ReturnType<typeof extractImageOp> = {}
  const resize: { width?: number; height?: number; percent?: number } = {}
  const w = input.match(/(?:宽(?:度)?|width)\s*(?:到|为|至|设为|改成)?\s*(\d{2,5})/i) ||
    input.match(/(\d{2,5})\s*(?:px|像素)?\s*宽/i)
  if (w) resize.width = Number(w[1])
  const h = input.match(/(?:高(?:度)?|height)\s*(?:到|为|至|设为|改成)?\s*(\d{2,5})/i)
  if (h) resize.height = Number(h[1])
  const pct = input.match(/(?:缩小|放大|缩放|缩)\s*(?:到|为)?\s*(\d{1,3})\s*%/)
  if (pct) resize.percent = Number(pct[1])
  else if (/一半|二分之一/.test(input)) resize.percent = 50
  if (Object.keys(resize).length > 0) op.resize = resize

  const fmt = input.match(/(?:转(?:成|为|换为)?|导出(?:成|为)?|保存(?:成|为)?)\s*(jpe?g|png|webp|avif|tiff)\b/i)
  if (fmt) {
    const f = fmt[1].toLowerCase()
    op.format = f === 'jpg' ? 'jpeg' : f
  }
  const q = input.match(/(?:质量|quality)\s*(?:为|到|设为)?\s*(\d{1,3})/i) ||
    input.match(/压缩\s*(?:到|为)?\s*(\d{1,3})\s*%/)
  if (q) op.quality = Number(q[1])
  if (/灰度|黑白|grayscale/i.test(input)) op.grayscale = true
  return op
}

/**
 * 第三波·媒体能力（2026-09-30）：从自然语言里抽出**可确定执行**的音视频操作。
 * 与 extractImageOp 同款契约：抽不到任何一项就返回空对象，由调用方决定直调还是下沉（不猜意图）。
 * 参数名对齐 buildMediaProcessArgs 的接受面（format / crf / start / duration / thumbnailAt / width）。
 */
export function extractMediaOp(input: string): {
  format?: string
  crf?: number
  start?: number
  duration?: number
  thumbnailAt?: number
  width?: number
} {
  const op: ReturnType<typeof extractMediaOp> = {}

  const fmt = input.match(/(?:转(?:成|为|换为)?|导出(?:成|为)?|保存(?:成|为)?|转换(?:成|为)?)\s*(mp4|webm|gif|mp3|wav|aac|m4a|flac|ogg)\b/i)
  if (fmt) op.format = fmt[1].toLowerCase()

  const crf = input.match(/(?:crf|质量)\s*(?:为|到|设为|改成)?\s*(\d{1,2})\b/i)
  if (crf) op.crf = Number(crf[1])

  const thumb = input.match(/(?:在|第)\s*(\d+(?:\.\d+)?)\s*秒\s*(?:处)?\s*(?:出|截|抽|生成)?\s*(?:一张)?\s*(?:缩略图|封面)/)
  if (thumb) op.thumbnailAt = Number(thumb[1])

  const start = input.match(/(?:从|自)\s*(?:第)?\s*(\d+(?:\.\d+)?)\s*秒\s*(?:开始|起)/)
  if (start) op.start = Number(start[1])

  const dur = input.match(/(?:裁剪|截取|持续|时长)\s*(?:到|为)?\s*(\d+(?:\.\d+)?)\s*秒/)
  if (dur) op.duration = Number(dur[1])

  const w = input.match(/(?:宽(?:度)?|width)\s*(?:到|为|至|设为|改成)?\s*(\d{2,5})/i)
  if (w) op.width = Number(w[1])

  return op
}

function extractTargetFormat(input: string): string | null {  const m = input.match(/(?:转|到|为|成|输出|导出|保存|转换)\s*[.】]?\s*(docx|pdf|txt|md|xlsx|html|json|csv)/i)
  return m ? m[1].toLowerCase() : null
}

function extractSourceExt(input: string): string | null {
  // 取**最后**一个点段当扩展名：文件名可能自带点号（如 "2026.9.24最新快照.md"），
  // 取第一个会解析出 "9"（实测：L0 计划因此把源路径写成 `input.9`）。无匹配返回 null。
  const all = [...String(input || '').matchAll(/\.(\w{1,5})\b/g)]
  return all.length > 0 ? all[all.length - 1][1].toLowerCase() : null
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '')
    .replace(/^[的了地得]+|[的了地得]+$/g, '')
    .substring(0, 30)
}

function stripDirectiveWords(input: string): string {
  let cleaned = input
  cleaned = cleaned.replace(/^(给我|帮我|请|能不能|可以|想要|需要|麻烦|让|叫我来|来帮我|来给我|来请|麻烦你|请帮我|请给我|能不能帮我|能不能给我)/gi, '')
  cleaned = cleaned.replace(/(创建|新建|写|生成|保存|制作|建立|做一个|写一个|生成一个|新建一个|创建一个|写份|写个|创建份|建个)/gi, '')
  cleaned = cleaned.replace(/(一个|一份|一张|一篇|一些|一下)/gi, '')
  cleaned = cleaned.replace(/(在桌面|到桌面|在电脑上|在本地|在D盘|在C盘|桌面上|电脑上)/gi, '')
  cleaned = cleaned.replace(/(文档|文件|docx|word|txt|文本|pdf|xlsx|md|\.docx|\.txt|\.pdf|\.xlsx|\.md)/gi, '')
  cleaned = cleaned.replace(/[的了地得]/g, '')
  cleaned = cleaned.trim()
  if (!cleaned || cleaned.length < 2 || /^[，。！？、,.!?\s]+$/.test(cleaned)) {
    return ''
  }
  return cleaned
}

async function refineFileNameWithLLM(rawName: string): Promise<string> {
  const llm = getLLM()
  const prompt = `判断以下文本是否适合作为文件名。如果适合，输出文件名（不含扩展名，2-20字）；如果不包含有效命名信息，只输出DEFAULT。\n只输出文件名或DEFAULT，不要解释。\n\n文本："${rawName}"`

  try {
    const resp = await llm.chatCompletion(
      [{ role: 'user', content: prompt }],
      { taskType: 'classify', callerId: 'l0SkillRouter_filename', maxTokens: 32 }
    )
    const result = (resp.content || '').trim()
    if (result && result !== 'DEFAULT' && result.length >= 2 && result.length <= 30 && !/^\s*$/.test(result)) {
      return sanitizeFileName(result.replace(/["「」『』""'']/g, '').replace(/\.\w{1,5}$/, ''))
    }
    debugLog(`[L0 FileName] LLM返回DEFAULT或无效: "${result}"，使用默认名`)
  } catch (e) {
    debugLog('[L0 FileName] LLM兜底失败:', e instanceof Error ? e.message : String(e))
  }
  return ''
}

async function extractFileName(input: string, ext: string): Promise<string> {
  const nameMatch = input.match(/(?:名为|叫|命名|名字是|叫作)\s*["「『""']?([^"」』""'\s]{1,30})/i)
  if (nameMatch) {
    const name = sanitizeFileName(nameMatch[1])
    if (name.length >= 2) return name
  }

  const aboutMatch = input.match(/关于(.{1,20}?)(?:的|之)?(?:文档|文件|报告|方案|计划|总结|纪要|分析)/i)
  if (aboutMatch) {
    const name = sanitizeFileName(aboutMatch[1])
    if (name.length >= 2) return name
  }

  const fileSpecMatch = input.match(/([^\s\\/]{1,40})\.(docx|txt|md|pdf|xlsx)/i)
  if (fileSpecMatch) {
    const name = sanitizeFileName(fileSpecMatch[1])
    if (name.length >= 2) return name
  }

  const cleaned = stripDirectiveWords(input)
  if (!cleaned) return '新建文档'

  const llmResult = await refineFileNameWithLLM(cleaned)
  if (llmResult && llmResult.length >= 2) return llmResult

  return sanitizeFileName(cleaned) || '新建文档'
}

function resolveExt(input: string): string {
  const extMatch = input.match(/\.(docx|txt|md|pdf|xlsx)/i)
  const typeMatch = input.match(/(docx|word|txt|文本|md|pdf|xlsx|文档|文件)/i)
  let ext = extMatch ? extMatch[1].toLowerCase() : ''
  if (!ext) {
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase()
      if (t === 'docx' || t === 'word') ext = 'docx'
      else if (t === 'txt' || t === '文本') ext = 'txt'
      else if (t === 'md') ext = 'md'
      else if (t === 'pdf') ext = 'pdf'
      else if (t === 'xlsx') ext = 'xlsx'
      else ext = 'docx'
    } else {
      ext = 'docx'
    }
  }
  return ext
}

const skillRules: L0SkillRule[] = [
  {
    name: '文件格式转换',
    domain: 'file',
    triggerPatterns: [
      /(转|转换|转为|转成|导出|另存|保存为|处理为|输出为).*(docx|pdf|txt|md|xlsx|csv|json|html)/i,
      /\.(md|txt|html|csv).*(docx|pdf|xlsx)/i,
      /\b(pandoc|convert|export)\b/i
    ],
    forbiddenPatterns: [
      /(审查|合规|条款|风险|法律|合同)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const filePath = extractFilePath(input)
      const targetFormat = extractTargetFormat(input)
      const sourceExt = extractSourceExt(input)
      if (!targetFormat && !sourceExt) return null

      const effectiveTarget = targetFormat || FILE_EXT_MAP[sourceExt || '']
      if (!effectiveTarget) return null

      // 2026-09-25 修复：拿不到真实路径时**不再伪造** `input.<ext>` 占位符。
      // 实测（用户报告 + 运行中 app 的消息流）：发「把桌面上 HoloStarmap\docs 文件夹下的
      // 2026.9.24最新快照.md 文件转为 docx…」时 extractFilePath 抽不到绝对路径，旧实现伪造 `input.9`
      // ⇒ 计划跑到 step2 报「文件不存在（路径：input.9）」⇒ 计划失败 → 回退直答 → 只回一句
      // 「我先确认文件是否存在」就没了下文。把"没识别出路径"伪装成"计划执行失败"，对用户既无信息也无出路。
      // 此处改为如实索要完整路径（与本规则 PDF 分支的"如实说明"同款），不再产出必失败的假计划。
      if (!filePath) {
        return {
          intent: '文件格式转换：未识别到源文件路径',
          steps: [{
            step: 1,
            description: '如实说明未识别到路径，并请用户给出完整路径',
            tool: 'llm_generate',
            params: {
              prompt: `用户要求做文件格式转换，但没能从请求里识别出**真实存在**的源文件路径。请按顺序处理：① 如果用户给了位置线索（例如「桌面上 HoloStarmap\\docs 文件夹下」），就用 list_directory 去那个目录找目标文件；② 找到后，用它的**完整绝对路径**继续（或直接告知用户已找到的完整路径并请他确认）；③ 确实找不到时，请用户提供完整路径。全程不得编造路径、不得假装已经完成转换。支持 docx / pdf / txt / md / xlsx / html 互转。用户原话：${input}`
            },
            expectedOutput: '澄清与路径请求'
          }],
          isExploration: true
        }
      }
      const src = filePath
      // 2026-09-30：产物位置改由 buildOutputPath 决定——用户明说「存到 X 下」就用 X，
      // 不再一律落源文件同目录（V2-R01 实测：题干要求存 out，产物却落 docs）。
      const outputPath = buildOutputPath(src, effectiveTarget, input)

      // 2026-09-30 重写「→ docx」：原实现走 shell_exec + node -e 拼 docx 脚本（依赖
      // `npm install docx`，且该脚本形态历史上多次被安全闸拒——见原注释）。现改为
      // **框架内两步**：取文本（文本源 read_file / 二进制源 doc_extract）→ create_docx。
      if (effectiveTarget === 'docx') {
        const srcExtForDocx = (src.match(/\.(\w{1,5})$/) || [])[1]?.toLowerCase() || ''
        const binarySrc = ['pdf', 'docx', 'xlsx', 'xls'].includes(srcExtForDocx)
        const readStep = binarySrc
          ? { step: 1, description: `提取源文档文本（${srcExtForDocx}）`, tool: 'doc_extract', params: { path: src }, expectedOutput: '文档文本' }
          : { step: 1, description: `读取源文件内容`, tool: 'read_file', params: { path: src }, expectedOutput: '文件内容' }
        return {
          intent: `将 ${src} 转换为 .docx`,
          steps: [
            readStep,
            { step: 2, description: `生成 docx`, tool: 'create_docx', params: { filePath: outputPath, content: '{{step_1_result}}' }, depends_on: [1], expectedOutput: outputPath }
          ],
          isExploration: false
        }
      }

      // 决策 A3（2026-09-23）的"本机无 PDF 渲染器"结论仍然成立（Word/LibreOffice/pandoc 均无），
      // 但 2026-09-24 起不再需要它们：应用内 mammoth（docx→HTML，已是本仓依赖）+ Electron
      // printToPDF（HTML→PDF，Chromium 是本应用运行时）即可出 PDF，零新增依赖、离线可用。
      // 因此这里从"诚实降级"改为**真做**；只有源格式不在支持范围内时才如实说明。
      if (effectiveTarget === 'pdf') {
        const srcExt = (src.match(/\.(\w{1,5})$/) || [])[1]?.toLowerCase() || ''
        if (!['docx', 'md', 'markdown', 'html', 'htm', 'txt'].includes(srcExt)) {
          return {
            intent: `PDF 转换不支持：${src}`,
            steps: [{
              step: 1,
              description: '如实说明不支持的源格式并给替代方案',
              tool: 'llm_generate',
              params: { prompt: `用户要求把「${src}」转成 PDF，但当前只支持 .docx / .md / .html / .txt 作为源文件。请用中文如实说明这一点，并给出可行的替代做法（例如先用 Word 打开后另存为 PDF）。不要假装已经完成转换，也不要编造已生成的文件路径。` },
              expectedOutput: '不支持说明与替代方案'
            }],
            isExploration: false
          }
        }
        return {
          intent: `将 ${src} 转换为 PDF`,
          steps: [
            { step: 1, description: `导出 PDF（应用内渲染，无需本机安装 Office）`, tool: 'file_convert', params: { source: src, target: outputPath }, expectedOutput: outputPath }
          ],
          isExploration: false
        }
      }

      // 2026-09-30 重写：原实现走 read_file + llm_generate —— 只产出模型文本、**不落盘**，
      // 是「假转换」（用户要「转成 xlsx」只拿到一段文字）。现改为：
      //   ① 有真实现的组合（→ txt / md / csv）：取文本 → file_write 两步；二进制源
      //      （pdf/docx/xlsx/xls）先经 doc_extract 真提取（主进程 pdf-parse / mammoth / xlsx）。
      //   ② 无真实现的组合（→ xlsx / json / html）：如实说明，不产任何写盘步骤。
      const srcExtTail = (src.match(/\.(\w{1,5})$/) || [])[1]?.toLowerCase() || ''
      if (['txt', 'md', 'csv'].includes(effectiveTarget)) {
        const binarySrc = ['pdf', 'docx', 'xlsx', 'xls'].includes(srcExtTail)
        const readStep = binarySrc
          ? { step: 1, description: `提取源文档文本（${srcExtTail}）`, tool: 'doc_extract', params: { path: src }, expectedOutput: '文档文本' }
          : { step: 1, description: `读取源文件`, tool: 'read_file', params: { path: src }, expectedOutput: '文件内容' }
        return {
          intent: `将 ${src} 转换为 .${effectiveTarget}`,
          steps: [
            readStep,
            { step: 2, description: `写入 .${effectiveTarget}`, tool: 'file_write', params: { filePath: outputPath, content: '{{step_1_result}}' }, depends_on: [1], expectedOutput: outputPath }
          ],
          isExploration: false
        }
      }

      return {
        intent: `转换为 .${effectiveTarget}：当前无直接实现`,
        steps: [{
          step: 1,
          description: '如实说明不支持并给可行替代',
          tool: 'llm_generate',
          params: { prompt: `用户要把「${src}」转成 .${effectiveTarget}，但应用内没有 ${srcExtTail} → ${effectiveTarget} 的直接转换实现（目标支持 docx / pdf / txt / md / csv；其中 →pdf 的源限 docx / md / html / txt）。请用中文如实说明这一点并给出可行的替代做法，不要假装已完成转换、不要编造已生成的文件路径。` },
          expectedOutput: '不支持说明与替代方案'
        }],
        isExploration: false
      }
    }
  },
  {
    name: '快速Shell命令',
    domain: 'system',
    triggerPatterns: [
      // 2026-09-30：移除 mv|move|rm|del —— shell 白名单（electron/shell-security.ts:4-16 定义，
      // isShellCommandAllowed :436-444 按词边界前缀匹配）不含这些命令，命中只会产出必被拒的
      // 计划（exit -1）。「移动/重命名」改由本文件末尾的「文件移动重命名」规则走 file_move；
      // 删除类不设直达（与 writeGate 的写授权边界取向一致，保留在模型回路里经确认条走）。
      /^(ls|dir|pwd|whoami|date|hostname|cat|type|echo|mkdir|cp|copy)\b/i,
      /^运行\s+/,
      /^执行\s+/,
      // 2026-09-30 实测（test/unit/shellAllowlist.spec.ts）：本支里 `npm install` / `pip install`
      // 会被白名单放行，而 `git` / `python` / `node`（裸 node，非 `node -e`）**全部 DENY**——
      // 即这三个会产出"必失败计划"。**刻意不收窄**：它们没有原生替代能力（不像 `mv` 有
      // `file_move`），收窄只会让请求下沉给模型去解释或编造，比"诚实的白名单拒绝"更差。
      // 若将来为它们加了原生替代，再一并移除。
      /^(npm|node|pip|python|git)\s+/
    ],
    forbiddenPatterns: [
      /(格式|转换|文档|分析|审查|报告)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      // 2026-10-07（V2-R15）：输入可能被追加会话文件清单（含换行），原正则在多行输入上整体不匹配，
      // cmd 回落成整个含换行的输入 → 被 shell 元字符校验拒绝。shell 命令语义上只取首行。
      const firstLine = input.split(/\r?\n/, 1)[0]
      const cmdMatch = firstLine.match(/^(?:运行|执行)?\s*(.*)$/)
      const cmd = (cmdMatch ? cmdMatch[1] : firstLine).trim()
      if (!cmd || cmd.length < 2) return null
      return {
        intent: `执行命令：${cmd.substring(0, 60)}`,
        steps: [
          { step: 1, description: `执行shell命令`, tool: 'shell_exec', params: { command: cmd }, expectedOutput: '命令输出' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '简单文本生成',
    domain: 'creation',
    triggerPatterns: [
      /^(写|生成|帮我写|帮我生成|起草|撰写)\s*(一个|一份|一段|一篇|一封)?\s*.{0,30}?(代码|函数|脚本|邮件|通知|公告|文案|总结)/i
    ],
    forbiddenPatterns: [
      /(周报|会议纪要|合同|财报|竞品|报销)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      return {
        intent: input.substring(0, 60),
        steps: [
          { step: 1, description: 'LLM直接生成', tool: 'llm_generate', params: { prompt: input }, expectedOutput: '生成内容' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: 'HTTP请求',
    domain: 'network',
    triggerPatterns: [
      /^(curl|fetch|get|post|请求|访问|下载)\s+/i,
      /https?:\/\/\S+/
    ],
    forbiddenPatterns: [],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const urlMatch = input.match(/(https?:\/\/\S+)/)
      const url = urlMatch ? urlMatch[1] : ''
      if (!url) return null
      return {
        intent: `HTTP请求：${url.substring(0, 60)}`,
        steps: [
          { step: 1, description: '发送HTTP请求', tool: 'http_request', params: { url, method: 'GET' }, expectedOutput: '响应内容' }
        ],
        isExploration: true
      }
    }
  },
  {
    name: '文件创建',
    domain: 'file',
    triggerPatterns: [
      /(创建|新建|写|生成|保存)(一个|一份)?\s*(docx|word|txt|文本|文档|文件)/i,
      /(创建|新建|写|生成|保存)(一个|一份)?\s*.{0,10}?(文档|文件)\s*(到|在|保存)/i,
      /在(桌面|电脑上|本地)(创建|新建|写|生成|保存).{0,15}?(文档|文件|docx|txt|word)/i,
      /^(创建|新建)(一个|一份)?\s*(docx|word|txt|文档|文件)/i
    ],
    forbiddenPatterns: [
      /(审查|合规|条款|风险|法律|合同|分析|报告|周报|总结|竞品|财报|KPI|预算|摘要|说明|简介)/,
      // P1-D5：列查/查看/转换类输入禁入——它们要的是"读/列举/转格式"而非"创建文件"，
      // 首考 Q14 误路由即因缺此类禁词
      /(列出|清单|有哪些|看一下|查看|找出|搜索|查找|列举|转成|转为|转换为|转换)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const ext = resolveExt(input)
      const rawName = await extractFileName(input, ext)
      const fileName = `${rawName}.${ext}`
      const filePath = `%USERPROFILE%\\Desktop\\${fileName}`

      if (ext === 'docx') {
        return {
          intent: `创建docx文件：${fileName}`,
          steps: [
            { step: 1, description: `创建docx文件并保存到桌面`, tool: 'create_docx', params: { filePath }, expectedOutput: `桌面docx文件: ${fileName}` }
          ],
          isExploration: false
        }
      }

      return {
        intent: `创建${ext}文件：${fileName}`,
        steps: [
          { step: 1, description: `创建${ext}文件并保存到桌面`, tool: 'file_write', params: { filePath, content: '' }, expectedOutput: `桌面${ext}文件: ${fileName}` }
        ],
        isExploration: false
      }
    }
  },
  {
    // 2026-10-07：补「建文件夹 + 归类文件」**组合意图**（真实用户对话实测的缺陷）。
    // 病理链：用户说「将桌面上的docx文档全都放在一个新建的文件夹中」→
    //   ① 既有『创建文件夹』规则的 trigger 要求「新建文件夹」紧邻，用户写的是「新建**的**文件夹」⇒ 不命中；
    //   ② 且该规则 forbiddenPatterns 含 `文档|docx|…`，用户句含 docx ⇒ **主动禁用**；
    //   ③ 于是落到 L2 候选消歧，而候选池**不含 create_directory**（它刻意不进模型工具表，见 nativeTools.ts:18-24）
    //      ⇒ 给出 create_docx/doc_extract/文档翻译/合同风险审查 等完全不沾边的候选；
    //   ④ 用户在无正确选项下被迫选 1 ⇒ 真去**创建了一份 Word 文档**，并把 list_directory 原始返回当答案吐回。
    // 本规则覆盖这一类组合（建目录 + 按类型批量移动），产出**确定性两步计划**，不经候选消歧。
    name: '建文件夹并归类文件',
    domain: 'file',
    triggerPatterns: [
      // 「把/将 … 放/移/归档/整理 … 文件夹/目录」——注意「放在…文件夹里」是最常见说法，方位词要含「在」
      /(把|将).{0,40}?(放|移|归档|整理|收)(进|入|到|在).{0,20}?(文件夹|目录|folder)/i,
      /(放|移|归档|整理|收)(进|入|到|在).{0,15}?(新建|创建|新|一个|你).{0,10}?(文件夹|目录|folder)/i
    ],
    // 不设禁用词：本规则的触发式已足够具体（必须同时出现"把/将 + 位移动词 + 文件夹"）
    forbiddenPatterns: [],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const dir = extractDirPath(input) || '%USERPROFILE%\\Desktop'
      // 目标文件夹名：显式「名为X」优先，否则用默认名（用户说"无需命名"即走默认）
      const nameMatch = input.match(/(?:名为|叫|命名)\s*["「『“”']?([^"」』“”'\s]{1,30})/i)
      let folderName = '新建文件夹'
      if (nameMatch) {
        const cleaned = sanitizeFileName(nameMatch[1])
        if (cleaned.length >= 2) folderName = cleaned
      }
      // 要归类的文件类型（取首个出现的扩展名；无则移动所有文件）
      const extRaw = (input.match(/\.?(docx?|pdf|xlsx?|pptx?|txt|md|csv|png|jpe?g|gif|bmp|zip|rar|mp[34]|wav|mov)\b/i) || [])[1] || ''
      const ext = extRaw.toLowerCase().replace(/^jpeg$/, 'jpg').replace(/^doc$/, 'docx').replace(/^xls$/, 'xlsx').replace(/^ppt$/, 'pptx')
      const target = `${dir}\\${folderName}`
      return {
        intent: ext ? `新建文件夹并把 ${ext} 文件收进去：${folderName}` : `新建文件夹并把文件收进去：${folderName}`,
        steps: [
          { step: 1, description: `创建目标文件夹`, tool: 'create_directory', params: { path: target }, expectedOutput: `目标文件夹: ${folderName}` },
          { step: 2, description: `把 ${dir} 下的${ext ? ' ' + ext + ' ' : ''}文件移入该文件夹`, tool: 'file_move', params: { fromDir: dir, ext, toDir: target }, expectedOutput: '移动结果（含移动数量与文件名）' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '创建文件夹',
    domain: 'file',
    triggerPatterns: [
      /(创建|新建|建)(一个)?\s*(文件夹|目录|folder)/i,
      /在(桌面|电脑上|本地)(创建|新建|建).{0,15}?(文件夹|目录)/i,
      /^(创建|新建)(一个)?\s*(空)?\s*(文件夹|目录)/i,
      /(创建|新建|建)(一个)?\s*.{0,5}?(名为|叫|命名)\s*.{1,20}?(文件夹|目录|folder)/i
    ],
    forbiddenPatterns: [
      /(文档|docx|txt|pdf|xlsx|审查|分析|写|生成|保存)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const nameMatch = input.match(/(?:名为|叫|命名)\s*["「『""']?([^"」』""'\s]{1,30})/i)
        || input.match(/(?:创建|新建|建)(一个)?\s*(空)?\s*(文件夹|目录)?\s*(.{2,20}?)(?:在|到|$)/i)
        || input.match(/(?:名为|叫)\s*(.{2,20}?)(?:的|文件夹|目录|folder|$)/i)
      let folderName = '新建文件夹'
      if (nameMatch) {
        const candidate = nameMatch[1] || nameMatch[4]
        if (candidate) {
          const cleaned = sanitizeFileName(candidate)
          if (cleaned.length >= 2) folderName = cleaned
        }
      }
      return {
        intent: `创建文件夹：${folderName}`,
        steps: [
            { step: 1, description: `创建文件夹`, tool: 'create_directory', params: { path: `${extractDirPath(input) || '%USERPROFILE%\\Desktop'}\\${folderName}` }, expectedOutput: `目标文件夹: ${folderName}` }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '简单查询',
    domain: 'query',
    triggerPatterns: [
      /^(几点|什么时间|今天是|现在几|天气|计算|算一下|等于多少|几号)/i,
      /^(what time|what day|calculate|compute)\b/i,
      /^(今天|现在|当前).{0,5}?(日期|时间|星期|几号)/i,
      /^(现在|当前).{0,5}?(几点|几分)/i
    ],
    forbiddenPatterns: [
      /(分析|报告|审查|对比|文档|文件|转换)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      return {
        intent: input.substring(0, 60),
        steps: [
          { step: 1, description: 'LLM快速回答', tool: 'llm_generate', params: { prompt: input, modelTier: 'nano' }, expectedOutput: '回答结果' }
        ],
        isExploration: false
      }
    }
  },
  {
    name: '快速文件操作',
    domain: 'file',
    triggerPatterns: [
      /^(读取|查看|打开|显示|阅读|看看)(一下)?\s*(文件|文档|内容)?\s*.{0,30}$/i,
      /^(cat|type|head|tail|less|more)\s+/i,
      /^(看看|看一下|读一下|查看一下)\s*.{0,30}$/i
    ],
    forbiddenPatterns: [
      /(分析|审查|转换|修改|编辑|风险|合规|生成报告)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const pathMatch = input.match(/["']?([A-Za-z]:\\[^\s"']+\.\w{1,5})["']?/i)
        || input.match(/["']?(~?\/[^\s"']+\.\w{1,5})["']?/)
        || input.match(/["']?([^\s"']+\.(txt|md|json|csv|log|py|js|ts))["']?/i)
      const filePath = pathMatch ? pathMatch[1] : ''
      if (!filePath) return null
      return {
        intent: `读取文件：${filePath}`,
        steps: [
          { step: 1, description: '读取文件内容', tool: 'read_file', params: { path: filePath }, expectedOutput: '文件内容' }
        ],
        isExploration: false
      }
    }
  },
  {
    // 2026-09-25（HANDOFF 下一步 5）：**图片按拍摄日期重命名**——执行层确定性化。
    // 该意图**不经模型**：直接产出单步计划调用 rename_images_by_date（列目录带日期 → YYYYMMDD-序号 → 逐个移动）。
    // 依据：Q15 长期失败已证伪「提示词能救弱模型」——trace 显示它只反复 list_directory 再编造 shell 结果。
    name: '图片按拍摄日期重命名',
    domain: 'file',
    triggerPatterns: [
      /(重命名|改名|更名|批量命名).{0,12}?(图片|照片|图像|图)/i,
      /(图片|照片|图像).{0,12}?(重命名|改名|更名)/i
    ],
    forbiddenPatterns: [
      /(审查|合规|条款|风险|法律|合同|转换|转成|转为|导出|保存为)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const dir = extractDirPath(input)
      if (!dir) {
        return {
          intent: '图片按拍摄日期重命名：未识别到文件夹路径',
          steps: [{
            step: 1,
            description: '如实说明未识别到文件夹路径，并请用户给出完整路径',
            tool: 'llm_generate',
            params: {
              prompt: `用户要求把某个文件夹里的图片按拍摄日期重命名，但没能从请求里识别出**真实的文件夹路径**。请请用户给出该文件夹的完整绝对路径（例如 C:\\Users\\<用户名>\\Desktop\\某文件夹），拿到后调用 rename_images_by_date。全程不得编造路径、不得假装已完成重命名。用户原话：${input}`
            },
            expectedOutput: '路径澄清'
          }],
          isExploration: false
        }
      }
      return {
        intent: `按拍摄日期重命名 ${dir} 中的图片`,
        steps: [{
          step: 1,
          description: `列出并按拍摄日期重命名 ${dir} 中的图片（EXIF 优先，无 EXIF 取文件系统时间）`,
          tool: 'rename_images_by_date',
          params: { dir },
          expectedOutput: '重命名清单（旧名 → 新名）'
        }],
        isExploration: false
      }
    }
  },
  {
    // 2026-09-30：补 file_move 的**全漏斗空洞**。此前「移动/重命名文件」在 L0/L1/L2 三层
    // 都没有通道，只能靠模型在工具回路里自选 file_move——Q15 实测模型因看不到该工具改用
    // shell_exec，而 shell 白名单不含 ren/move（退出码 -1、0 文件改名、两轮考试连续复现，
    // 见 fileTaskSystemPrompt.ts:17-21）。那次只补了系统提示词，没补漏斗层通道；此处补上。
    name: '文件移动重命名',
    domain: 'file',
    triggerPatterns: [
      /(移动|移到|挪到)/,
      /(重命名|改名|更名)/
    ],
    forbiddenPatterns: [
      // 与规则 9 划清：涉及图片的「按拍摄日期重命名」归规则 9
      /(图片|照片|图像|截图|\.jpe?g|\.png|\.webp|tiff?)/i,
      // 域词交给 L2（避免抢 manifest）
      /(审查|合规|条款|合同|风险|报告|周报|竞品|财报|KPI|预算|摘要|翻译|排版)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      // 抽不到完整的 from/to 就返回 null 下沉——不伪造路径（fail-closed）
      const paths = extractMovePaths(input)
      if (!paths) return null
      return {
        intent: `移动/重命名：${paths.from} → ${paths.to}`,
        steps: [{
          step: 1,
          description: '移动/重命名文件（IPC 直连 fs，不经 shell 白名单）',
          tool: 'file_move',
          params: { from: paths.from, to: paths.to },
          expectedOutput: paths.to
        }],
        isExploration: false
      }
    }
  },
  {
    // 2026-09-30：复制文件。此前复制既无原生工具也无 IPC，只能靠 shell `copy`
    // （受 shell 元字符黑名单与引号转义限制，路径含空格/中文易出错）。现走新增的 file_copy。
    // 触发词收窄 + 路径要求（extractMovePaths）双重兜底，避免把"复制这段文字"这类非文件意图抢进来。
    name: '文件复制',
    domain: 'file',
    triggerPatterns: [
      /(复制|拷贝|copy)/i
    ],
    forbiddenPatterns: [
      // 图片/音视频归 L1 的确定性能力
      /(图片|照片|图像|截图|\.jpe?g|\.png|\.webp|tiff?|视频|音频|\.mp4|\.mp3|\.webm)/i,
      // 域词交给 L2
      /(审查|合规|条款|合同|风险|报告|周报|竞品|财报|KPI|预算|摘要|翻译|排版)/
    ],
    async buildPlan(input: string): Promise<L0DirectPlan | null> {
      const paths = extractMovePaths(input)
      if (!paths) return null
      return {
        intent: `复制：${paths.from} → ${paths.to}`,
        steps: [{
          step: 1,
          description: '复制文件（IPC 直连 fs）',
          tool: 'file_copy',
          params: { from: paths.from, to: paths.to },
          expectedOutput: paths.to
        }],
        isExploration: false
      }
    }
  }
]

export function classifyDomain(input: string): string[] {
  const inputLower = input.toLowerCase()
  const domainRules: Record<string, string[]> = {
    file: ['md', 'docx', 'pdf', 'txt', 'xlsx', '转换', '导出', '保存为', '格式', '文件', '处理为'],
    creation: ['写', '生成', '起草', '撰写', '创建', '新建', '公告', '文案', '代码', '函数'],
    legal: ['合同', '条款', '合规', '审查', '法律风险', '保密', 'nd'],
    finance: ['报销', '预算', 'kpi', '财报', '财务', '发票'],
    sales: ['竞品', '客户', '销售', '方案'],
    hr: ['简历', '入职', '招聘', '面试'],
    system: ['运行', '执行', '命令', 'shell', 'npm', 'node', 'git', 'ls', 'dir']
  }
  const matched: string[] = []
  for (const [domain, keywords] of Object.entries(domainRules)) {
    if (keywords.some(kw => inputLower.includes(kw))) {
      matched.push(domain)
    }
  }
  return matched.length > 0 ? matched : ['general']
}

export async function tryL0Skill(input: string): Promise<L0DirectPlan | null> {
  // 2026-10-07：路由只看用户原话——剥掉 sendMessage 追加的会话文件清单（其文件名会污染规则匹配）
  input = stripSessionFilesContext(input)
  for (const rule of skillRules) {
    const triggered = rule.triggerPatterns.some(p => p.test(input))
    if (!triggered) continue
    const forbidden = rule.forbiddenPatterns?.some(p => p.test(input)) || false
    if (forbidden) continue
    const plan = await rule.buildPlan(input)
    if (plan) {
      debugLog(`[L0 Skill] 命中规则：${rule.name}（${rule.domain}域），跳过RaaP`)
      return plan
    }
  }
  return null
}

export function tryL05QuickMatch(
  input: string,
  manifests: L2ToolManifest[]
): L05QuickMatchResult | null {
  if (!manifests || manifests.length === 0) return null

  const inputLower = extractInstructionSegment(input).toLowerCase()
  const scores: { manifest: L2ToolManifest; hitCount: number; hitRatio: number; matchedKws: string[] }[] = []

  for (const m of manifests) {
    const kws = m.routing.keywords
    if (!kws || kws.length === 0) continue

    const matchedKws: string[] = []
    for (const kw of kws) {
      if (inputLower.includes(kw.toLowerCase())) {
        matchedKws.push(kw)
      }
    }

    if (matchedKws.length === 0) continue

    const hitRatio = matchedKws.length / kws.length
    // 2026-09-30：**此处分母是表长，与 L1 的 conf、L2 的 keywordMatchScoreGeneric 同源，但刻意不归一化**。
    // 三条理由（已核）：
    //   ① 本函数的 hitRatio 不只用于过门——它还是**跨 manifest 的排序键**（下面 sort）与 margin 的基数。
    //      不同 manifest 表长不同，归一化会**改变跨候选的排序**，影响面远大于 L1（L1 是逐条规则独立判定）；
    //   ② 本函数系数是 `×1.5`（L1 是 `×2`）：归一化后单命中 = 1/3 → conf 0.5，**反而低于门 0.6**，
    //      即照搬 L1 的修法会**收紧**而不是放宽；
    //   ③ 现状经校准实测（`test/unit/l05QuickMatch.spec.ts` 的「门值校准基线」）：门 0.6 下
    //      24 条标注输入放行 7 条、**零误配**——即实际形态是"需命中 2+ 词"，严格但可用。
    // 结论：保持原式。若将来要动，必须**重新校准**并覆盖跨候选排序的用例。
    scores.push({ manifest: m, hitCount: matchedKws.length, hitRatio, matchedKws })
  }

  if (scores.length === 0) return null

  scores.sort((a, b) => b.hitRatio - a.hitRatio || b.hitCount - a.hitCount)

  const top = scores[0]
  const second = scores.length > 1 ? scores[1] : null
  const margin = second ? top.hitRatio - second.hitRatio : 1

  const isSingleStep = top.manifest.execution.mode === 'direct'
    || (top.manifest.execution.dagPlan && top.manifest.execution.dagPlan.steps.length === 1)

  if (!isSingleStep) {
    debugLog(`[L0.5] 最佳命中${top.manifest.identity.name}，但为多步(${top.manifest.execution.mode})，交给RaaP`)
    return null
  }

  const confidence = top.hitRatio >= 0.4 && margin >= 0.1
    ? Math.min(top.hitRatio * 1.5, 1.0)
    : 0

  // 2026-09-30：移除此处硬编码的 `confidence >= 0.8` 门。它有两个问题：
  //   ① 把过门线钉死在 hitRatio ≥ 0.533——实测让 L0.5 对典型输入只有 ~8% 命中（近死层）；
  //   ② **遮蔽上层配置面**：funnel 的 `l05Pass` gate（可经 vault config/holo-funnel-gates 覆盖）
  //      只能"抬高"门槛，调低永不生效——低于 0.8 的候选在本函数就已 return null。
  // 现在本函数只做「基本过滤」（hitRatio ≥ 0.4 + margin ≥ 0.1，即 confidence > 0），
  // 过门判定统一交给 funnel 的 `l05Pass`（默认见 DEFAULT_FUNNEL_GATES）。
  if (confidence > 0) {
    debugLog(`[L0.5] 快配候选：${top.manifest.identity.name}（关键词${top.matchedKws.join(',')}，置信${(confidence * 100).toFixed(0)}%）`)
    return { manifest: top.manifest, confidence, matchedKeywords: top.matchedKws }
  }

  if (top.hitRatio >= 0.3) {
    debugLog(`[L0.5] 候选${top.manifest.identity.name}命中率不足(${(top.hitRatio * 100).toFixed(0)}%)，交给RaaP`)
  }

  return null
}

export function checkL1Capability(input: string): L1CapabilityCheck {
  const inputLower = input.toLowerCase()

  // 第一波·文档能力（2026-09-24）：文档 → PDF 是**确定性**能力（应用内渲染，见 electron/docConvert.ts），
  // 命中即直调，不走置信度打分——「转成 PDF」这种请求不需要先问 LLM 该怎么做。
  // 同时要求输入里给出明确路径：只提"pdf"却没有路径时交给下游层，避免抢答。
  const wantsPdf = /(转|导出|生成|输出|保存为|另存为)[^。\n]{0,8}pdf|pdf[^。\n]{0,8}(格式|文件)/i.test(input)
  const convertSrc = wantsPdf ? extractFilePath(input) : null
  if (convertSrc) {
    const target = convertSrc.replace(/\.\w{1,5}$/, '') + '.pdf'
    debugLog(`[L1 Check] 命中：文档转PDF（确定性能力直调）`)
    return {
      canHandle: true,
      nodeId: 'l1-doc-convert',
      nodeName: '文档转PDF',
      confidence: 0.9,
      plan: {
        intent: `将 ${convertSrc} 转换为 PDF`,
        steps: [
          { step: 1, description: '文档转 PDF（应用内渲染）', tool: 'file_convert', params: { source: convertSrc, target }, expectedOutput: target }
        ],
        isExploration: false
      }
    }
  }

  // 第二波·图像能力（2026-09-24）：图片缩放/转格式/压缩是**确定性**能力（应用内 sharp 直调），
  // 命中即直调。准入要求两个条件同时成立：① 提到图片；② 抽得到明确操作参数。
  // 只提到图、没说怎么处理（"帮我看看这张图"）→ 交给下游层，不抢答。
  const mentionsImage = /(图片|照片|图像|截图|\.jpe?g|\.png|\.webp|\.tiff?)/i.test(input)
  if (mentionsImage) {
    const imgSrc = extractFilePath(input)
    const imgOp = extractImageOp(input)
    const hasOp = !!(imgOp.resize || imgOp.format || imgOp.quality !== undefined || imgOp.grayscale)
    if (imgSrc && hasOp) {
      debugLog('[L1 Check] 命中：图片处理（确定性能力直调）')
      const flat: Record<string, string> = { inputs: imgSrc }
      if (imgOp.resize?.width !== undefined) flat.width = String(imgOp.resize.width)
      if (imgOp.resize?.height !== undefined) flat.height = String(imgOp.resize.height)
      if (imgOp.resize?.percent !== undefined) flat.percent = String(imgOp.resize.percent)
      if (imgOp.format) flat.format = imgOp.format
      if (imgOp.quality !== undefined) flat.quality = String(imgOp.quality)
      if (imgOp.grayscale) flat.grayscale = 'true'
      // 2026-09-30：同 media 分支——尊重用户指定的输出目录（同一不变量，同族缺口一并补齐）。
      const imgOutDir = extractOutputDir(input)
      if (imgOutDir) flat.outDir = imgOutDir
      return {
        canHandle: true,
        nodeId: 'l1-image-ops',
        nodeName: '图片处理',
        confidence: 0.9,
        plan: {
          intent: `处理图片 ${imgSrc}`,
          steps: [
            { step: 1, description: '图片处理（应用内 sharp）', tool: 'image_process', params: flat, expectedOutput: '处理后的图片路径' }
          ],
          isExploration: false
        }
      }
    }
  }

  // 第三波·媒体能力（2026-09-30 补）：音视频转码/压缩/裁剪/出缩略图是**确定性**能力
  // （应用内 ffmpeg 直调，经 IPC media:process）。`l1-media-ops` 此前登记在 L1_CAPABILITIES
  // 且被 l2-media-process-v1 引用为 requiredL1，却没有任何路由出口——与 doc-convert/image-ops
  // 两个同族的后补确定性能力不一致，此处补齐。
  // 与 image-ops 同款准入：① 提到音视频；② 抽得到明确操作参数。缺任一条就交给下游（不抢答）。
  const mentionsMedia = /(视频|音频|音轨|录音|\.(?:mp4|mov|mkv|webm|avi|mp3|wav|aac|m4a|ogg|flac))/i.test(input)
  if (mentionsMedia) {
    const mediaSrc = extractFilePath(input)
    const mediaOp = extractMediaOp(input)
    const hasOp = !!(mediaOp.format || mediaOp.crf !== undefined || mediaOp.start !== undefined
      || mediaOp.duration !== undefined || mediaOp.thumbnailAt !== undefined || mediaOp.width !== undefined)
    if (mediaSrc && hasOp) {
      debugLog('[L1 Check] 命中：音视频处理（确定性能力直调）')
      const flat: Record<string, string> = { inputs: mediaSrc }
      if (mediaOp.format) flat.format = mediaOp.format
      if (mediaOp.crf !== undefined) flat.crf = String(mediaOp.crf)
      if (mediaOp.start !== undefined) flat.start = String(mediaOp.start)
      if (mediaOp.duration !== undefined) flat.duration = String(mediaOp.duration)
      if (mediaOp.thumbnailAt !== undefined) flat.thumbnailAt = String(mediaOp.thumbnailAt)
      if (mediaOp.width !== undefined) flat.width = String(mediaOp.width)
      // 2026-09-30：尊重用户指定的输出目录（V2-M06 实测：题干「存到 out 下」，产物仍落源同目录 media）。
      // 与 file_convert 分支（buildOutputPath）同源同型，只是此前漏了这条路径；通道现成（buildMediaProcessArgs 支持 outDir）。
      const mediaOutDir = extractOutputDir(input)
      if (mediaOutDir) flat.outDir = mediaOutDir
      return {
        canHandle: true,
        nodeId: 'l1-media-ops',
        nodeName: '音视频处理',
        confidence: 0.9,
        plan: {
          intent: `处理音视频 ${mediaSrc}`,
          steps: [
            { step: 1, description: '音视频处理（应用内 ffmpeg）', tool: 'media_process', params: flat, expectedOutput: '处理后的媒体文件路径' }
          ],
          isExploration: false
        }
      }
    }
  }

  const l1Rules: {
    nodeId: string
    nodeName: string
    keywords: string[]
    forbidden: string[]
    /** 计划步骤挂的工具名；`l1-*` 由 macroExecutor 的 L1 分派路由到 pipelineExecutor 的 NodeHandler 注册表 */
    tool: string
    buildParams: (input: string) => Record<string, string>
  }[] = [
    {
      nodeId: 'l1-model-gateway',
      nodeName: '模型网关',
      // 2026-09-30：分母改为 min(表长,3) 后，表长不再惩罚覆盖广度 → 恢复同义表达。
      // 仍**不放宽词**（"帮我写""写一段"）：它们该走 L0 规则 3 或 L2，入表会抢路由。
      keywords: ['翻译', '润色', '总结', '概括', '改写', '生成文本'],
      forbidden: ['文档', '文件', 'docx', '报告', '审查', '风险', '合同', '竞品', '周报', '会议纪要', 'xlsx', 'ppt'],
      tool: 'llm_generate',
      buildParams: (input) => ({ prompt: input })
    },
    {
      nodeId: 'l1-knowledge-feeder',
      nodeName: '知识检索',
      // 2026-09-30：同 model-gateway——表长不再惩罚覆盖，恢复同义表达。
      keywords: ['检索', '知识库', '查一下', '搜索知识'],
      forbidden: ['文档', '文件', '创建', '新建', '写文件', '审查'],
      tool: 'llm_generate',
      buildParams: (input) => ({ prompt: input })
    },
    // ---- 2026-09-30 补齐：L1_TOOLS 声明六节点，此前路由层只认上面两个（+2 个确定性能力）----
    // task-translator / pipeline-builder / workspace-memory / result-beautifier 在执行侧均有
    // handler（pipelineExecutor.ts 的 registerHandler）却无路由入口，属「半接」；此处补上路由可达性。
    //
    // 【关键词表必须短】confidence 公式 = min(matchedKw / keywords.length × 2, 0.9)：
    // 每表 3 词时单次命中即 0.667 ≥ 门 0.6；若堆到 9-10 词，单命中只有 0.2，规则将永不触发。
    // 故每条只放 2-3 个高辨识度词，配合 forbidden 挡住 L2 高频域词防劫持。
    //
    // 【2026-09-30 深化】这四个节点不再统一挂 `llm_generate`——直接挂各自的 `l1-*` 工具名，
    // 执行时经 macroExecutor 的 L1 分派调用 pipelineExecutor 里已注册的对应 handler，
    // 让「补上的工具」名副其实（此前仅可路由，产出与普通 llm_generate 无差别）。
    {
      nodeId: 'l1-task-translator',
      nodeName: '任务翻译官',
      keywords: ['拆解', '执行步骤', '任务分解'],
      forbidden: ['文档', '文件', 'docx', '合同', '审查', '风险', '报告', '周报', 'xlsx', 'ppt', '表格', '清单'],
      tool: 'l1-task-translator',
      buildParams: (input) => ({ input })
    },
    {
      nodeId: 'l1-result-beautifier',
      nodeName: '结果美化师',
      keywords: ['排版', '美化', '渲染成'],
      forbidden: ['创建', '新建', '写文件', '删除', '移动', '审查', '合同', '风险', '周报', '会议纪要'],
      tool: 'l1-result-beautifier',
      buildParams: (input) => ({ content: input, format: 'html' })
    },
    {
      nodeId: 'l1-workspace-memory',
      nodeName: '工作区记忆体',
      keywords: ['还记得', '之前聊过', '历史记录'],
      forbidden: ['创建', '新建', '写入', '删除', '审查', '合同'],
      tool: 'l1-workspace-memory',
      buildParams: () => ({})
    },
    {
      nodeId: 'l1-pipeline-builder',
      nodeName: '流水线搭建台',
      keywords: ['编排', '流水线', '自动化流程'],
      forbidden: ['审查', '合同', '报告', '风险'],
      tool: 'l1-pipeline-builder',
      buildParams: (input) => ({ task: input })
    }
  ]

  for (const rule of l1Rules) {
    const hasKeyword = rule.keywords.some(kw => inputLower.includes(kw))
    if (!hasKeyword) continue
    const hasForbidden = rule.forbidden.some(fw => inputLower.includes(fw))
    if (hasForbidden) continue

    const matchedKwCount = rule.keywords.filter(kw => inputLower.includes(kw)).length
    // 2026-09-30：分母由「表长」改为 min(表长, 3)。原式 `命中数 / 表长 × 2` 让**表越长越难命中**——
    // 8 词表单次命中只有 0.25，永远过不了 0.6 门（实测「改写这段文字」因此漏接，缩表的代价即丢同义表达）。
    // 以 3 词为满分基准后：命中 1 个即 0.667 ≥ 门，表长不再惩罚覆盖广度；3 词及以下的表行为完全不变。
    // **代价与约束**：表可以列更多同义词，故表内只放"该能力专属、不与他层抢"的中高辨识度词；
    // 宽词（"帮我写""写一段"）仍不得入表——它们该走 L0 规则 3 或 L2。
    const denom = Math.min(rule.keywords.length, 3)
    const confidence = Math.min(matchedKwCount / denom * 2, 0.9)

    if (confidence >= 0.6) {
      debugLog(`[L1 Check] 命中：${rule.nodeName}（置信${(confidence * 100).toFixed(0)}%）`)
      return {
        canHandle: true,
        nodeId: rule.nodeId,
        nodeName: rule.nodeName,
        confidence,
        plan: {
          intent: input.substring(0, 60),
          steps: [
            { step: 1, description: `${rule.nodeName}处理`, tool: rule.tool, params: rule.buildParams(input), expectedOutput: '处理结果' }
          ],
          isExploration: false
        }
      }
    }
  }

  return { canHandle: false, nodeId: '', nodeName: '', confidence: 0, plan: null }
}

/**
 * N2：从「文件相关但无显式路径」的输入里提取要列出的目录（验收考试 Q14/Q16 修复）。
 * - 提到「X 文件夹」/「文件夹 X」→ %USERPROFILE%\Desktop\X
 * - 提到「桌面」→ %USERPROFILE%\Desktop
 * 仅在同时含「文件意图 + 检索意图」时返回，避免劫持普通请求（润色/算术等）。
 */
function extractMentionedDir(input: string): string | null {
  // 变更类指令（重命名/移动/删除…）不该被「列目录并回答」分支劫持——它要的是改文件，不是列清单。
  // Q15 实测：图片重命名任务被劫持为列目录计划，且目录猜错。
  if (/(重命名|改名|命名|移动|复制|删除|整理|归档|转成|转为|转换为|转换成)/.test(input)) return null

  const FILE_INTENT = /(桌面|文件夹|目录|docx|word|pdf|txt|xlsx|文件)/i
  const FIND_INTENT = /(列出|列举|清单|有哪些|找一下|查找|找出|查一下|看一下|看看|读取|打开|里的|里面的)/
  if (!FILE_INTENT.test(input) || !FIND_INTENT.test(input)) return null

  // 优先采用输入里的**显式路径**（含中间目录段）。Q15 实测：曾把
  // `C:\...\Desktop\HoloExam\photos` 猜成 `%USERPROFILE%\Desktop\photos`（丢了 HoloExam）。
  const explicit = input.match(/[A-Za-z]:\\[^\s，。；、！？"'”’（）()【】]*/)
  if (explicit) {
    let p = explicit[0].replace(/\\+$/, '')
    if (!/[文件夹目录]$/.test(p)) p = p.replace(/[\\/][^\\/]*\.\w{1,5}$/, '')  // 形如 \a.docx → 取其所在目录
    if (p && /[\\/]/.test(p)) return p
  }

  const DESKTOP = '%USERPROFILE%\\Desktop'
  const folderMatch = input.match(/([A-Za-z0-9_\u4e00-\u9fff]{2,30})\s*文件夹/)
    || input.match(/文件夹\s*([A-Za-z0-9_\u4e00-\u9fff]{2,30})/)
  if (folderMatch) {
    const name = folderMatch[1].replace(/[（(].*$/, '').trim()
    if (name && name !== '桌面') return `${DESKTOP}\\${name}`
  }
  return DESKTOP
}

export async function buildExplorePlan(input: string): Promise<L0DirectPlan> {
  // 2026-10-07：同 tryL0Skill——探索层的文件/列举判定不得被追加清单里的文件名带偏（V2-T02）
  input = stripSessionFilesContext(input)
  const filePath = extractFilePath(input)
  const targetFormat = extractTargetFormat(input)
  const sourceExt = extractSourceExt(input)

  if (filePath || targetFormat || sourceExt) {
    const skillPlan = await skillRules[0].buildPlan(input)
    if (skillPlan) {
      debugLog(`[Explore] 文件操作探索模式：${skillPlan.intent}`)
      return skillPlan
    }
  }

  // N2：文件相关但无显式路径（如「列桌面 .docx 清单」「在 HoloExam 文件夹里找张三的报销单」）
  // → 由框架**确定性**列目录，把真实清单喂给 LLM。此前这类输入落到下面的通用单步 llm_generate，
  // 计划里没有任何文件步骤，框架把「调不调工具」交给 3b 小模型、而它用散文回「我无法访问你的文件」。
  const mentionedDir = extractMentionedDir(input)
  if (mentionedDir) {
    // 2026-09-25（HANDOFF「下一步 1」做法②）：**列某类文件清单**的确定性收口。
    // 识别到「目录 + 某扩展名 + 列清单意图（非读内容）」时，产出**单步 list_directory + ext**——
    // 计划全为原生工具 ⇒ confirmPlan 的 isAllNative 快路径直接呈现清单、**不经模型综合**，
    // 消除 Q14 弱模型转述时把文件名首尾粘连的失败形态。需读内容的请求（如 Q16 报销金额）仍走下面三步。
    const listingExt = extractListingExt(input)
    if (listingExt && isListingIntent(input)) {
      debugLog(`[Explore] 文件清单确定性收口：list_directory ${mentionedDir}（仅 .${listingExt}）`)
      return {
        intent: `列出 ${mentionedDir} 下的 .${listingExt} 文件清单`,
        steps: [
          { step: 1, description: `列出目录 ${mentionedDir} 下的 .${listingExt} 文件（确定性清单）`, tool: 'list_directory', params: { path: mentionedDir, ext: listingExt }, expectedOutput: '文件清单' }
        ],
        isExploration: false
      }
    }
    debugLog(`[Explore] 文件检索探索模式：列目录 ${mentionedDir}`)
    return {
      intent: `列出目录并回答：${input.substring(0, 50)}`,
      steps: [
        { step: 1, description: `列出目录内容：${mentionedDir}`, tool: 'list_directory', params: { path: mentionedDir }, expectedOutput: '目录中的文件清单' },
        { step: 2, description: '读取最相关的文件内容', tool: 'read_file', params: { path: '{{step_1_top_files}}' }, expectedOutput: '文件内容', depends_on: [1] },
        { step: 3, description: '依据真实数据回答用户', tool: 'llm_generate', params: { prompt: `用户请求：${input}\n\n目录 ${mentionedDir} 的实际内容清单：\n{{step_1_result}}\n\n其中最相关文件的内容：\n{{step_2_result}}\n\n请严格基于以上真实数据回答用户请求。` }, expectedOutput: '回答结果', depends_on: [2] }
      ],
      isExploration: true
    }
  }

  debugLog(`[Explore] 通用探索模式，L1直调`)
  return {
    intent: input.substring(0, 60),
    steps: [
      { step: 1, description: 'LLM直接处理用户请求', tool: 'llm_generate', params: { prompt: input }, expectedOutput: '处理结果' }
    ],
    isExploration: true
  }
}

export type { L0DirectPlan }

/**
 * 从用户输入里解析「产物输出目录」（如「存到 C:\x\out 下」「保存到 D:\y」）。
 *
 * 背景：`outputPath` 原实现一律取源文件同目录，用户明说「存到 X 下」也不生效——
 * V2-R01 实测：题干要求存 out，产物仍落 docs。这是**路由层参数计算**问题，
 * 不是提示词问题（模型不参与决定该路径），故在此处修。
 */
export function extractOutputDir(input: string): string | null {
  const m = /(?:存到|保存到|存至|放到|放在|输出到|导出到|写入到|转存到|另存到|导到|移到|移动到)\s*[「"']?([A-Za-z]:\\[^「」"'`，。；;、\s]+)/.exec(input || '')
  if (!m) return null
  return m[1].replace(/[\\/]+$/, '')
}

/**
 * 组装产物绝对路径：用户指定了输出目录就用它，否则与源文件同目录（保持既有行为）。
 * @param sourcePath 源文件绝对路径
 * @param ext 目标扩展名（不含点）
 * @param userInput 用户原话，用于解析输出目录
 */
export function buildOutputPath(sourcePath: string, ext: string, userInput = ''): string {
  const stem = sourcePath.replace(/\.\w{1,5}$/, '').split(/[\\/]/).pop() || 'output'
  const dir = extractOutputDir(userInput)
  if (dir) return `${dir}\\${stem}.${ext}`
  return `${sourcePath.replace(/\.\w{1,5}$/, '')}.${ext}`
}
