// 原生工具的 ToolDef 类型（与 dialogStore 内部 ToolDef 结构一致）。
// 单独成文件，让 nativeTools.ts 可被纯单测导入而不牵扯 dialogStore 的大量依赖。
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}
