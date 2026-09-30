import { describe, it, expect } from 'vitest'
import { isShellCommandAllowed } from '@electron/shell-security'

/**
 * shell 白名单行为测试（2026-09-30）
 *
 * 背景：`electron/shell-security.ts:4-16` 的 `SHELL_ALLOWED_COMMANDS` 是安全边界，而
 * `src/services/l0SkillRouter.ts` 的 L0 规则 2「快速 Shell 命令」会直接产 `shell_exec` 计划。
 * 两者若不一致，L0 就会产出**必被拒绝的计划**（exit -1）——本轮已据此移除了 `mv|move|rm|del`
 * 触发词。本文件把白名单的**实际放行面**钉住（此前无任何测试覆盖该函数），
 * 供后续判断「L0 的触发词是否又跑到白名单外」时对照。
 *
 * 结论（2026-09-30 实测，见下方断言）：
 * - 放行：`npm install` / `pip install` / `dir` / `ls` / `cat` / `echo` / `type` / `mkdir` / `copy` / `cp` / `cd` / `pwd`
 * - 拒绝：`git` / `python` / `node`（非 `node -e`）/ `npx` / `npm run` / `mv` / `move` / `del` / `rm`
 */
describe('shell 白名单：实际放行面（安全边界）', () => {
  it('白名单内命令放行', () => {
    for (const c of ['npm install lodash', 'pip install requests', 'ls -la', 'mkdir testdir', 'copy a.txt b.txt', 'pwd']) {
      expect(isShellCommandAllowed(c).allowed, c).toBe(true)
    }
  })

  it('白名单外命令拒绝（含 L0 规则 2 触发词里那几个）', () => {
    for (const c of ['git status', 'python train.py', 'node script.js', 'mv a.txt b.txt', 'del a.txt', 'npx foo']) {
      expect(isShellCommandAllowed(c).allowed, c).toBe(false)
    }
  })

  it('`node -e` 受限模式放行，但裸 `node` 脚本被拒', () => {
    expect(isShellCommandAllowed('node -e "console.log(1)"').allowed).toBe(true)
    expect(isShellCommandAllowed('node script.js').allowed).toBe(false)
  })

  it('`npm run` 已移出白名单（package.json scripts 可被伪造实现任意执行）', () => {
    expect(isShellCommandAllowed('npm run build').allowed).toBe(false)
    expect(isShellCommandAllowed('npm install lodash').allowed).toBe(true)
  })

  it('shell 元字符一律拒绝（即使命令本身在白名单内）', () => {
    expect(isShellCommandAllowed('ls -la && whoami').allowed).toBe(false)
    expect(isShellCommandAllowed('ls %USERPROFILE%').allowed).toBe(false)
  })
})
