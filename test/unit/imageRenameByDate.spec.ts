import { describe, it, expect, vi } from 'vitest'
import { planImageRenames, isImageName, renameImagesByDate } from '@/services/imageRenameByDate'
import type { ImageEntryMeta } from '@/services/imageRenameByDate'
import { NATIVE_TOOL_DEFS, NATIVE_TOOL_NAMES } from '@/services/nativeTools'
import { tryL0Skill } from '@/services/l0SkillRouter'

/**
 * HANDOFF 卡点 1 / 下一步 5（2026-09-25）：Q15「图片按拍摄日期重命名」长期失败的真障碍是
 * 本地弱模型（qwen2.5:3b）在自由工具回路里不做正确动作——它只反复 list_directory 然后**编造**
 * 「用 shell、退出码 -1」。提示词侧改了四条仍无效。
 * 解法：**执行层确定性化**——把「列目录（带拍摄日期）→ 按 YYYYMMDD-序号 重命名」做成一个
 * 确定性工具（日期取 EXIF，无 EXIF 取文件系统时间），并加 L0 规则让该意图**不经模型**直接成计划。
 */

const ENTRY = (over: Partial<ImageEntryMeta> & { name: string }): ImageEntryMeta => ({
  isDir: false,
  mtimeMs: 0,
  mtimeIso: null,
  ...over
})

describe('planImageRenames —— 确定性重命名计划（纯函数）', () => {
  it('只认图片、忽略目录与非图片', () => {
    expect(isImageName('a.JPG')).toBe(true)
    expect(isImageName('a.png')).toBe(true)
    expect(isImageName('a.txt')).toBe(false)
    const plan = planImageRenames([
      ENTRY({ name: 'a.jpg', mtimeIso: '2026-03-15T12:00:00.000Z' }),
      ENTRY({ name: 'note.txt', mtimeIso: '2026-03-15T12:00:00.000Z' }),
      ENTRY({ name: 'sub', isDir: true, mtimeIso: '2026-03-15T12:00:00.000Z' })
    ])
    expect(plan.map(p => p.from)).toEqual(['a.jpg'])
  })

  it('同日按原文件名升序编号 01/02；跨天各自从 01；日期升序', () => {
    const plan = planImageRenames([
      ENTRY({ name: 'img1.jpg', mtimeIso: '2026-03-16T12:00:00.000Z' }),
      ENTRY({ name: 'img0.jpg', mtimeIso: '2026-03-15T12:00:00.000Z' }),
      ENTRY({ name: 'img2.jpg', mtimeIso: '2026-03-15T13:00:00.000Z' })
    ])
    expect(plan.map(p => `${p.from}→${p.to}`)).toEqual([
      'img0.jpg→20260315-01.jpg',
      'img2.jpg→20260315-02.jpg',
      'img1.jpg→20260316-01.jpg'
    ])
    expect(plan.map(p => p.dateSource)).toEqual(['文件系统时间', '文件系统时间', '文件系统时间'])
  })

  it('EXIF 拍摄时间优先于文件系统时间（来源如实标注）', () => {
    const plan = planImageRenames([
      ENTRY({
        name: 'exif.jpg',
        mtimeIso: '2026-01-01T12:00:00.000Z',
        shootDateIso: '2026-05-05T12:00:00.000Z',
        shootDateTag: 'DateTimeOriginal'
      })
    ])
    expect(plan[0].to).toBe('20260505-01.jpg')
    expect(plan[0].dateSource).toBe('EXIF')
  })

  it('mtimeIso 缺失时退回 mtimeMs；时间不可解析则标未知日期', () => {
    const plan = planImageRenames([
      ENTRY({ name: 'by-ms.jpg', mtimeMs: Date.parse('2026-07-07T12:00:00.000Z') }),
      ENTRY({ name: 'no-date.jpg', mtimeMs: NaN })
    ])
    expect(plan.find(p => p.from === 'by-ms.jpg')!.to).toBe('20260707-01.jpg')
    expect(plan.find(p => p.from === 'no-date.jpg')!.stamp).toBe('未知日期')
  })

  it('保留原扩展名（含大写归一）', () => {
    const plan = planImageRenames([ENTRY({ name: 'X.PNG', mtimeIso: '2026-03-15T12:00:00.000Z' })])
    expect(plan[0].to).toBe('20260315-01.png')
  })
})

describe('renameImagesByDate —— 执行器（列目录 + 逐个移动）', () => {
  it('按计划移动并返回 旧名→新名 清单', async () => {
    const calls: { from: string; to: string }[] = []
    const deps = {
      fileList: vi.fn(async () => ({
        success: true,
        entriesWithMeta: [
          ENTRY({ name: 'img1.jpg', mtimeIso: '2026-03-16T12:00:00.000Z' }),
          ENTRY({ name: 'img0.jpg', mtimeIso: '2026-03-15T12:00:00.000Z' }),
          ENTRY({ name: 'note.txt', mtimeIso: '2026-03-15T12:00:00.000Z' })
        ]
      })),
      fileMove: vi.fn(async ({ from, to }: { from: string; to: string }) => {
        calls.push({ from, to })
        return { success: true, from, to }
      })
    }
    const r = await renameImagesByDate('C:\\tmp\\photos', deps)
    expect(r.renamed.map(x => x.to)).toEqual(['20260315-01.jpg', '20260316-01.jpg'])
    expect(calls.map(c => c.to)).toEqual([
      'C:\\tmp\\photos\\20260315-01.jpg',
      'C:\\tmp\\photos\\20260316-01.jpg'
    ])
    expect(r.failures).toEqual([])
  })

  it('列目录失败时如实抛错（不假装完成）', async () => {
    const deps = {
      fileList: vi.fn(async () => ({ success: false, error: 'ENOENT' })),
      fileMove: vi.fn()
    }
    await expect(renameImagesByDate('C:\\nope', deps)).rejects.toThrow(/ENOENT|列目录|failed/i)
  })
})

describe('接线：工具已暴露 + L0 规则不经模型直通', () => {
  it('rename_images_by_date 是常驻原生工具且有定义', () => {
    expect([...NATIVE_TOOL_NAMES]).toContain('rename_images_by_date')
    expect(NATIVE_TOOL_DEFS.some(t => t.name === 'rename_images_by_date')).toBe(true)
  })

  it('Q15 原话命中 L0 规则，产出单步确定性计划（不经模型）', async () => {
    const prompt = '把 C:\\Users\\<user>\\Desktop\\HoloExam\\photos 文件夹里的图片按拍摄日期重命名，命名格式是 日期-序号.jpg（例如 20260315-01.jpg），同一天的按序号排。重命名完告诉我一共有几张图片、新文件名分别是什么。'
    const plan = await tryL0Skill(prompt)
    expect(plan).toBeTruthy()
    expect(plan!.steps).toHaveLength(1)
    expect(plan!.steps[0].tool).toBe('rename_images_by_date')
    expect(plan!.steps[0].params.dir).toBe('C:\\Users\\<user>\\Desktop\\HoloExam\\photos')
  })

  it('不劫持「转 docx」类请求（仍归文件格式转换）', async () => {
    const plan = await tryL0Skill('把 C:\\Users\\<user>\\Desktop\\a.md 转换为 docx')
    expect(plan?.intent ?? '').toContain('docx')
  })
})
