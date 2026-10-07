import { describe, it, expect } from 'vitest'
import { sortFolderFor, planSortByType } from '@electron/fileSortByType'

// ─────────────────────────────────────────────────────────────────────────────
// 「按类型分拣」的**纯分类核心**（2026-10-08）
//
// 背景：CI-06（组合意图缺口登记册）——「把桌面上的文件按类型分好类，每类一个文件夹」。
// 静态计划表达不了「一个动作产出多个目录并按类型分派」（create_directory / file_move 都只支持单目标），
// 故缺的是**算子**：一个批量操作读目录、按类别建子目录、把文件搬进去（与 rename_images_by_date 同型的批处理算子）。
//
// 本文件只钉**纯函数**：类别判定 + 分拣计划。IPC/主进程的文件搬动另行端到端验证（临时目录）。
// 为什么类别表放在 electron/ 而不是 src/data：主进程与渲染进程都要用，
// 依本项目既有约定（electron/pathExpansion.ts 先例）——跨层共享的零依赖叶子逻辑放 electron/。
// ─────────────────────────────────────────────────────────────────────────────

describe('sortFolderFor：文件 → 类别目录名', () => {
  it('按类型分词源归并（图片类不拆成 jpg/png 两个目录）', () => {
    expect(sortFolderFor('IMG_0001.JPG')).toBe('图片')
    expect(sortFolderFor('shot.png')).toBe('图片')
    expect(sortFolderFor('clip.mp4')).toBe('音视频')
    expect(sortFolderFor('song.MP3')).toBe('音视频')
    expect(sortFolderFor('pack.zip')).toBe('压缩包')
    expect(sortFolderFor('sheet.xlsx')).toBe('表格')
    expect(sortFolderFor('deck.pptx')).toBe('幻灯片')
    expect(sortFolderFor('paper.pdf')).toBe('PDF')
    expect(sortFolderFor('note.md')).toBe('文本')
    expect(sortFolderFor('report.docx')).toBe('文档')
  })

  it('未归并的扩展名按扩展名建目录（低一档但确定）', () => {
    expect(sortFolderFor('tool.exe')).toBe('exe')
    expect(sortFolderFor('data.bin')).toBe('bin')
    expect(sortFolderFor('main.ts')).toBe('代码')
  })

  it('无扩展名 / 仅以点开头的文件 → 「无扩展名」（.env 不是"env 类型"）', () => {
    expect(sortFolderFor('LICENSE')).toBe('无扩展名')
    expect(sortFolderFor('.env')).toBe('无扩展名')
    expect(sortFolderFor('.gitignore')).toBe('无扩展名')
  })
})

describe('planSortByType：分拣计划（确定性、可空跑）', () => {
  it('按类别归组，目录顺序稳定（同输入恒同输出）', () => {
    const names = ['a.jpg', 'b.png', 'c.zip', 'd.txt', 'noext', '.env', 'e.jpg']
    const plan = planSortByType(names)
    expect(plan.map(p => p.folder)).toEqual(['图片', '压缩包', '文本', '无扩展名'])
    expect(plan.find(p => p.folder === '图片')!.files).toEqual(['a.jpg', 'b.png', 'e.jpg'])
    expect(plan.find(p => p.folder === '无扩展名')!.files).toEqual(['noext', '.env'])
    expect(planSortByType(names)).toEqual(plan)
  })

  it('空输入 → 空计划（不建任何目录）', () => {
    expect(planSortByType([])).toEqual([])
  })

  it('同一类别的目录名不会重复出现', () => {
    const plan = planSortByType(['a.jpg', 'b.jpe', 'c.jfif', 'd.png'])
    const folders = plan.map(p => p.folder)
    expect(new Set(folders).size).toBe(folders.length)
  })
})
