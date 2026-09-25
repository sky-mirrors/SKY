// N1：常驻原生工具定义——把应用已具备的原生文件能力暴露为 LLM 可调用的 function-calling 工具。
//
// 背景（验收考试复考 exam-report.json 实证，Q3/Q16/Q18 三题）：
//   dialogStore.buildMcpTools() 交给模型的工具集 = 「已连接 MCP 服务器的工具」+ 硬编码的 shell_exec。
//   原生文件 IPC（window.electronAPI.fileRead/fileWrite）从未成为可调用工具；而 MCP_CATALOG 里的
//   文件系统服务器（@modelcontextprotocol/server-filesystem）需用户手动 npx 安装并连接。
//   于是未连 MCP 文件服务器时，模型手里只有 shell_exec 一个工具，面对「查桌面文件」类请求
//   只能给散文回答——逐题证据即 Q16「我无法直接在您的电脑上查找文件…但我可以指导你」。
//
// 本模块把 read_file / list_directory / file_write 声明为常驻工具，与 shell_exec 同等待遇：
//   buildMcpTools 注入 → filterToolsByPlan 不剔除 → activeTools 过滤保留 → executeToolCall 分发。
import type { ToolDef } from './nativeToolTypes'

/** 常驻工具名（任何过滤/召回环节都不得剔除；shell_exec 已在 buildMcpTools 硬编码，此处仅纳入白名单） */
export const NATIVE_TOOL_NAMES = ['shell_exec', 'read_file', 'list_directory', 'file_write', 'file_move', 'file_convert', 'create_docx', 'rename_images_by_date', 'image_process', 'media_process'] as const

