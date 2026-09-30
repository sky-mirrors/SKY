import { describe, it, expect } from 'vitest'
import { extractOutputDir, buildOutputPath } from '@/services/l0SkillRouter'

// ─────────────────────────────────────────────────────────────────────────────
// 产物输出位置（2026-09-30）
//
// 根因（docs/exam-reports/2026-09-30-v2-failure-attribution.md 的「归因修正」节）：
// `l0SkillRouter.ts` 原实现是
//     const baseName = src.replace(/\.\w{1,5}$/, '')
//     const outputPath = `${baseName}.${effectiveTarget}`
// 即产物**必然落在源文件同目录**，用户说的「存到 out 下」从未进入计算。
// 实测 V2-R01：题干写明「存到 ...\HoloExam\out 下」，产物仍落到 ...\HoloExam\docs\notes.docx。
//
// 注意这是**路由层参数计算**问题，不是提示词问题——模型不参与决定该路径，
// 所以 fileTaskSystemPrompt 里加约束对它无效（已实测）。
// ─────────────────────────────────────────────────────────────────────────────

describe('extractOutputDir · 从用户输入解析输出目录', () => {
  const OUT = 'C:\\Users\\Administrator\\Desktop\\HoloExam\\out'
  const SRC = 'C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.md'

  it('识别「存到 <绝对路径> 下」（V2-R01 的真实形态）', () => {
    expect(extractOutputDir(`把 ${SRC} 转成 docx，存到 ${OUT} 下`)).toBe(OUT)
  })

  it('识别保存到 / 放到 / 输出到 / 导出到 等同义说法', () => {
    expect(extractOutputDir('把 a.md 转成 pdf，保存到 C:\\tmp\\o')).toBe('C:\\tmp\\o')
    expect(extractOutputDir('转换完放到 C:\\tmp\\p 里')).toBe('C:\\tmp\\p')
    expect(extractOutputDir('输出到 D:\\work\\out')).toBe('D:\\work\\out')
    expect(extractOutputDir('导到 E:\\x\\y\\z 文件夹')).toBe('E:\\x\\y\\z')
  })

  it('没指定输出目录时返回 null（不得瞎猜）', () => {
    expect(extractOutputDir(`把 ${SRC} 转成 docx`)).toBeNull()
    expect(extractOutputDir('把 a.md 转成 pdf')).toBeNull()
    expect(extractOutputDir('')).toBeNull()
  })

  it('不把源文件路径误当成输出目录（它前面没有「存到」类动词）', () => {
    expect(extractOutputDir(`把 ${SRC} 转成 docx`)).toBeNull()
    expect(extractOutputDir('读取 C:\\a\\src.md 并总结一下')).toBeNull()
  })
})

describe('buildOutputPath · 产物绝对路径组装', () => {
  const SRC = 'C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.md'
  const OUT = 'C:\\Users\\Administrator\\Desktop\\HoloExam\\out'

  it('用户指定了目录 → 产物落该目录，文件名沿用源文件主干', () => {
    expect(buildOutputPath(SRC, 'docx', `把 ${SRC} 转成 docx，存到 ${OUT} 下`))
      .toBe(`${OUT}\\notes.docx`)
  })

  it('未指定目录 → 退回源文件同目录（保持既有行为，不得回归）', () => {
    expect(buildOutputPath(SRC, 'docx', `把 ${SRC} 转成 docx`)).toBe('C:\\Users\\Administrator\\Desktop\\HoloExam\\docs\\notes.docx')
  })

  it('扩展名由调用方决定，不写死', () => {
    expect(buildOutputPath(SRC, 'pdf', `把 ${SRC} 转成 pdf，存到 ${OUT} 下`)).toBe(`${OUT}\\notes.pdf`)
    expect(buildOutputPath(SRC, 'csv', `存到 ${OUT} 吧`)).toBe(`${OUT}\\notes.csv`)
  })
})
