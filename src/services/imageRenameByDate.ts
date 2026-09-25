/**
 * 图片按拍摄日期重命名——**执行层确定性化**（2026-09-25，HANDOFF 下一步 5）。
 *
 * 背景：Q15「把某文件夹的图片按拍摄日期重命名」长期失败。已用 trace 插桩坐实——
 * 请求里工具齐备、system 也写明了重命名规则，但本地弱模型（qwen2.5:3b）在自由工具回路里
 * 只反复 list_directory，收口时**编造**「用 shell、退出码 -1」；提示词侧改了四条仍无效。
 * 结论：真解法是把「列目录（带拍摄日期）→ 按 YYYYMMDD-序号 重命名」做成**确定性能力**，
 * 由工具一次调用跑完，不把正确动作押在弱模型的自由回路上。
 *
 * 日期口径（与产品裁定一致）：优先 EXIF 拍摄时间，无 EXIF 时取文件系统时间；
 * 来源在返回文案里如实标注，便于上游/判卷不必猜。
 */

export type DateSource = 'EXIF' | '文件系统时间' | '未知'

export interface ImageEntryMeta {
  name: string
  isDir: boolean
  mtimeMs: number
  mtimeIso: string | null
  shootDateIso?: string | null
  shootDateTag?: string | null
}

export interface RenamePlanItem {
  /** 原文件名（不含目录） */
  from: string
  /** 新文件名（不含目录）：YYYYMMDD-NN.ext */
  to: string
  /** 日期戳 YYYYMMDD，或 '未知日期' */
  stamp: string
  /** 同日序号（从 1 起） */
  seq: number
  dateSource: DateSource
}

export interface RenameResult {
  dir: string
  renamed: { from: string; to: string; dateSource: DateSource }[]
  failures: { from: string; error: string }[]
}

export interface RenameImagesDeps {
  fileList?: (dir: string) => Promise<{ success: boolean; entries?: string[]; entriesWithMeta?: ImageEntryMeta[]; error?: string }>
  fileMove?: (o: { from: string; to: string }) => Promise<{ success: boolean; from?: string; to?: string; error?: string }>
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'svg']

export function isImageName(name: string): boolean {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  return !!m && IMAGE_EXTS.includes(m[1].toLowerCase())
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  return m ? m[1].toLowerCase() : 'jpg'
}

function fmt(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 单条条目的日期戳与来源（EXIF 优先，退回文件系统时间） */
export function dateStampOf(e: ImageEntryMeta): { stamp: string; dateSource: DateSource } {
  const exif = typeof e.shootDateIso === 'string' && e.shootDateIso ? e.shootDateIso : null
  const raw = exif ?? (e.mtimeIso || null)
  if (raw) {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return { stamp: fmt(d), dateSource: exif ? 'EXIF' : '文件系统时间' }
  }
  if (Number.isFinite(e.mtimeMs)) {
    const d = new Date(e.mtimeMs)
    if (!Number.isNaN(d.getTime())) return { stamp: fmt(d), dateSource: '文件系统时间' }
  }
  return { stamp: '未知日期', dateSource: '未知' }
}

/**
 * 由目录条目算出确定性重命名计划：只取图片（忽略子目录/非图片），
 * 日期升序、同日按原文件名升序、序号自 01 起（两位补零）。
 * 纯函数——这是"确定性"的落点，不依赖任何模型。
 */
export function planImageRenames(entries: ImageEntryMeta[]): RenamePlanItem[] {
  const dated = entries
    .filter(e => !e.isDir && isImageName(e.name))
    .map(e => ({ e, ...dateStampOf(e) }))

  dated.sort((a, b) => {
    if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1
    return a.e.name.localeCompare(b.e.name)
  })

  const perDay: Record<string, number> = {}
  return dated.map(({ e, stamp, dateSource }) => {
    perDay[stamp] = (perDay[stamp] || 0) + 1
    const seq = perDay[stamp]
    return {
      from: e.name,
      to: `${stamp}-${String(seq).padStart(2, '0')}.${extOf(e.name)}`,
      stamp,
      seq,
      dateSource
    }
  })
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

function resolveDeps(deps?: RenameImagesDeps): Required<RenameImagesDeps> {
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as unknown as RenameImagesDeps | undefined
  const fileList = deps?.fileList ?? api?.fileList
  const fileMove = deps?.fileMove ?? api?.fileMove
  if (!fileList) throw new Error('rename_images_by_date: fileList not available')
  if (!fileMove) throw new Error('rename_images_by_date: fileMove not available')
  return { fileList, fileMove }
}

/**
 * 列出目录 → 计算计划 → 逐个移动。一次调用完成整批重命名（不经模型逐文件决策）。
 * 返回 旧名→新名 清单与失败项；列目录失败如实抛错（绝不假装完成）。
 */
export async function renameImagesByDate(dir: string, deps?: RenameImagesDeps): Promise<RenameResult> {
  const { fileList, fileMove } = resolveDeps(deps)
  const listed = await fileList(dir)
  if (!listed?.success) throw new Error(`rename_images_by_date: 列目录失败: ${listed?.error || dir}`)

  const plan = planImageRenames(listed.entriesWithMeta || [])
  const renamed: RenameResult['renamed'] = []
  const failures: RenameResult['failures'] = []

  for (const item of plan) {
    const from = joinPath(dir, item.from)
    const to = joinPath(dir, item.to)
    if (from === to) {
      renamed.push({ from: item.from, to: item.to, dateSource: item.dateSource })
      continue
    }
    try {
      const r = await fileMove({ from, to })
      if (r?.success) renamed.push({ from: item.from, to: item.to, dateSource: item.dateSource })
      else failures.push({ from: item.from, error: r?.error || 'move failed' })
    } catch (err) {
      failures.push({ from: item.from, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { dir, renamed, failures }
}

/** 把结果渲染成给模型/用户的**如实**汇报文案 */
export function summarizeRename(r: RenameResult): string {
  if (r.renamed.length === 0 && r.failures.length === 0) return `目录中没有可重命名的图片: ${r.dir}`
  const srcs = [...new Set(r.renamed.map(x => x.dateSource))].join('/')
  const lines = r.renamed.map(x => `${x.from} → ${x.to}`)
  const head = `已按拍摄日期重命名 ${r.renamed.length} 张图片（${r.dir}，日期来源：${srcs || '无'}）`
  const fail = r.failures.length > 0
    ? `\n失败 ${r.failures.length} 个：${r.failures.map(f => `${f.from}（${f.error}）`).join('；')}`
    : ''
  return `${head}：\n${lines.join('\n')}${fail}`
}
