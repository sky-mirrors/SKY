import { describe, it, expect } from 'vitest'
import { isArchiveName, archiveStem, planUnzip, SUPPORTED_ARCHIVE_EXTS } from '@electron/fileUnzip'

// ─────────────────────────────────────────────────────────────────────────────
// 「解压并归类」的**纯计划核心**（2026-10-08）—— CI-05 缺口（「把桌面的 zip 都解压，然后放进一个新建的文件夹里」）。
//
// 语义选型（与系统解压工具的默认约定一致，且刻意如此——避免多个压缩包内容混在一起）：
//   **每个压缩包解成一个同名子目录**（`<目标>\<压缩包名>\`），而不是把 N 个包的内容摊平到同一个目录。
//   目标子目录已存在 ⇒ 该包跳过并上报（绝不向既有目录里覆盖式解压）。
//
// 支持面刻意只有 .zip：extract-zip 只认 zip；.rar/.7z 等**如实报告不支持**，不假装解压过。
// ─────────────────────────────────────────────────────────────────────────────

describe('压缩包识别与命名', () => {
  it('只认 .zip（含大小写）；.rar/.7z 不在支持面里（不假装能解）', () => {
    expect(SUPPORTED_ARCHIVE_EXTS).toEqual(['zip'])
    expect(isArchiveName('a.zip')).toBe(true)
    expect(isArchiveName('A.ZIP')).toBe(true)
    expect(isArchiveName('a.rar')).toBe(false)
    expect(isArchiveName('a.7z')).toBe(false)
    expect(isArchiveName('a.txt')).toBe(false)
  })

  it('子目录名 = 去掉最后一个扩展名（多点文件名只去最后一段）', () => {
    expect(archiveStem('photos.zip')).toBe('photos')
    expect(archiveStem('2026.09.backup.zip')).toBe('2026.09.backup')
    expect(archiveStem('A.ZIP')).toBe('A')
  })

  it('仅以点开头（.zip）不算压缩包（与分拣算子同一条口径：点是开头不是扩展名）', () => {
    expect(isArchiveName('.zip')).toBe(false)
    expect(archiveStem('.zip')).toBe('')
  })
})

describe('planUnzip：压缩包 → 目标子目录', () => {
  it('按传入顺序逐个成目录，只挑压缩包、忽略其它文件', () => {
    const plan = planUnzip(['a.zip', 'note.txt', 'b.ZIP', 'dir'], 'D:\\out')
    expect(plan).toEqual([
      { archive: 'a.zip', dir: 'D:\\out\\a' },
      { archive: 'b.ZIP', dir: 'D:\\out\\b' }
    ])
  })

  it('空输入 → 空计划（不建任何目录）', () => {
    expect(planUnzip([], 'D:\\out')).toEqual([])
  })

  it('同名不同大小写的压缩包映射到同一目录（运行时按"目标已存在"跳过后者，保持确定性）', () => {
    const plan = planUnzip(['x.zip', 'x.ZIP'], 'D:\\out')
    expect(plan.map(p => p.dir)).toEqual(['D:\\out\\x', 'D:\\out\\x'])
  })
})
