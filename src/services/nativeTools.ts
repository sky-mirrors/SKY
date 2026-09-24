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
export const NATIVE_TOOL_NAMES = ['shell_exec', 'read_file', 'list_directory', 'file_write', 'file_move', 'file_convert'] as const

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

/** 常驻原生工具定义（不含 shell_exec——其定义保留在 dialogStore.buildMcpTools） */
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
    description: '列出本机某个目录下的文件与子目录。用于盘点桌面文件、找某文件是否存在。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录绝对路径。【必须使用用户请求里给出的真实路径，不要使用任何示例路径】' }
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
  }
]
