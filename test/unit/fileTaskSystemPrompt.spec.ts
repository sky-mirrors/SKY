import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildNativeFileTaskSystemPrompt } from '@/services/fileTaskSystemPrompt'

/**
 * 文件类任务（mcp-direct）的 system 提示
 *
 * 取证：Q14/Q16 的 routeKind 都是 `mcp-direct`，而该分支的 api:chat-completion 载荷
 * **只有一条 user 消息、没有 system 消息**（dialogStore 三处 payload 均如此），
 * 于是模型不知道用户真实目录、只能猜——实测失败形态统一为「猜成 `C:\Users`
 * （漏掉用户名段）→ 被安全策略拒 → 放弃」（Q14 曾猜成 `C:\Users\Desktop`）。
 */
describe('文件类任务 system 提示：内容', () => {
  const PROFILE = 'C:\\Users\\Administrator'
  const DESKTOP = 'C:\\Users\\Administrator\\Desktop'

  it('把真实用户目录与桌面目录写进提示（这是治"猜路径"的关键）', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toContain(PROFILE)
    expect(p).toContain(DESKTOP)
  })

  it('明确禁止猜路径、禁止省略用户名段', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toContain('不要猜测')
    expect(p).toContain('用户名段')
  })

  it('声明四处常驻原生工具，堵住"我无法访问本地路径"的推脱', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    for (const t of ['read_file', 'list_directory', 'file_write', 'shell_exec']) {
      expect(p).toContain(t)
    }
    expect(p).toContain('绝不许')
  })

  it('失败时要求换路径重试，而不是重复同一条失败路径', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toMatch(/换一个更合理的路径|再试一次/)
  })

  it('拿不到用户目录时退化为"先用 list_directory 确认"，不编造路径', () => {
    const p = buildNativeFileTaskSystemPrompt({})
    expect(p).toContain('%USERPROFILE%')
    expect(p).toContain('不要猜测')
    expect(p).not.toContain('Administrator')
  })

  it('尾部斜杠被归一（避免拼出双斜杠路径）', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: `${PROFILE}\\`, desktop: `${DESKTOP}\\/` })
    expect(p).toContain(DESKTOP)
    expect(p).not.toContain(`${DESKTOP}\\/`)
  })

  // 2026-09-25（其他继续修）：Q15 走 mcp-direct 时整题失败——模型用 shell_exec 重命名，
  // 而 SHELL_ALLOWED_COMMANDS 不含 ren/move/Move-Item（electron/ipc-handlers.ts:385-386），
  // 命令被拒、退出码 -1、0 文件改名（两轮实测）。根因是原提示的工具清单**漏了 file_move**。
  it('工具清单列出 file_move（否则模型不知道有重命名工具，只好用被拒的 shell）', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toContain('file_move')
  })

  it('明确禁止用 shell 重命名，并说明 shell 白名单不含 ren/move', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toContain('重命名')
    expect(p).toMatch(/ren|move|Move-Item/)
    expect(p).toContain('退出码 -1')
  })

  // 考试实测（trace）：模型坚持用 powershell/node -e 读 EXIF，被拒后仍反复重试、4 轮耗尽失败。
  // 而 list_directory 返回的「拍摄日期」本就是权威日期——必须直接堵住这个执念。
  it('堵住"用 shell 读 EXIF"的执念：声明 list_directory 的拍摄日期即权威', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP })
    expect(p).toContain('拍摄日期')
    expect(p).toContain('不要为了读 EXIF')
    expect(p).toContain('list_directory')
  })

  it('omitShell=true 时不向模型提供 shell_exec（文件类直调路径）', () => {
    const p = buildNativeFileTaskSystemPrompt({ userProfile: PROFILE, desktop: DESKTOP, omitShell: true })
    expect(p).not.toContain('shell_exec（执行命令）')
    expect(p).toContain('不提供 shell_exec')
    expect(p).toContain('file_move')
  })
})

describe('文件类任务提示：全路径走查（三处 payload 都要带）', () => {
  const src = readFileSync(join(process.cwd(), 'src/stores/dialogStore.ts'), 'utf-8')
  // 只取 mcp-direct 分支那一段，避免把其他分支的裸 user 消息算进来
  const mStart = src.indexOf("outcome.kind === 'mcp-direct'")
  const mEnd = src.indexOf("// ===== kind === 'plan'", mStart)
  const branch = src.slice(mStart, mEnd === -1 ? src.length : mEnd)

  it('mcp-direct 分支确实用上了 buildNativeFileTaskSystemPrompt', () => {
    expect(branch).toContain('buildNativeFileTaskSystemPrompt')
    expect(branch).toContain('fileTaskSystemPrompt')
  })

  it('该分支不再残留裸 messages: [{ role: "user" … }]（三处 payload 都要前置 system）', () => {
    expect(branch).not.toMatch(/messages:\s*\[\s*\{\s*role:\s*'user'/)
  })

  it('三处 payload 都带上了 system 消息', () => {
    const sysUses = branch.match(/role:\s*'system'/g) || []
    expect(sysUses.length).toBe(3)
  })

  it('写类工具匹配时剔除 shell_exec（Q15：弱模型反复重试被拒的 shell）', () => {
    expect(branch).toContain('isWriteTool(matched.name)')
    expect(branch).toMatch(/t\.name === 'shell_exec'/)
    expect(branch).toContain('omitShell')
  })
})
