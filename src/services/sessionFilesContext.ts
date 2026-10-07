/**
 * 会话文件清单上下文的边界标记与剥离工具（2026-10-07）。
 *
 * 背景：`dialogStore.sendMessage` 用 `withSessionFilesContext(content)` 给内容追加一段
 * 「本会话可用的知识库文件」清单，再喂给 funnel 路由（2026-10-01，为让模型能答「会话内有什么文件」）。
 * 但这份**追加上下文只该给模型看，不该给路由看**——路由按正则/关键词判定意图，被追加的文件名
 * （`.md`/`.docx` 等）污染会路由到错误的层。两处实测：
 *   - V2-T02：「培训通知」请求被 `buildExplorePlan` 判成「列 Desktop 下的 .md 文件清单」→ 跑起 list_directory。
 *   - V2-R15：追加的换行让 L0 shell 规则的正则整体不匹配 → shell 命令含换行被拒。
 *
 * 抽成叶子模块供 dialogStore（构造）与 l0SkillRouter（剥离）共用，避免标记字面量分叉漂移。
 */
export const SESSION_FILES_CONTEXT_MARKER =
  '【本会话可用的知识库文件（请直接依据此清单回答，不要反问目录）】'

/** 从「路由输入」里剥掉追加的会话文件清单，只保留用户原话（无标记时原样返回）。 */
export function stripSessionFilesContext(input: string): string {
  if (typeof input !== 'string') return input
  const i = input.indexOf(SESSION_FILES_CONTEXT_MARKER)
  if (i < 0) return input
  return input.slice(0, i).replace(/\s+$/, '')
}
