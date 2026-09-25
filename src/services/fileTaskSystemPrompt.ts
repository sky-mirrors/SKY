/**
 * 文件类任务的 system 提示（funnel `mcp-direct` 路径）
 *
 * 取证（`exam-report.json` 六轮 + `q2-probe` 同款探针）：
 *   - Q14「桌面 .docx 清单」与 Q16「查张三报销单」的 `routeKind` 都是 `mcp-direct`，
 *     即走 `dialogStore.consumeFunnelOutcome` 的 `matched` 分支。
 *   - 该分支的 `api:chat-completion` 载荷**只有一条 user 消息、没有任何 system 消息**
 *     （`dialogStore.ts` 三处 payload 均如此），而 app 恰恰有一条专门说明
 *     「所有需要输出的文件，默认保存到用户桌面（%USERPROFILE%\Desktop\）」的 system
 *     prompt——它只用在主对话通道（`dialogStore.FIXED_SYSTEM_PROMPT`）。
 *   - 后果：模型不知道用户的真实目录，只能猜。实测失败形态统一为
 *     「把路径猜成 `C:\Users`（漏掉用户名段 `Administrator`）→ 被安全策略拒绝 → 放弃」
 *     （Q14 曾猜成 `C:\Users\Desktop`）。猜对猜错随采样波动 ⇒ 这两题在轮次间来回抖。
 *
 * 本提示只解决"路径与工具能力可见性"，不改工具的权限模型（安全策略照旧拒绝越界路径）。
 */
export function buildNativeFileTaskSystemPrompt(opts: { userProfile?: string; desktop?: string }): string {
  const profile = (opts.userProfile || '').trim().replace(/[\\/]+$/, '')
  const desktop = (opts.desktop || (profile ? `${profile}\\Desktop` : '')).trim().replace(/[\\/]+$/, '')

  const lines: string[] = [
    '你是 HoloStarmap 全息星图助手，一个拥有真实工具能力的 AI。',
    '',
    '【工具】以下原生工具【始终可用】：read_file（读文件）、list_directory（列目录）、file_write（写文件）、shell_exec（执行命令）。涉及本机文件的操作【必须】调用它们实际执行，绝不许以"我无法访问你电脑上的本地路径"为由推脱，也绝不许编造结果。'
  ]

  if (profile && desktop) {
    lines.push(
      '',
      `【路径】当前用户的 Windows 用户目录是 \`${profile}\`，桌面目录是 \`${desktop}\`。` +
      '用户说"桌面/我的桌面/桌面上"时就用上面这个绝对路径——**不要猜测路径、不要省略其中的用户名段**。' +
      '若不确定某个路径是否存在，先用 list_directory 确认再决定下一步，不要凭猜测下结论。'
    )
  } else {
    lines.push(
      '',
      '【路径】需要用户桌面路径时，先用 list_directory 列出 `%USERPROFILE%\\Desktop` 的真实内容确认，**不要猜测路径、不要省略其中的用户名段**。'
    )
  }

  lines.push(
    '',
    '【汇报】调用工具后必须按**真实返回**汇报：成功了就说清楚产物/结果（文件名、所在目录、金额等）；失败了就如实说明失败原因与已尝试的路径，并换一个更合理的路径再试一次，不要反复重试同一条失败路径。'
  )

  return lines.join('\n')
}
