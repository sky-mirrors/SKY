// P1-15/P1-17 修复：工具名词表与副作用分类的唯一定义点。
// 此前副作用工具集在 macroExecutor/scheduleOptimizer 共 5+ 处独立定义且互不一致
// （全部漏 create_docx → docx 结果被缓存复用但文件未实际创建）；计划生成器与
// 原生 dispatch 的工具命名也不一致（file_read/directory_tree vs read_file/list_directory），
// LLM 规划出的 DAG 一经执行必抛"无效工具名"。

// 原生可执行工具（callToolDirectWithTier 的 dispatch 分支）
export const NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'file_write',
  'create_directory',
  'create_docx',
  'shell_exec',
  'http_request',
  'llm_generate',
  'knowledge_search',
  'list_directory',
  'file_move',
  'file_convert'
])

// MCP 工具名形如 {serverId}___{toolName}
export function isMcpToolName(name: string): boolean {
  return name.includes('___')
}

// 产生外部副作用的工具：执行指纹须记录其步骤号，编译态缓存路径不得跳过重放
// （2026-09-24 补漏：file_move / file_convert 同样改外部世界，原先漏登记 →
//   同名步骤的结果可能被跨执行缓存复用，而文件其实没改名/没生成）
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'shell_exec',
  'file_write',
  'create_directory',
  'create_docx',
  'http_request',
  'file_move',
  'file_convert'
])

// 结果不可跨执行复用缓存的工具（副作用工具 + 结果取决于外部文件现状的 read_file）
export const NO_CACHE_REUSE_TOOLS: ReadonlySet<string> = new Set([
  ...SIDE_EFFECT_TOOLS,
  'read_file'
])

// 需要进入双引擎审计闸门的工具（与 dualEngineValidator.shouldValidate 的工具面保持一致）
export function needsDualEngineValidation(tool: string): boolean {
  return tool === 'shell_exec'
    || tool === 'file_write'
    || tool === 'http_request'
    || tool === 'read_file'
    || tool === 'create_directory'
    || tool === 'create_docx'
    || tool === 'list_directory'
    || isMcpToolName(tool)
}

// P1-17: 历史清单/翻译器种子使用的别名 → 原生规范名
const TOOL_NAME_ALIASES: Record<string, string> = {
  file_read: 'read_file',
  write_file: 'file_write',
  directory_tree: 'list_directory',
  search_knowledge: 'knowledge_search'
}

export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] || name
}
