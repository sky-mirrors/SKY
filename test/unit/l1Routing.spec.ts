import { describe, it, expect } from 'vitest'
import { checkL1Capability } from '@/services/l0SkillRouter'

/**
 * L1 能力直调层路由覆盖测试（2026-09-30 补齐）
 *
 * 背景：`topology.ts` 的 L1_TOOLS 声明六节点，但 `checkL1Capability` 此前只产出 4 个 nodeId
 * （doc-convert / image-ops / model-gateway / knowledge-feeder）——task-translator /
 * pipeline-builder / workspace-memory / result-beautifier 四节点在执行侧有 handler
 * （`pipelineExecutor.ts:159-162`）却无路由入口，属「半接」。
 *
 * 本文件锁定补齐后六节点全部可达，并守住「不劫持 L2（RaaP 检索）」的边界。
 * 注意 confidence 公式：`min(matchedKw / keywords.length × 2, 0.9)` ⇒ 关键词表必须短，
 * 单次命中即需 ≥0.6（故每条规则仅 2-3 个高辨识度词）。
 */

const NEW_NODES = [
  'l1-task-translator',
  'l1-result-beautifier',
  'l1-workspace-memory',
  'l1-pipeline-builder'
]

describe('checkL1Capability · L1 六节点路由覆盖', () => {
  describe('新增四节点（本次补齐）', () => {
    it('任务翻译官：拆解类输入 → l1-task-translator', () => {
      const r = checkL1Capability('把这个需求拆解一下，给我执行步骤')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-task-translator')
      expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    })

    it('结果美化师：排版类输入 → l1-result-beautifier', () => {
      const r = checkL1Capability('把这段内容排版一下')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-result-beautifier')
      expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    })

    it('工作区记忆体：回忆类输入 → l1-workspace-memory', () => {
      const r = checkL1Capability('你还记得我们之前聊过的项目吗')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-workspace-memory')
      expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    })

    it('流水线搭建台：编排类输入 → l1-pipeline-builder', () => {
      const r = checkL1Capability('帮我把这个任务编排成流水线')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-pipeline-builder')
      expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    })

    it('每个新节点产出的计划都是可执行的 llm_generate 单步', () => {
      for (const input of [
        '把这个需求拆解一下，给我执行步骤',
        '把这段内容排版一下',
        '你还记得我们之前聊过的项目吗',
        '帮我把这个任务编排成流水线'
      ]) {
        const r = checkL1Capability(input)
        expect(r.plan?.steps).toHaveLength(1)
        expect(r.plan?.steps[0].tool).toBe('llm_generate')
      }
    })
  })

  describe('回归：既有两节点仍可达（补规则不得挤掉它们）', () => {
    it('模型网关：翻译+润色+改写 → l1-model-gateway', () => {
      const r = checkL1Capability('帮我翻译一下并润色改写这段话')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-model-gateway')
    })

    it('知识检索：检索+知识库 → l1-knowledge-feeder', () => {
      const r = checkL1Capability('检索知识库里的内容')
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe('l1-knowledge-feeder')
    })
  })

  describe('负例：不劫持应走 L2 的输入', () => {
    it('「帮我写周报」不落到新节点（L0 禁词已挡，L1 亦不得接）', () => {
      const r = checkL1Capability('帮我写周报')
      expect(NEW_NODES).not.toContain(r.nodeId)
    })

    it('「审查这份合同」不落到新节点', () => {
      const r = checkL1Capability('审查这份合同')
      expect(NEW_NODES).not.toContain(r.nodeId)
    })

    it('「把报告转成 pdf」不落到新节点（缺路径的转换应下沉）', () => {
      const r = checkL1Capability('把报告转成 pdf')
      expect(NEW_NODES).not.toContain(r.nodeId)
    })
  })
})