/** 判定某工具名是否为「常驻工具」——供 filterToolsByPlan / activeTools 过滤保留 */
export function isAlwaysAvailableTool(name: string): boolean {
  return (NATIVE_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * 单工具直调场景下补齐常驻原生工具（去重，匹配到的工具排在最前）。
 *
 * 背景（2026-09-24 运行时实测）：funnel 的 `mcp-direct` 分支与旧内联 RaaP 的两处 MCP
 * 直调分支原先只把「匹配到的那一个工具」交给模型（`tools: [matched]`）。插桩实测请求特征
 * `toolsLen=1, tools=["list_directory"]`——于是 Q15「图片按拍摄日期重命名」时模型只看到
 * file_move，回复「我只有移动/重命名文件的工具」，无法先列目录再改名（R19 文件类题集体退化）。
 * 本模块头部已确立约定「常驻工具不得被任何过滤/召回环节剔除」，这三处直调分支违反了它，
 * 故统一经本函数补齐，而不是点状修补其中一处。
 */
export function withAlwaysAvailableTools(
  matched: ToolDef | undefined | null,
  allTools: ToolDef[]
): ToolDef[] {
  const base = matched ? [matched] : []
  const always = allTools.filter(t => isAlwaysAvailableTool(t.name))
  return [...base, ...always].filter((t, i, arr) => arr.findIndex(x => x.name === t.name) === i)
}

/**
 * shell_exec 失败时给模型的**可操作**提示（Q15 真缺陷，2026-09-25）。
 *
 * `SHELL_ALLOWED_COMMANDS` 不含 ren / move / Move-Item / del，重命名/移动类命令必被拒
 * （退出码 -1，见 electron/ipc-handlers.ts:385-386）。只回"命令执行失败（退出码-1）"时，
 * 弱模型会卡住或反复重试同一条被拒命令——验收考试实测：Q15 走 mcp-direct 时模型仍选 shell
 * （一次等了 5 分钟写权限超时、一次 16s 即失败），两轮整题失败。
 *
 * 这里把失败信息直接指向 **file_move**：工具回路会把该结果回灌给模型，它据此即可改用，让失败
 * 自纠正——不依赖"模型是否读懂并遵守了 system 提示"（实测纯提示词对 qwen2.5:3b 不可靠）。
 */
export function looksLikeRenameCommand(command: string): boolean {
  const c = String(command || '')
  return /\b(ren|rename|move|move-item|rename-item|mv)\b/i.test(c) || /renamesync|os\.rename|fs\.rename|::Move\s*\(|git\s+mv/i.test(c)
}

/**
 * 判定一条 shell 失败是否为**白名单拒绝**（`electron/shell-security.ts` 的 SHELL_ALLOWED_COMMANDS
 * 只含 npm install / dir / ls / cat / echo / type / mkdir / copy / cp / cd / pwd / pip install）。
 * 这类拒绝必须回给模型**可操作的替代**，否则弱模型只会重复同一条被拒命令然后放弃。
 */
export function looksLikeWhitelistRejection(stderr?: string): boolean {
  const s = String(stderr || '')
  return s.includes('安全策略拒绝') || s.includes('白名单') || s.includes('命令被安全策略')
}

export function shellFailureMessage(command: string, code: number | string | undefined, stderr?: string): string {
  const base = `命令执行失败（退出码${code}）`
  if (looksLikeWhitelistRejection(stderr)) {
    return `${base}。原因：该命令不在 shell 白名单内。文件类操作请改用原生工具——重命名/移动→file_move（参数 from=原路径、to=新路径）、写文件→file_write、转 PDF→file_convert、图片处理→image_process。不要用 shell 做文件操作。`
  }
  if (looksLikeRenameCommand(command)) {
    return `${base}。原因：shell 命令白名单不含 ren / move / Move-Item / del——重命名或移动文件请【改用 file_move 工具】（参数 from=原路径、to=新路径），不要再用 shell 重试。`
  }
  return base
}

/** 常驻原生工具定义（不含 shell_exec——其定义保留在 dialogStore.buildMcpTools） */
export interface ImageProcessArgs {
  inputs: string[]
  op: {
    resize?: { width?: number; height?: number; percent?: number }
    format?: string
    quality?: number
    rotate?: number
    grayscale?: boolean
  }
  outDir?: string
  suffix?: string
}

/**
 * 把模型给的**扁平**参数整理成 `image:process` 的请求体。
 * 两条工具执行路径（macroExecutor.callToolDirectWithTier、dialogStore.executeToolCall）共用本函数——
 * 各写一份整理逻辑必然漂移（O10 的教训）。扁平化的原因：小模型处理嵌套对象不稳，
 * 宽/高/格式这些直接平铺成顶层参数命中率明显更高。
 */
export function buildImageProcessArgs(args: Record<string, unknown>): ImageProcessArgs {
  // 未绑定的模板占位符（形如 {{files}}）视同"没给"——否则它们会被当成字面量传下去，
  // 变成 Number('{{w}}')=NaN 这类噪声参数（清单里的可选槽就会踩这个坑）。
  const isUnbound = (v: unknown): boolean => typeof v === 'string' && v.includes('{{')
  const raw = args.inputs ?? args.input ?? args.path ?? args.source
  const inputs = Array.isArray(raw)
    ? raw.map(v => String(v)).filter(v => !isUnbound(v))
    : (raw && !isUnbound(raw) ? [String(raw)] : [])

  const op: ImageProcessArgs['op'] = {}
  const resize: { width?: number; height?: number; percent?: number } = {}
  if (args.width !== undefined && !isUnbound(args.width)) resize.width = Number(args.width)
  if (args.height !== undefined && !isUnbound(args.height)) resize.height = Number(args.height)
  if (args.percent !== undefined && !isUnbound(args.percent)) resize.percent = Number(args.percent)
  if (Object.keys(resize).length > 0) op.resize = resize
  if (args.format && !isUnbound(args.format)) op.format = String(args.format).toLowerCase()
  if (args.quality !== undefined && !isUnbound(args.quality)) op.quality = Number(args.quality)
  if (args.rotate !== undefined && !isUnbound(args.rotate)) op.rotate = Number(args.rotate)
  if (args.grayscale === true || args.grayscale === 'true') op.grayscale = true

  const outDirRaw = args.outDir ?? args.outdir
  const result: ImageProcessArgs = { inputs, op }
  if (outDirRaw && !isUnbound(outDirRaw)) result.outDir = String(outDirRaw)
  if (args.suffix !== undefined && String(args.suffix) && !isUnbound(args.suffix)) result.suffix = String(args.suffix)
  return result
}

export interface MediaProcessArgs {
  inputs: string[]
  op: {
    format?: string
    crf?: number
    start?: number
    duration?: number
    thumbnailAt?: number
    width?: number
  }
  outDir?: string
  suffix?: string
}

/**
 * 第三波·媒体能力：扁平参数 → `media:process` 请求体。
 * 与 buildImageProcessArgs 同一约定：两条执行路径共用、未绑定的 {{...}} 视同"没给"。
 * 同义词收编：target/targetFormat→format、thumbnail/atSecond→thumbnailAt。
 * 刻意**不**把 quality 映射成 crf——「质量」与 CRF 是反义，宁可让模型显式说 crf，也不猜错方向。
 */
export function buildMediaProcessArgs(args: Record<string, unknown>): MediaProcessArgs {
  const isUnbound = (v: unknown): boolean => typeof v === 'string' && v.includes('{{')
  const raw = args.inputs ?? args.input ?? args.path ?? args.source
  const inputs = Array.isArray(raw)
    ? raw.map(v => String(v)).filter(v => !isUnbound(v))
    : (raw && !isUnbound(raw) ? [String(raw)] : [])

  const op: MediaProcessArgs['op'] = {}
  const fmt = args.format ?? args.targetFormat ?? args.target
  if (fmt && !isUnbound(fmt)) op.format = String(fmt).toLowerCase().replace(/^\./, '')
  if (args.crf !== undefined && !isUnbound(args.crf)) op.crf = Number(args.crf)
  if (args.start !== undefined && !isUnbound(args.start)) op.start = Number(args.start)
  if (args.duration !== undefined && !isUnbound(args.duration)) op.duration = Number(args.duration)
  const thumb = args.thumbnailAt ?? args.thumbnail ?? args.atSecond
  if (thumb !== undefined && !isUnbound(thumb)) op.thumbnailAt = Number(thumb)
  if (args.width !== undefined && !isUnbound(args.width)) op.width = Number(args.width)

  const outDirRaw = args.outDir ?? args.outdir
  const result: MediaProcessArgs = { inputs, op }
  if (outDirRaw && !isUnbound(outDirRaw)) result.outDir = String(outDirRaw)
  if (args.suffix !== undefined && String(args.suffix) && !isUnbound(args.suffix)) result.suffix = String(args.suffix)
  return result
}

export const NATIVE_TOOL_DEFS: ToolDef[] = [
  {
    name: 'read_file',
    description: '读取本机文件内容（文本）。用于查看桌面/文档目录下的具体文件内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件绝对路径。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: '列出本机某个目录下的文件与子目录。可带 ext 只列某类文件（如只列 .docx）。用于盘点桌面文件、找某文件是否存在。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录绝对路径。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        ext: { type: 'string', description: '可选：只列出该扩展名的文件（如 docx / pdf / txt，不带点）。用于「这个目录里有哪些 .docx 文件」这类请求——传了就只返回该类型文件的文件名清单。' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_write',
    description: '把文本内容写入本机文件（覆盖写）。用于生成 .txt/.md 等文本文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件绝对路径' },
        content: { type: 'string', description: '要写入的文本内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'file_move',
    description: '重命名或移动本机文件/文件夹（源路径 → 目标路径）。用于按规则批量重命名图片、整理文件等。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件绝对路径。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        to: { type: 'string', description: '目标文件绝对路径（可与源同目录以仅改名）。【必须基于用户请求里的真实路径推导，不要使用任何示例路径】' }
      },
      required: ['from', 'to']
    }
  },
  {
    // 2026-09-25（HANDOFF 下一步 5）：Q15「图片按拍摄日期重命名」长期失败——弱模型在自由工具回路里
    // 只反复列目录、收口时编造「用 shell、退出码 -1」，提示词侧改四条仍无效。执行层确定性化：
    // 把「列目录（带拍摄日期）→ 按 YYYYMMDD-序号 重命名」做成一个工具，一次调用跑完整批。
    name: 'rename_images_by_date',
    description: '把某个文件夹里的图片**按拍摄日期**批量重命名成「日期-序号.ext」（如 20260315-01.jpg）：日期优先取 EXIF 拍摄时间，无 EXIF 时取文件系统时间；同一天按原文件名顺序从 01 编号。一次调用完成整批重命名并返回新文件名清单。遇到「把这个文件夹的图片/照片按拍摄日期（或拍摄时间）重命名」这类请求就用它——不要逐张 file_move，也不要用 shell（重命名类 shell 命令会被安全策略拒绝）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '图片所在文件夹的**绝对路径**（不是文件路径）。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' }
      },
      required: ['dir']
    }
  },
  {
    // 2026-09-25：把 app 自带的真 docx 写入能力接给模型。
    // 背景：主进程 `file:createDocx`（electron/ipc-handlers.ts:419）一直在，但只被应用内部
    // （长回复导出到桌面）使用，**没有工具定义**——于是用户说「把 x.md 转成 docx」时，模型只能
    // 去用 file_convert（出口被写死为 PDF）或 shell+node -e（被安全闸拒），两条路都出不来 docx。
    // 本工具把「读到的文本 → 真 docx」这条最稳的路给它（不碰 shell，绕开全部 shell 闸）。
    name: 'create_docx',
    description: '把一段**文本内容**写成真正的 Word 文档（.docx）并保存到指定绝对路径。用于「把 x.md / 这段内容转成 Word 文档」这类请求：先用 read_file 读出 .md 等源文件的文本，再调用本工具写入 .docx。不要用 shell + node -e 生成 docx（会被安全策略拒绝），也不要用 file_write 往 .docx 后缀写纯文本（那不是真 docx）。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '目标 .docx 的绝对路径（须以 .docx 结尾）。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        source: { type: 'string', description: '源文件绝对路径（.md / .txt 等）。把**已有文件**转成 docx 时优先用这个——工具会自己读取它，无需你先把正文读出来。与 content 二选一。' },
        content: { type: 'string', description: '直接给出的文本内容；内容较短时用这个。与 source 二选一。' },
        title: { type: 'string', description: '可选：文档标题，会作为一级标题写在第 1 段' }
      },
      required: ['filePath']
    }
  },
  {
    name: 'file_convert',
    description: '把本机文档导出为 PDF（支持 .docx / .md / .html / .txt）。应用内转换，无需本机安装 Word 或其它办公软件。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源文件绝对路径，扩展名须为 .docx/.md/.html/.txt。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        target: { type: 'string', description: '目标 PDF 绝对路径，须以 .pdf 结尾；不填则默认与源文件同目录同名。' }
      },
      required: ['source']
    }
  },
  {
    name: 'image_process',
    description: '批量处理本机图片：缩放（width/height/percent）、转格式（jpeg/png/webp/avif/tiff）、压缩（quality）、旋转（90/180/270）、转灰度。用于「把这批图压一下 / 转成 webp / 缩到 800 宽」这类请求。输入支持 jpg/jpeg/png/webp/tiff/bmp/gif/svg。',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: '源图片绝对路径列表。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        width: { type: 'number', description: '目标宽度（像素，等比缩放）' },
        height: { type: 'number', description: '目标高度（像素）' },
        percent: { type: 'number', description: '按百分比缩放（50 表示缩小一半）' },
        format: { type: 'string', description: '输出格式：jpeg/png/webp/avif/tiff；不填沿用源格式' },
        quality: { type: 'number', description: '有损压缩质量 1-100（默认 82）' },
        rotate: { type: 'number', description: '旋转角度：90/180/270' },
        grayscale: { type: 'boolean', description: '是否转灰度' },
        outDir: { type: 'string', description: '输出目录；不填则与各源文件同目录' },
        suffix: { type: 'string', description: '输出文件名后缀；不填默认 -out' }
      },
      required: ['inputs']
    }
  },
  {
    name: 'media_process',
    description: '处理本机音视频：转格式（mp4/webm/gif/mp3/wav/aac）、压缩（crf）、裁剪（start/duration 秒）、出缩略图（thumbnailAt 秒）、缩放（width）。输入支持 mp4/mov/mkv/webm/avi/mp3/wav/aac/m4a/ogg/flac 等。',
    parameters: {
      type: 'object',
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, description: '源文件绝对路径列表。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' },
        format: { type: 'string', description: '目标格式：mp4/webm/gif/mp3/wav/aac；不填沿用源格式' },
        crf: { type: 'number', description: '视频质量 CRF 0-51，越小越清晰体积越大（默认 23）' },
        start: { type: 'number', description: '裁剪起点（秒）' },
        duration: { type: 'number', description: '裁剪时长（秒）' },
        thumbnailAt: { type: 'number', description: '在指定秒数出一张缩略图（只产出图片）' },
        width: { type: 'number', description: '缩放宽度（像素，等比）' },
        outDir: { type: 'string', description: '输出目录；不填则与各源文件同目录' },
        suffix: { type: 'string', description: '输出文件名后缀；不填默认 -out' }
      },
      required: ['inputs']
    }
  }
]
