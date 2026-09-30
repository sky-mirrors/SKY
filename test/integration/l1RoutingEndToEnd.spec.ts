import { describe, it, expect, vi } from 'vitest'
import { runFunnel, type LayerResult } from '@/kernel/funnel'
import { HookRunner } from '@/kernel/hooks'
import { createDefaultLayers, type DefaultKernelContext } from '@/kernels/default'
import l2Manifests from '@/data/l2Manifests'

/**
 * L1 端到端验收（2026-09-30）：真实漏斗链路，**不 mock `@/services/l0SkillRouter`**。
 *
 * 与 `l1Routing.spec.ts`（单元：直接调 checkL1Capability）互补——本文件验证用户可见的
 * 端到端行为：输入一句话 → 漏斗在 **L1 层**停下并产出可执行计划（应用里即「🔧 L1 管道直通：
 * <能力名>」并直调），而不是穿透到 L2/L4。
 *
 * 只桩掉 L1 之后各层的重依赖（LLM / toolRetrieval / promptTranslator），
 * L0/L0.5/L1/L4 与 `createDefaultLayers` 全部走真实实现。
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

describe('L1 端到端验收：真实漏斗（createDefaultLayers，不 mock l0SkillRouter）', () => {
  const cases: Array<{ input: string; nodeId: string }> = [
    { input: '把这个需求拆解一下，给我执行步骤', nodeId: 'l1-task-translator' },
    { input: '把这段内容排版一下', nodeId: 'l1-result-beautifier' },
    { input: '你还记得我们之前聊过的项目吗', nodeId: 'l1-workspace-memory' },
    { input: '帮我把这个任务编排成流水线', nodeId: 'l1-pipeline-builder' }
  ]

  for (const { input, nodeId } of cases) {
    it(`「${input}」→ 漏斗停在 L1 层，产出可执行计划（${nodeId}）`, async () => {
      const outcome = await route(input)
      expect(outcome.kind).toBe('plan')
      expect(outcome.source).toBe('L1')
      if (outcome.kind === 'plan') {
        expect(outcome.plan.steps).toHaveLength(1)
        expect(outcome.plan.steps[0].tool).toBe('llm_generate')
        expect(outcome.plan.needs).toContain(nodeId)
      }
    })
  }

  it('负例：「帮我写周报」不落在 L1 新节点（应继续下沉）', async () => {
    const outcome = await route('帮我写周报')
    if (outcome.kind === 'plan' && outcome.source === 'L1') {
      expect(outcome.plan.needs).not.toContain('l1-task-translator')
      expect(outcome.plan.needs).not.toContain('l1-result-beautifier')
      expect(outcome.plan.needs).not.toContain('l1-workspace-memory')
      expect(outcome.plan.needs).not.toContain('l1-pipeline-builder')
    }
  })
})
