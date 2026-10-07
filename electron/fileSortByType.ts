/**
 * 「按类型分拣」的**纯分类核心**（2026-10-08）—— 与 rename_images_by_date 同型的批处理算子所需的判定层。
 *
 * 背景：CI-06（组合意图缺口登记册）登记的缺口——「把桌面上的文件按类型分好类，每类一个文件夹」。
 * 静态计划表达不了「一个动作产出多个目录并按类型分派」（create_directory / file_move 都只支持单目标），
 * 缺的是算子。本模块只做**纯判定**（类别目录名 + 分拣计划），实际的建目录/搬文件在
 * electron/ipc-handlers.ts 的 file:sortByType 里做（按 file:move 同款路径校验口径）。
 *
 * 为什么放在 electron/ 而不是 src/data：主进程与渲染层（计划文案）都要用同一张表，
 * 依本项目既有约定——跨层共享的零依赖叶子逻辑放 electron/（先例：electron/pathExpansion.ts）。
 *
 * 类别阶梯（刻意如此，不追求"全部穷举"）：
 *   ① 已知类型族归并（图片 / 音视频 / 文档 / 文本 / 表格 / 幻灯片 / PDF / 压缩包 / 代码）——
 *      「图片」不该被拆成 jpg/png 两个目录；
 *   ② 其余**按扩展名**建目录（.exe → exe、.bin → bin）——确定、可预期，不猜语义；
 *   ③ 无扩展名或仅以点开头（.env / .gitignore）→ 无扩展名。
 */

/** 类别表（数据）：值是该类别的扩展名集。键的顺序 = 判定优先级（同一扩展名不重复出现） */
const CATEGORY_BY_EXT: Record<string, string[]> = {
  图片: ['jpg', 'jpeg', 'jpe', 'jfif', 'jif', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'heic', 'heif', 'avif', 'svg'],
  音视频: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'aiff'],
  文档: ['doc', 'docx', 'odt', 'pages'],
  文本: ['txt', 'md', 'markdown', 'log', 'rtf', 'tex', 'srt', 'vtt', 'text'],
  表格: ['xlsx', 'xls', 'xlsm', 'csv', 'tsv', 'ods'],
  幻灯片: ['pptx', 'ppt', 'odp', 'key'],
  PDF: ['pdf'],
  压缩包: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  代码: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'ipynb']
}

/** 无扩展名归类名 */
export const NO_EXT_FOLDER = '无扩展名'

const EXT_TO_CATEGORY: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [folder, exts] of Object.entries(CATEGORY_BY_EXT)) {
    for (const e of exts) m.set(e, folder)
  }
  return m
})()

/** 取文件名的扩展名（小写、不含点）；无扩展名或仅以点开头 ⇒ '' */
export function extOf(fileName: string): string {
  const name = String(fileName || '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''          // 无点，或形如 .env / .gitignore（点在开头）
  return name.slice(dot + 1).toLowerCase()
}

/** 文件名 → 类别目录名 */
export function sortFolderFor(fileName: string): string {
  const ext = extOf(fileName)
  if (!ext) return NO_EXT_FOLDER
  return EXT_TO_CATEGORY.get(ext) || ext
}

export interface SortGroup {
  folder: string
  files: string[]
}

/**
 * 分拣计划：按**传入顺序**处理（目录顺序 = 类别首次出现的先后），只产出非空分组。
 * 纯函数：同输入恒同输出，不碰磁盘。
 */
export function planSortByType(names: string[]): SortGroup[] {
  const groups: SortGroup[] = []
  const index = new Map<string, SortGroup>()
  for (const raw of names || []) {
    const name = String(raw || '')
    if (!name) continue
    const folder = sortFolderFor(name)
    let g = index.get(folder)
    if (!g) {
      g = { folder, files: [] }
      index.set(folder, g)
      groups.push(g)
    }
    g.files.push(name)
  }
  return groups
}

/** 全部类别目录名（供 UI/文档展示；顺序 = 表声明顺序） */
export function knownSortFolders(): string[] {
  return [...Object.keys(CATEGORY_BY_EXT), NO_EXT_FOLDER]
}
