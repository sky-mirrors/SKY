import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// 直接读源文件而非导入常量：`FIXED_SYSTEM_PROMPT` 未导出，且 dialogStore 在多个 spec 里被 mock，
// 新增导出会让测试里该导出为 undefined（HANDOFF 记录的 8 条失败教训）。
const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')

// 2026-09-23 实测两个失分点，均落在 system prompt 的覆盖盲区上：
//  ① Q15「图片按日期重命名」回复"我无法直接访问你电脑上的本地路径"——而 app 实际具备
//     read_file/list_directory/file_write（nativeTools.ts 常驻注入），但原第 1 条只声明了
//     "MCP 工具和 shell_exec"，模型不知道自己有文件工具。
//  ② Q2/Q4 内容合格却在成文里留下 [姓名]/[日期范围] 占位符，判卷以"不能直接交付"否决；
//     原 13 条规则里没有任何"不留占位符"约束，模型按商务邮件惯例自行补全。
describe('system prompt 交付质量约束', () => {
  it('声明原生文件工具，堵住"无法访问本地路径"的推脱', () => {
    expect(src).toContain('read_file')
    expect(src).toContain('list_directory')
    expect(src).toContain('file_write')
    expect(src).toContain('绝不许以')
    expect(src).toContain('无法访问你电脑上的本地路径')
  })

  it('遇到阻碍必须先尝试工具，不得凭猜测声称没权限', () => {
    expect(src).toContain('必须先实际尝试对应工具')
  })

  it('禁止把占位符留在成文里交付（Q2/Q4 的直接成因）', () => {
    expect(src).toContain('不留占位符')
    expect(src).toContain('待补充')
    expect(src).toContain('宁可缺一行署名，也不得留下占位符')
  })
})
