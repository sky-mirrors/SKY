import { describe, it, expect, vi, beforeEach } from 'vitest'
import { formatLineage, computeLineageSavings, resolveDirectPrompt } from '@/services/macroExecutor'
import type { MacroLineage } from '@/services/macroExecutor'

vi.mock('@/services/scheduleOptimizer', () => ({
  compilePrompt: vi.fn((t: string) => ({ template: t, slots: [] })),
  fillCompiledPrompt: vi.fn((c: any, v: any) => {
    let r = c.template || ''
    for (const [k, val] of Object.entries(v || {})) r = r.replaceAll(`{{${k}}}`, String(val))
    return r
  }),
  computeInputFingerprint: vi.fn(() => 'fp'),
  findCachedExecution: vi.fn(() => null),
  saveExecutionFingerprint: vi.fn(),
  computeStepOutputHash: vi.fn(() => 'hash'),
  findDirtySteps: vi.fn(() => new Set()),
  getTierConfig: vi.fn(() => ({ maxTokens: 4096, temperature: 0.5 })),
  computeStepPlan: vi.fn(),
  computeParallelGroups: vi.fn(),
  formatStepPlanVisualization: vi.fn(() => ''),
  isManifestAutoCompiled: vi.fn(() => false),
  simulateDataFlow: vi.fn(() => ({ ok: true, issues: [], summary: '' }))
}))

describe('formatLineage', () => {
  it('格式化空血统', () => {
    expect(formatLineage([])).toBe('')
  })

  it('格式化单步骤llm_standard', () => {
    const lineage: MacroLineage = [{ step: 1, source: 'llm_standard', tool: 'llm_generate', tier: 'standard' }]
    const result = formatLineage(lineage)
    expect(result).toContain('步骤1')
    expect(result).toContain('LLM Standard')
    expect(result).toContain('llm_generate')
    expect(result).toContain('层级=standard')
  })

  it('格式化规则引擎血统含ruleId', () => {
    const lineage: MacroLineage = [{ step: 2, source: 'rule_engine', tool: 'llm_generate', ruleId: 'r1' }]
    const result = formatLineage(lineage)
    expect(result).toContain('规则引擎')
    expect(result).toContain('规则=r1')
  })

  it('格式化多步骤混合血统', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'llm_pro', tool: 'llm_generate', tier: 'pro' },
      { step: 2, source: 'cache_reuse', tool: 'shell_exec' },
      { step: 3, source: 'skipped', tool: 'read_file' }
    ]
    const result = formatLineage(lineage)
    expect(result.split('\n').length).toBe(3)
    expect(result).toContain('LLM Pro')
    expect(result).toContain('缓存复用')
    expect(result).toContain('跳过')
  })

  it('格式化所有source类型', () => {
    const sources: MacroLineage[0]['source'][] = [
      'llm_pro', 'llm_standard', 'llm_mini', 'llm_nano',
      'rule_engine', 'cache_reuse', 'auto_compiled', 'skipped',
      'tool_call', 'fallback', 'replay_reuse'
    ]
    for (const src of sources) {
      const lineage: MacroLineage = [{ step: 1, source: src, tool: 'test' }]
      const result = formatLineage(lineage)
      expect(result).toContain('步骤1')
      expect(result.length).toBeGreaterThan(5)
    }
  })
})

