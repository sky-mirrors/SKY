import { describe, it, expect } from 'vitest'
import { tryL0Skill } from '@/services/l0SkillRouter'

/**
 * 用户实测（2026-09-25）：发「把桌面上 HoloStarmap\docs 文件夹下的 2026.9.24最新快照.md 文件转为 docx
 * 文档，将这个 docx 文档放在桌面上」→ Holo 只回一句「我先确认文件是否存在。」再无下文。
 *
 * 取证（运行中 app 的消息流）：
 *   ⚡ L0 Skill直通：将 input.9 转换为 .docx（file域，3步L1执行）
 *   ✗ 步骤2失败（执行异常）: 文件不存在（路径：input.9）
 *   ⚠️ 计划执行失败，回退到直接回答模式...
 *
 * 根因两处（均在 l0SkillRouter.ts 的「文件格式转换」规则内）：
 *   ① `const src = filePath || \`input.${sourceExt || 'md'}\`` —— 拿不到真实路径时**伪造**一个
 *      占位符路径并照跑计划 ⇒ 必然「文件不存在」，把"没识别出路径"伪装成"计划执行失败"；
 *   ② `extractSourceExt` 用 `/\.(\w{1,5})\b/` 取**第一个**点段 ⇒ "2026.9.24最新快照.md" 解析出 `9`。
 */
describe('L0「文件格式转换」：拿不到真实路径时不得伪造路径', () => {
  const USER_INPUT =
    '把桌面上 HoloStarmap\\docs 文件夹下的 2026.9.24最新快照.md 文件转为 docx 文档，将这个 docx 文档放在桌面上。'

  it('描述性路径（非绝对路径）→ 计划里不得出现 input.<ext> 这种伪路径', async () => {
    const plan = await tryL0Skill(USER_INPUT)
    expect(JSON.stringify(plan)).not.toMatch(/input\.[\w]{1,5}/)
  })

  it('带点号的日期文件名不得被解析成扩展名 9', async () => {
    const plan = await tryL0Skill(USER_INPUT)
    expect(JSON.stringify(plan)).not.toContain('input.9')
  })

  it('给出真实绝对路径时，路径原样进入计划（不回归）', async () => {
    const plan = await tryL0Skill('把 D:\\docs\\2026.9.24最新快照.md 转成 docx')
    expect(JSON.stringify(plan)).toContain('2026.9.24最新快照.md')
    expect(JSON.stringify(plan)).not.toMatch(/input\.[\w]{1,5}/)
  })
})
