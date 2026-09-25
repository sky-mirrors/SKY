/**
 * 从「清单类步骤」（list_directory）的结果里挑出可读的目标文件名——纯函数、零依赖叶子模块。
 *
 * 2026-09-25 修①（离线复现坐实）：`list_directory` 每行是
 *   `文件名\t拍摄日期=YYYYMMDD（来源） [iso]`
 * （见 macroExecutor 的 list_directory 实现）。原先 macroExecutor 与 dialogStore **各抄一份**
 * 挑选逻辑，两份都把**整行**当文件名返回——扩展名剥离正则 `/\.\w{1,5}$/` 只认行尾、而行尾是 `]`
 * ⇒ 不匹配 ⇒ 返回整行 ⇒ 拼出的路径带 `\t拍摄日期=…` 垃圾 ⇒ `read_file` 必被安全策略拒
 * （实测报 `…\快照-九批.doc`）⇒ 计划中断 ⇒ 回退。凡「先列目录再读一份」的计划
 * （文件检索探索计划、l2-weekly-report-draft-v1）都撞这条。
 *
 * 抽成叶子模块的理由：① 消灭两处重复（同错源）；② 供 dialogStore 直接静态 import——
 * 早先把共享函数挂在 macroExecutor 上时，测试里 `vi.mock('@/services/macroExecutor')` 的 mock
 * 不含该导出，dialogStore 一取就抛「No export is defined on the mock」（funnelMainPath 8 例红）。
 */

/** 读得出文本的扩展名。本函数产物是给 `read_file` 的**路径**，二进制（docx/pdf/zip/图片）读不出内容。 */
const TEXT_READABLE_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'html', 'htm', 'xml',
  'yaml', 'yml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'cmd', 'ps1', 'sql', 'env', 'toml'
])

/** 清单行 → 裸文件名：剥掉 `\t` 之后的元数据（`拍摄日期=…（来源） [iso]`） */
export function bareNameFromListing(line: string): string {
  return line.split('\t')[0].trim()
}

/**
 * 从清单结果里挑出与用户输入最匹配、且**文本可读**的文件名。
 * 无可读文件时返回 **空串** —— 调用方据此跳过该步，而不是拿一个必败的路径去 read_file。
 */
export function pickTopFileFromListing(stepResult: string, userText: string): string {
  const names = stepResult
    .split(/\r?\n/)
    .map(s => s.trim().replace(/^[-*•]\s*/, ''))
    .map(bareNameFromListing)
    .filter(s => s.length > 0 && !s.startsWith('(') && !s.startsWith('【') && !/[\\/]$/.test(s))
  if (names.length === 0) return ''

  const readable = names.filter(n => {
    const ext = (n.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1]
    return !!ext && TEXT_READABLE_EXTS.has(ext.toLowerCase())
  })
  if (readable.length === 0) return ''

  const longestCommon = (a: string, b: string): number => {
    let best = 0
    for (let i = 0; i < a.length; i++) {
      for (let len = best + 1; i + len <= a.length; len++) {
        if (b.includes(a.substring(i, i + len))) best = len
        else break
      }
    }
    return best
  }

  let best = ''
  let bestScore = 0
  for (const n of readable) {
    const base = n.replace(/\.\w{1,5}$/, '')
    const score = longestCommon(base, userText)
    if (score > bestScore) { bestScore = score; best = n }
  }
  return bestScore >= 2 ? best : readable[0]
}
