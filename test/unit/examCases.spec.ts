import { describe, it, expect } from 'vitest'
import { EXAM_CASES, type ExamCategory } from '@/exam/examCases'

describe('EXAM-3 固定回归集 18 题（ACCEPTANCE-SPEC 命题表）', () => {
  it('共 18 题，id 唯一且为 Q1..Q18', () => {
    expect(EXAM_CASES).toHaveLength(18)
    const ids = EXAM_CASES.map(c => c.id)
    expect(new Set(ids).size).toBe(18)
    expect(ids).toEqual(Array.from({ length: 18 }, (_, i) => `Q${i + 1}`))
  })

  it('类别分布：文档 5 / 数据 4 / 信息 4 / 文件 5', () => {
    const count = (cat: ExamCategory): number => EXAM_CASES.filter(c => c.category === cat).length
    expect(count('doc')).toBe(5)
    expect(count('data')).toBe(4)
    expect(count('info')).toBe(4)
    expect(count('file')).toBe(5)
  })

  it('每题 prompt/judgeHint 非空，prompt 长度受控', () => {
    for (const c of EXAM_CASES) {
      expect(c.prompt.trim().length).toBeGreaterThan(10)
      expect(c.prompt.length).toBeLessThan(8000)
      expect(c.judgeHint.trim().length).toBeGreaterThan(5)
    }
  })

  it('素材依赖题恰为 Q3/Q15/Q16/Q18（HoloExam 目录）', () => {
    const fixtureIds = EXAM_CASES.filter(c => c.requiresFixture).map(c => c.id)
    expect(fixtureIds).toEqual(['Q3', 'Q15', 'Q16', 'Q18'])
  })

  it('number 断言期望值为有限数；Q17 承 benchmark 原题 1234×5678=7006652', () => {
    for (const c of EXAM_CASES) {
      for (const a of c.assertions) {
        if (a.kind === 'number') {
          expect(Number.isFinite(a.expected)).toBe(true)
          expect(a.tolerance === undefined || a.tolerance >= 0).toBe(true)
        }
      }
    }
    const q17 = EXAM_CASES.find(c => c.id === 'Q17')
    expect(q17).toBeDefined()
    const num = q17!.assertions.find(a => a.kind === 'number')
    expect(num).toMatchObject({ kind: 'number', expected: 7006652 })
  })

  it('长文档题（Q9 合同/Q11 财报）材料内嵌且够长（考长文档 + FactGuard）', () => {
    const q9 = EXAM_CASES.find(c => c.id === 'Q9')!
    const q11 = EXAM_CASES.find(c => c.id === 'Q11')!
    expect(q9.prompt.length).toBeGreaterThan(1500)
    expect(q9.prompt).toContain('0.5‰')
    expect(q11.prompt.length).toBeGreaterThan(600)
    expect(q11.prompt).toContain('52,610')
  })

  // 2026-09-25（C）：Q15 判词口径与素材自洽——4 张考题图无 EXIF（坑 22），用户已裁定
  // 「无 EXIF 时以文件系统时间为拍摄日期」（macroExecutor.ts:575-576 记载）。判卷员此前因
  // 模型如实说明「取自文件系统时间」而判 not-deliverable（roundD 实测），本条守住该口径不再回退。
  it('Q15 judgeHint 与素材自洽：无 EXIF 时以文件系统时间为拍摄日期即视为完成', () => {
    const q15 = EXAM_CASES.find(c => c.id === 'Q15')!
    expect(q15.judgeHint).toContain('无 EXIF')
    expect(q15.judgeHint).toContain('文件系统时间为拍摄日期')
  })
})
