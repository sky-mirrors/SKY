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
})
