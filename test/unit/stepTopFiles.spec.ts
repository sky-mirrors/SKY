// B1 微探针：{{step_N_top_files}} 的替换是否真的生效（隔离"替换"与"路径展开/IPC"两段）。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/kernel/plugins/llm', () => ({ getLLM: vi.fn(() => null) }))
vi.mock('@/stores/debugStore', () => ({ useDebugStore: vi.fn(() => ({ emitEvent: vi.fn() })) }))

import { resolveParams, substitutePlaceholdersInArgs } from '@/services/macroExecutor'
import type { L2ToolManifest, L2DagStep } from '@/models'

const listStep: L2DagStep = {
  step: 1, description: '列目录', tool: 'list_directory',
  depends_on: [], params: { path: '%USERPROFILE%\\Desktop\\HoloExam' }, expectedOutput: '清单'
}
const readStep: L2DagStep = {
  step: 2, description: '读文件', tool: 'read_file',
  depends_on: [1], params: { path: '{{step_1_top_files}}' }, expectedOutput: '内容'
}

const manifest: L2ToolManifest = {
  identity: { id: 'probe', name: 'probe', version: '1', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' },
  visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' },
  routing: { keywords: [], targetRoles: [], requiredL1: [], inputType: 'file_or_text', retrievalSummary: '', userSummary: '', confidenceThreshold: 0.5 },
  execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [listStep, readStep], fallbackStrategy: 'retry', maxRetries: 1 } },
  cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false }
}

describe('B1 微探针：{{step_1_top_files}} 替换', () => {
  it('从清单里挑出目标文件并拼上第 1 步的目录', () => {
    const resolved = resolveParams(readStep, manifest, { inputText: '帮我在桌面找一下张三的报销单' }, { 1: 'a.txt\n张三报销单.txt\n项目周报.docx' })
    // eslint-disable-next-line no-console
    console.log('PROBE resolved.path =', JSON.stringify(resolved.path))
    expect(String(resolved.path)).toBe('%USERPROFILE%\\Desktop\\HoloExam\\张三报销单.txt')
  })
})

describe('模型驱动循环的占位符替换（Q16 定案修复）', () => {
  const steps = [listStep, readStep]

  it('把 {{step_1_top_files}} 替换为真实路径（模型照抄占位符时救回）', () => {
    const args = substitutePlaceholdersInArgs(
      { path: '{{step_1_top_files}}' },
      { 1: 'a.txt\n张三报销单.txt\n项目周报.docx' },
      steps,
      '帮我在桌面找一下张三的报销单'
    )
    expect(args.path).toBe('%USERPROFILE%\\Desktop\\HoloExam\\张三报销单.txt')
  })

  it('无第 N 步结果时原样保留（不凭空造路径）', () => {
    const args = substitutePlaceholdersInArgs({ path: '{{step_1_top_files}}' }, {}, steps, 'x')
    expect(args.path).toBe('{{step_1_top_files}}')
  })

  it('{{step_N_result}} 直接注入文本；非字符串参数不动', () => {
    const args = substitutePlaceholdersInArgs({ prompt: '依据：{{step_1_result}}', n: 3 }, { 1: '内容A' }, steps, '')
    expect(args.prompt).toBe('依据：内容A')
    expect(args.n).toBe(3)
  })
})
