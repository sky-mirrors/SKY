import { describe, it, expect, vi } from 'vitest'
import { runFunnel, type LayerResult } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import { createDefaultLayers, type DefaultKernelContext } from '@/kernels/default'
import l2Manifests from '@/data/l2Manifests'

/**
 * L0 用户级验收（2026-09-30）：真实漏斗下发「移动/重命名」指令。
 *
 * 验的是用户可见行为：输入一句话 → 漏斗停在 **L0 规则直通层**（零检索、零 LLM 路由）
 * → 计划步骤挂 `file_move`。此前该意图在三层都无通道，只能靠模型自选（Q15 因此失败）。
 *
 * 不 mock `@/services/l0SkillRouter` —— 被测对象就是它。只桩掉 L0 之后各层的重依赖。
 */

vi.mock('@/kernel/plugins/llm', () => ({
  getLLM: () => ({ chatCompletion: vi.fn().mockResolvedValue({ content: 'DEFAULT' }) })
}))
vi.mock('@/services/toolRetrieval', () => ({
  buildToolIndex: vi.fn().mockResolvedValue([]),
  universalMatch: vi.fn().mockResolvedValue(null),
  getTop3CandidatesUniversal: vi.fn().mockReturnValue([]),
  llmFallback: vi.fn().mockResolvedValue(null),
  extractCoreKeywords: vi.fn().mockReturnValue([])
}))
vi.mock('@/services/promptTranslator', () => ({
  translateIntent: vi.fn().mockResolvedValue(null),
  planTask: vi.fn().mockResolvedValue({ intent: 'x', needs: [], steps: [] })
}))

function makeCtx(): DefaultKernelContext {
  return {
    allL2Manifests: l2Manifests,
    mcpTools: [],
    visibleL2Ids: [],
    lastAssistantContent: '',
    recentUserMsg: '',
    chatCompletion: vi.fn().mockResolvedValue({ content: '' })
  }
}

function route(input: string) {
  return runFunnel(
    { layers: createDefaultLayers(), hooks: new HookRunner<LayerResult>() },
    input,
    makeCtx()
  )
}

describe('L0 用户级验收：移动/重命名走 file_move 快车道', () => {
  it('「把 A 移到 B」→ 停在 L0，单步 file_move', async () => {
    const outcome = await route('把 C:\\Users\\x\\Desktop\\a.txt 移到 C:\\Users\\x\\Desktop\\b.txt')
    expect(outcome.kind).toBe('plan')
    expect(outcome.source).toBe('L0')
    if (outcome.kind === 'plan') {
      expect(outcome.plan.steps).toHaveLength(1)
      expect(outcome.plan.steps[0].tool).toBe('file_move')
      expect(outcome.plan.steps[0].params.from).toBe('C:\\Users\\x\\Desktop\\a.txt')
      expect(outcome.plan.steps[0].params.to).toBe('C:\\Users\\x\\Desktop\\b.txt')
    }
  })

  it('「把 A 重命名为 b.txt」→ 停在 L0，to 解析到源目录', async () => {
    const outcome = await route('把 C:\\Users\\x\\Desktop\\a.txt 重命名为 b.txt')
    expect(outcome.kind).toBe('plan')
    expect(outcome.source).toBe('L0')
    if (outcome.kind === 'plan') {
      expect(outcome.plan.steps[0].tool).toBe('file_move')
      expect(outcome.plan.steps[0].params.to).toBe('C:\\Users\\x\\Desktop\\b.txt')
    }
  })

  it('负例：「把这个文件移动一下」不产生假计划（下沉，不伪造路径）', async () => {
    const outcome = await route('把这个文件移动一下')
    const wentToMove = outcome.kind === 'plan' && outcome.source === 'L0'
      && outcome.plan.steps.some(s => s.tool === 'file_move')
    expect(wentToMove).toBe(false)
  })
})
