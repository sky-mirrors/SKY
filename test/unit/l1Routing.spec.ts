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

    it('每个新节点的计划步骤直接挂其执行侧工具（l1-*，2026-09-30 深化）', () => {
      const cases: Array<[string, string]> = [
        ['把这个需求拆解一下，给我执行步骤', 'l1-task-translator'],
        ['把这段内容排版一下', 'l1-result-beautifier'],
        ['你还记得我们之前聊过的项目吗', 'l1-workspace-memory'],
        ['帮我把这个任务编排成流水线', 'l1-pipeline-builder']
      ]
      for (const [input, tool] of cases) {
        const r = checkL1Capability(input)
        expect(r.plan?.steps).toHaveLength(1)
        // 产出必须挂该能力自己的工具名（而非统一 llm_generate）——执行时由 macroExecutor
        // 的 l1-* 分派路由到 pipelineExecutor 的 NodeHandler 注册表
        expect(r.plan?.steps[0].tool).toBe(tool)
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

// 门值校准基线（2026-09-30，回应 G-15「门值未经校准」）。
// `l1Pass = 0.6` 决定关键词规则型出口（model-gateway / knowledge-feeder / task-translator /
// result-beautifier / workspace-memory / pipeline-builder）的放行。实测标注集：6 个节点各 1-2 条
// 自然语言输入共 10 条 → **10/10 命中正确**，4 条负样本（周报/合同审查/文档翻译/天气）**零误接**。
// 结论：0.6 在本样本集下安全。若将来公式或门值改动引入误接，本 describe 会红。
describe('L1 门值校准基线 · l1Pass = 0.6', () => {
  const LABELED: Array<[string, string]> = [
    ['帮我翻译一下这段话并润色改写', 'l1-model-gateway'],
    ['帮我把这段话润色一下', 'l1-model-gateway'],
    ['把这段话翻译成英文', 'l1-model-gateway'],
    ['帮我总结一下这段内容', 'l1-model-gateway'],
    // 回归样本：缩表时删掉 '改写' 导致此输入漏接（实测）；改为"以 3 词为满分基准"的
    // 分母后表可容纳更多同义词，此条恢复命中。
    ['改写这段文字', 'l1-model-gateway'],
    ['检索知识库里的内容', 'l1-knowledge-feeder'],
    ['检索一下知识库', 'l1-knowledge-feeder'],
    ['把这个需求拆解一下，给我执行步骤', 'l1-task-translator'],
    ['把这个任务分解成几步', 'l1-task-translator'],
    ['把这段内容排版一下', 'l1-result-beautifier'],
    ['这段输出美化一下', 'l1-result-beautifier'],
    ['把输出渲染成好看的格式', 'l1-result-beautifier'],
    ['你还记得我们之前聊过的项目吗', 'l1-workspace-memory'],
    ['之前聊过的需求是什么', 'l1-workspace-memory'],
    ['历史记录里有没有提过这个项目', 'l1-workspace-memory'],
    ['帮我把这个任务编排成流水线', 'l1-pipeline-builder'],
    ['把这几步串成自动化流程', 'l1-pipeline-builder']
  ]
  const NEGATIVES = [
    '帮我写一份周报',
    '审查这份合同的风险',
    '把这份文档翻译成英文',
    '今天天气怎么样',
    // 「写一段产品介绍文案」的正确归属是 L0 规则 3（简单文本生成）——
    // L1 不该抢，故它是负样本而非正样本（原标注把它当正样本是错的）。
    '写一段产品介绍文案'
  ]

  it('关键词型出口：全部落到正确的节点', () => {
    for (const [input, want] of LABELED) {
      const r = checkL1Capability(input)
      expect(r.canHandle).toBe(true)
      expect(r.nodeId).toBe(want)
      expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    }
  })

  it('负样本零误接（不得被 L1 关键词规则接走）', () => {
    for (const input of NEGATIVES) {
      const r = checkL1Capability(input)
      const kwNodes = ['l1-model-gateway', 'l1-knowledge-feeder', 'l1-task-translator', 'l1-result-beautifier', 'l1-workspace-memory', 'l1-pipeline-builder']
      expect(kwNodes).not.toContain(r.nodeId)
    }
  })

  it('置信度下限：单次命中即过门（conf = min(命中数 / min(表长,3) × 2, 0.9) ≥ 0.6）', () => {
    // 3 词表命中 1 个 → 0.667 ≥ 0.6 ✓（这是"关键词表必须短"那条约束的量化依据）
    const r = checkL1Capability('把这个需求拆解一下')
    expect(r.nodeId).toBe('l1-task-translator')
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
  })
})
