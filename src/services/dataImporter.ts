import type { ImportPreview } from '@/models'
import { parseImportPreview, applyImport } from '@/services/dataExporter'

export type { ImportPreview }

export function readImportFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

export async function importFromZip(file: File): Promise<ImportPreview | null> {
  const content = await readImportFile(file)
  return parseImportPreview(content)
}

export async function confirmImport(file: File, preview: ImportPreview): Promise<void> {
  const content = await readImportFile(file)
  // C-30：applyImport 是异步的必须 await——否则解析失败（预览与确认间文件被替换）
  // 的 rejection 不会被调用方捕获
  await applyImport(content, preview)
}
