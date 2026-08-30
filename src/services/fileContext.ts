import { debugLog } from '@/services/debugLog'
interface FileContext {
  activeFileExt: string | null
  activeFileName: string | null
  boostKeywords: string[]
  boostWeight: number
}

const FILE_TYPE_BOOST_MAP: Record<string, { keywords: string[]; weight: number }> = {
  '.pdf': { keywords: ['文档', '审查', '合同', '风险', '合规', 'report', 'review'], weight: 0.15 },
  '.docx': { keywords: ['文档', '报告', '合同', '生成', 'word'], weight: 0.15 },
  '.doc': { keywords: ['文档', '报告', '合同', '生成', 'word'], weight: 0.15 },
  '.xlsx': { keywords: ['表格', '数据', '汇总', '财务', 'excel', '统计'], weight: 0.15 },
  '.xls': { keywords: ['表格', '数据', '汇总', '财务', 'excel', '统计'], weight: 0.15 },
  '.csv': { keywords: ['数据', '表格', '汇总', '分析', 'csv'], weight: 0.15 },
  '.pptx': { keywords: ['演示', '幻灯片', 'ppt', '汇报'], weight: 0.12 },
  '.md': { keywords: ['文档', '笔记', 'markdown', '总结'], weight: 0.10 },
  '.txt': { keywords: ['文本', '文件', '读取', '编辑'], weight: 0.08 },
  '.json': { keywords: ['数据', '配置', 'json', '解析'], weight: 0.10 },
  '.py': { keywords: ['代码', 'python', '脚本', '程序'], weight: 0.12 },
  '.js': { keywords: ['代码', 'javascript', '脚本', '程序'], weight: 0.12 },
  '.ts': { keywords: ['代码', 'typescript', '脚本', '程序'], weight: 0.12 },
  '.html': { keywords: ['网页', 'html', '前端', '代码'], weight: 0.10 },
  '.css': { keywords: ['样式', 'css', '前端', '设计'], weight: 0.10 },
}

let _currentFile: FileContext = {
  activeFileExt: null,
  activeFileName: null,
  boostKeywords: [],
  boostWeight: 0
}

let _unwatchFn: (() => void) | null = null

export function getFileContext(): FileContext {
  return { ..._currentFile }
}

export function getFileBoostForItem(itemKeywords: string[], itemDescription: string): number {
  if (!_currentFile.activeFileExt || _currentFile.boostKeywords.length === 0) return 0

  const descLower = itemDescription.toLowerCase()
  let hits = 0
  for (const kw of _currentFile.boostKeywords) {
    if (itemKeywords.some(ik => ik.toLowerCase().includes(kw) || kw.includes(ik.toLowerCase()))) {
      hits++
    } else if (descLower.includes(kw)) {
      hits++
    }
  }

  return hits > 0 ? _currentFile.boostWeight * Math.min(1, hits / 2) : 0
}

export function setActiveFile(fileName: string | null): void {
  if (!fileName) {
    _currentFile = { activeFileExt: null, activeFileName: null, boostKeywords: [], boostWeight: 0 }
    return
  }

  const ext = '.' + fileName.split('.').pop()?.toLowerCase()
  const boost = FILE_TYPE_BOOST_MAP[ext]
  if (boost) {
    _currentFile = {
      activeFileExt: ext,
      activeFileName: fileName,
      boostKeywords: boost.keywords,
      boostWeight: boost.weight
    }
    debugLog(`[FileContext] 激活: ${fileName} → boost +${boost.weight} for [${boost.keywords.join(', ')}]`)
  } else {
    _currentFile = { activeFileExt: ext, activeFileName: fileName, boostKeywords: [], boostWeight: 0 }
  }
}

export async function initFileContextWatch(): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI?.onWatchfsChanged) return

  if (_unwatchFn) {
    _unwatchFn()
    _unwatchFn = null
  }

  _unwatchFn = window.electronAPI.onWatchfsChanged((data) => {
    if (data.filename) {
      setActiveFile(data.filename)
    }
  })

  try {
    const dir = await window.electronAPI.watchfsGetDir?.()
    if (dir) {
      debugLog(`[FileContext] 监听目录: ${dir}`)
    }
  } catch {
    // watchfsGetDir may not be available
  }
}

export function destroyFileContextWatch(): void {
  if (_unwatchFn) {
    _unwatchFn()
    _unwatchFn = null
  }
}