describe('computeLineageSavings', () => {
  it('空血统零节省', () => {
    const result = computeLineageSavings([])
    expect(result.tokensSaved).toBe(0)
    expect(result.llmSteps).toBe(0)
    expect(result.zeroTokenSteps).toBe(0)
  })

  it('llm步骤计为llmSteps不节省token', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'llm_standard', tool: 'llm_generate', tier: 'standard' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.llmSteps).toBe(1)
    expect(result.zeroTokenSteps).toBe(0)
    expect(result.tokensSaved).toBe(0)
  })

  it('缓存复用llm步骤节省2000 token', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'cache_reuse', tool: 'llm_generate' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.zeroTokenSteps).toBe(1)
    expect(result.tokensSaved).toBe(2000)
  })

  it('缓存复用非llm步骤节省500 token', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'cache_reuse', tool: 'shell_exec' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.tokensSaved).toBe(500)
  })

  it('规则引擎步骤零token', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'rule_engine', tool: 'llm_generate', ruleId: 'r1' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.zeroTokenSteps).toBe(1)
    expect(result.tokensSaved).toBe(2000)
  })

  it('auto_compiled步骤零token节省2000', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'auto_compiled', tool: 'llm_generate' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.zeroTokenSteps).toBe(1)
    expect(result.tokensSaved).toBe(2000)
  })

  it('replay_reuse步骤零token节省500', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'replay_reuse', tool: 'shell_exec' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.zeroTokenSteps).toBe(1)
    expect(result.tokensSaved).toBe(500)
  })

  it('skipped步骤零token节省500', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'skipped', tool: 'read_file' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.zeroTokenSteps).toBe(1)
    expect(result.tokensSaved).toBe(500)
  })

  it('混合血统综合计算', () => {
    const lineage: MacroLineage = [
      { step: 1, source: 'llm_standard', tool: 'llm_generate', tier: 'standard' },
      { step: 2, source: 'cache_reuse', tool: 'llm_generate' },
      { step: 3, source: 'rule_engine', tool: 'llm_generate', ruleId: 'r1' },
      { step: 4, source: 'tool_call', tool: 'shell_exec' },
      { step: 5, source: 'skipped', tool: 'read_file' }
    ]
    const result = computeLineageSavings(lineage)
    expect(result.llmSteps).toBe(1)
    expect(result.zeroTokenSteps).toBe(4)
    expect(result.tokensSaved).toBe(2000 + 2000 + 500 + 500)
  })
})

describe('resolveDirectPrompt', () => {
  it('非direct模式返回null', () => {
    const manifest = {
      execution: { mode: 'macro', directCall: undefined, paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } }
    } as any
    expect(resolveDirectPrompt(manifest, { inputText: 'test' })).toBeNull()
  })

  it('direct模式无directCall返回null', () => {
    const manifest = {
      execution: { mode: 'direct', directCall: undefined, paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } }
    } as any
    expect(resolveDirectPrompt(manifest, { inputText: 'test' })).toBeNull()
  })

  it('direct模式返回prompt和maxTokens', () => {
    const manifest = {
      execution: {
        mode: 'direct',
        directCall: { promptTemplate: '分析: {{input}}', maxTokens: 2048 },
        paramMapping: { slots: [], bindings: [] },
        dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 }
      }
    } as any
    const result = resolveDirectPrompt(manifest, { inputText: 'hello world' })
    expect(result).not.toBeNull()
    expect(result!.prompt).toContain('hello world')
    expect(result!.maxTokens).toBe(2048)
  })

  it('direct模式带slot绑定替换', () => {
    const manifest = {
      execution: {
        mode: 'direct',
        directCall: { promptTemplate: '文件: {{user_file}} 内容: {{input}}', maxTokens: 1024 },
        paramMapping: {
          slots: [
            { name: '{user_file}', source: 'file_path' },
            { name: '{input}', source: 'input_text' }
          ],
          bindings: []
        },
        dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 }
      }
    } as any
    const result = resolveDirectPrompt(manifest, { inputText: 'query', filePath: '/tmp/test.txt' })
    expect(result).not.toBeNull()
    expect(result!.prompt).toContain('/tmp/test.txt')
    expect(result!.prompt).toContain('query')
  })

  it('direct模式context slot替换', () => {
    const manifest = {
      execution: {
        mode: 'direct',
        directCall: { promptTemplate: '上下文: {{context}}', maxTokens: 512 },
        paramMapping: {
          slots: [{ name: '{context}', source: 'context' }],
          bindings: []
        },
        dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 }
      }
    } as any
    const result = resolveDirectPrompt(manifest, { context: 'some context' })
    expect(result).not.toBeNull()
    expect(result!.prompt).toContain('some context')
  })
})
