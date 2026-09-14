import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubGlobal('window', {
  electronAPI: {
    storeWrite: vi.fn().mockResolvedValue(undefined),
    storeRead: vi.fn().mockResolvedValue(null)
  }
})

import {
  contentHash,
  truncateForLog,
  compilePrompt,
  fillCompiledPrompt,
  computeInputFingerprint,
  computeStepPlan,
  simulateDataFlow,
  computeStepOutputHash,
  findDirtySteps,
  getTierConfig,
  computeParallelGroups,
  getValidationCacheKey,
  lookupValidationCache,
  saveValidationCache
} from '@/services/scheduleOptimizer'
import type { L2DagStep, L2ToolManifest } from '@/models'

describe('scheduleOptimizer', () => {
  describe('contentHash', () => {
    it('相同内容返回相同hash', () => {
      expect(contentHash('hello world')).toBe(contentHash('hello world'))
    })

    it('不同内容返回不同hash', () => {
      expect(contentHash('hello')).not.toBe(contentHash('world'))
    })

    it('空字符串也能hash', () => {
      const h = contentHash('')
      expect(typeof h).toBe('string')
      expect(h.length).toBeGreaterThan(0)
    })
  })

  describe('truncateForLog', () => {
    it('短内容不截断', () => {
      expect(truncateForLog('short', 200)).toBe('short')
    })

    it('长内容截断并加提示', () => {
      const long = 'a'.repeat(300)
      const result = truncateForLog(long, 200)
      expect(result.length).toBeLessThan(long.length)
      expect(result).toContain('已截断')
    })

    it('自定义maxLen', () => {
      const s = 'abcdefghij'
      expect(truncateForLog(s, 5)).toContain('abcde')
    })
  })

  describe('compilePrompt / fillCompiledPrompt', () => {
    it('提取 {{变量}} 插槽', () => {
      const compiled = compilePrompt('你好{{name}}，今天是{{date}}')
      expect(compiled.variableSlots).toEqual(['name', 'date'])
    })

    it('缓存编译结果', () => {
      const a = compilePrompt('测试{{x}}')
      const b = compilePrompt('测试{{x}}')
      expect(a).toBe(b)
    })

    it('填充变量', () => {
      const compiled = compilePrompt('你好{{name}}，{{greeting}}')
      const filled = fillCompiledPrompt(compiled, { name: '世界', greeting: '早上好' })
      expect(filled).toBe('你好世界，早上好')
    })

    it('缺失变量替换为空字符串', () => {
      const compiled = compilePrompt('{{a}}和{{b}}')
      const filled = fillCompiledPrompt(compiled, { a: 'X' })
      expect(filled).toBe('X和')
    })

    it('重复变量全部替换', () => {
      const compiled = compilePrompt('{{x}}+{{x}}')
      const filled = fillCompiledPrompt(compiled, { x: '1' })
      expect(filled).toBe('1+1')
    })
  })

  describe('computeInputFingerprint', () => {
    it('相同输入返回相同指纹', () => {
      const a = computeInputFingerprint({ filePath: '/tmp/a.txt', inputText: 'hello', context: 'test' })
      const b = computeInputFingerprint({ filePath: '/tmp/a.txt', inputText: 'hello', context: 'test' })
      expect(a).toBe(b)
    })

    it('不同输入返回不同指纹', () => {
      const a = computeInputFingerprint({ filePath: '/tmp/a.txt', inputText: 'hello' })
      const b = computeInputFingerprint({ filePath: '/tmp/b.txt', inputText: 'hello' })
      expect(a).not.toBe(b)
    })

    it('空输入也能计算', () => {
      const fp = computeInputFingerprint({})
      expect(typeof fp).toBe('string')
    })
  })

  describe('computeStepPlan - shell_exec 永不缓存复用', () => {
    const makeStep = (step: number, tool: string, deps: number[] = []): L2DagStep => ({
      step,
      tool,
      description: `步骤${step}`,
      params: {},
      depends_on: deps
    })

    it('shell_exec 有缓存结果也不复用 → willExecute', () => {
      const steps = [
        makeStep(1, 'shell_exec'),
        makeStep(2, 'llm_generate', [1])
      ]
      const cachedResults = { 1: 'shell output', 2: 'llm output' }
      const plan = computeStepPlan(steps, new Set(), new Set(), cachedResults)
      const step1Plan = plan.willExecute.find(s => s.step === 1) || plan.willReuse.find(s => s.step === 1)
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 1)).toBe(false)
    })

    it('llm_generate 有缓存结果 → willReuse', () => {
      const steps = [
        makeStep(1, 'llm_generate')
      ]
      const cachedResults = { 1: 'cached llm output' }
      const plan = computeStepPlan(steps, new Set(), new Set(), cachedResults)
      expect(plan.willReuse.some(s => s.step === 1)).toBe(true)
      expect(plan.willExecute.some(s => s.step === 1)).toBe(false)
    })

    it('无缓存结果 → willExecute', () => {
      const steps = [makeStep(1, 'llm_generate')]
      const plan = computeStepPlan(steps, new Set(), new Set(), null)
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
    })

    it('skipSteps → willSkip', () => {
      const steps = [makeStep(1, 'llm_generate')]
      const plan = computeStepPlan(steps, new Set(), new Set([1]), { 1: 'old' })
      expect(plan.willSkip[0]?.step).toBe(1)
    })

    it('dirtySteps → willExecute (即使有缓存)', () => {
      const steps = [makeStep(1, 'llm_generate')]
      const plan = computeStepPlan(steps, new Set([1]), new Set(), { 1: 'cached' })
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 1)).toBe(false)
    })

    it('混合场景：shell_exec+llm_generate+skip', () => {
      const steps = [
        makeStep(1, 'shell_exec'),
        makeStep(2, 'llm_generate', [1]),
        makeStep(3, 'read_file', [1])
      ]
      const cachedResults = { 1: 's1', 2: 's2', 3: 's3' }
      const plan = computeStepPlan(steps, new Set(), new Set([3]), cachedResults)
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 2)).toBe(true)
      expect(plan.willSkip.some(s => s.step === 3)).toBe(true)
    })

    it('P1-15: create_docx 有缓存结果也不复用 → willExecute（原漏副作用集=假成功）', () => {
      const steps = [
        makeStep(1, 'create_docx'),
        makeStep(2, 'file_write')
      ]
      const cachedResults = { 1: 'docx created', 2: 'file written' }
      const plan = computeStepPlan(steps, new Set(), new Set(), cachedResults)
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 1)).toBe(false)
      expect(plan.willExecute.some(s => s.step === 2)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 2)).toBe(false)
    })

    it('P1-15: read_file 有缓存结果不复用（文件现状可能已变）', () => {
      const steps = [makeStep(1, 'read_file')]
      const plan = computeStepPlan(steps, new Set(), new Set(), { 1: 'cached content' })
      expect(plan.willExecute.some(s => s.step === 1)).toBe(true)
      expect(plan.willReuse.some(s => s.step === 1)).toBe(false)
    })

    it('P1-15: create_directory/http_request 均不复用', () => {
      const steps = [
        makeStep(1, 'create_directory'),
        makeStep(2, 'http_request')
      ]
      const cachedResults = { 1: 'dir made', 2: '[HTTP 200] ok' }
      const plan = computeStepPlan(steps, new Set(), new Set(), cachedResults)
      expect(plan.willReuse).toHaveLength(0)
    })
  })

  describe('simulateDataFlow', () => {
    it('正常DAG无错误', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: { prompt: '分析数据' }, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: '步骤2', params: { prompt: '基于{{step_1_result}}总结' }, depends_on: [1] }
      ]
      const report = simulateDataFlow(steps)
      expect(report.ok).toBe(true)
      expect(report.issues).toHaveLength(0)
    })

    it('引用不存在的步骤 → error', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: { prompt: '基于{{step_3_result}}分析' }, depends_on: [] }
      ]
      const report = simulateDataFlow(steps)
      expect(report.ok).toBe(false)
      expect(report.issues.some(i => i.severity === 'error')).toBe(true)
    })

    it('引用存在但未声明依赖 → warning', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: { prompt: '分析' }, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: '步骤2', params: { prompt: '基于{{step_1_result}}总结' }, depends_on: [] }
      ]
      const report = simulateDataFlow(steps)
      expect(report.ok).toBe(true)
      expect(report.issues.some(i => i.severity === 'warning')).toBe(true)
    })

    it('空步骤列表 → 正常', () => {
      const report = simulateDataFlow([])
      expect(report.ok).toBe(true)
    })
  })

  describe('computeStepOutputHash', () => {
    it('只hash前1000字符', () => {
      const short = 'hello'
      const long = 'hello' + 'x'.repeat(2000)
      expect(computeStepOutputHash(short)).not.toBe(computeStepOutputHash(long.substring(0, 5) + 'y'))
    })

    it('相同前1000字符返回相同hash', () => {
      const a = 'A'.repeat(2000)
      const b = 'A'.repeat(2000)
      expect(computeStepOutputHash(a)).toBe(computeStepOutputHash(b))
    })
  })

  describe('findDirtySteps', () => {
    const makeManifest = (steps: L2DagStep[]): L2ToolManifest => ({
      id: 'test',
      name: '测试',
      userSummary: '测试manifest',
      roles: ['general'],
      version: 1,
      execution: { mode: 'dag', dagPlan: { steps, parallelGroups: [] } }
    } as any)

    it('缓存hash与当前一致 → 非脏步', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: {}, depends_on: [] }
      ]
      const manifest = makeManifest(steps)
      const output = 'test output'
      const hash = computeStepOutputHash(output)
      const fp = { manifestId: 'test', inputHash: 'x', stepHashes: { 1: hash }, results: {}, executedAt: Date.now() }
      const dirty = findDirtySteps(manifest, fp, { 1: output })
      expect(dirty.has(1)).toBe(false)
    })

    it('缓存hash与当前不一致 → 脏步', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: '步骤2', params: {}, depends_on: [1] }
      ]
      const manifest = makeManifest(steps)
      const fp = { manifestId: 'test', inputHash: 'x', stepHashes: { 1: 'oldhash', 2: 'hash2' }, results: {}, executedAt: Date.now() }
      const dirty = findDirtySteps(manifest, fp, { 1: 'new output' })
      expect(dirty.has(1)).toBe(true)
    })

    it('下游步骤输出也变化 → 两个都脏', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: '步骤1', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: '步骤2', params: {}, depends_on: [1] }
      ]
      const manifest = makeManifest(steps)
      const fp = { manifestId: 'test', inputHash: 'x', stepHashes: { 1: 'oldhash', 2: 'oldhash2' }, results: {}, executedAt: Date.now() }
      const dirty = findDirtySteps(manifest, fp, { 1: 'new output', 2: 'new output2' })
      expect(dirty.has(1)).toBe(true)
      expect(dirty.has(2)).toBe(true)
    })

    it('P1-14: 脏步沿下游 dependents 传播，上游与旁支不受影响', () => {
      const steps: L2DagStep[] = [
        { step: 0, tool: 'llm_generate', description: '上游', params: {}, depends_on: [] },
        { step: 1, tool: 'llm_generate', description: '中游', params: {}, depends_on: [0] },
        { step: 2, tool: 'llm_generate', description: '下游', params: {}, depends_on: [1] },
        { step: 3, tool: 'llm_generate', description: '旁支', params: {}, depends_on: [0] }
      ]
      const manifest = makeManifest(steps)
      const fp = {
        manifestId: 'test',
        inputHash: 'x',
        stepHashes: { 0: 'h0', 1: 'oldhash', 2: 'h2', 3: 'h3' },
        results: {},
        executedAt: Date.now()
      }
      const dirty = findDirtySteps(manifest, fp, { 1: 'changed output' })
      expect(dirty.has(1)).toBe(true)
      expect(dirty.has(2)).toBe(true)
      expect(dirty.has(0)).toBe(false)
      expect(dirty.has(3)).toBe(false)
    })

    it('P1-14: 菱形依赖下游全链失效', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: 'A', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: 'B', params: {}, depends_on: [1] },
        { step: 3, tool: 'llm_generate', description: 'C', params: {}, depends_on: [1] },
        { step: 4, tool: 'llm_generate', description: 'D', params: {}, depends_on: [2, 3] }
      ]
      const manifest = makeManifest(steps)
      const fp = {
        manifestId: 'test',
        inputHash: 'x',
        stepHashes: { 1: 'oldhash', 2: 'h2', 3: 'h3', 4: 'h4' },
        results: {},
        executedAt: Date.now()
      }
      const dirty = findDirtySteps(manifest, fp, { 1: 'changed' })
      expect(dirty.has(1)).toBe(true)
      expect(dirty.has(2)).toBe(true)
      expect(dirty.has(3)).toBe(true)
      expect(dirty.has(4)).toBe(true)
    })
  })

  describe('getTierConfig', () => {
    it('nano tier', () => {
      const c = getTierConfig('nano')
      expect(c.maxTokens).toBe(512)
      expect(c.temperature).toBe(0.1)
    })

    it('mini tier', () => {
      const c = getTierConfig('mini')
      expect(c.maxTokens).toBe(1024)
      expect(c.temperature).toBe(0.3)
    })

    it('standard tier (默认)', () => {
      const c = getTierConfig()
      expect(c.maxTokens).toBe(4096)
    })

    it('pro tier', () => {
      const c = getTierConfig('pro')
      expect(c.maxTokens).toBe(8192)
      expect(c.temperature).toBe(0.7)
    })

    it('无效tier → standard', () => {
      const c = getTierConfig('nonexistent')
      expect(c.maxTokens).toBe(4096)
    })
  })

  describe('computeParallelGroups', () => {
    it('无依赖 → 单组并行', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: 'A', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: 'B', params: {}, depends_on: [] }
      ]
      const groups = computeParallelGroups(steps, new Set())
      expect(groups).toHaveLength(1)
      expect(groups[0]).toHaveLength(2)
    })

    it('线性依赖 → 多组串行', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: 'A', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: 'B', params: {}, depends_on: [1] },
        { step: 3, tool: 'llm_generate', description: 'C', params: {}, depends_on: [2] }
      ]
      const groups = computeParallelGroups(steps, new Set())
      expect(groups).toHaveLength(3)
      expect(groups[0][0].step).toBe(1)
      expect(groups[1][0].step).toBe(2)
      expect(groups[2][0].step).toBe(3)
    })

    it('菱形依赖 → 3组', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: 'A', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: 'B', params: {}, depends_on: [1] },
        { step: 3, tool: 'llm_generate', description: 'C', params: {}, depends_on: [1] },
        { step: 4, tool: 'llm_generate', description: 'D', params: {}, depends_on: [2, 3] }
      ]
      const groups = computeParallelGroups(steps, new Set())
      expect(groups).toHaveLength(3)
      expect(groups[1]).toHaveLength(2)
    })

    it('skipSteps 跳过的步骤不影响分组', () => {
      const steps: L2DagStep[] = [
        { step: 1, tool: 'llm_generate', description: 'A', params: {}, depends_on: [] },
        { step: 2, tool: 'llm_generate', description: 'B', params: {}, depends_on: [1] }
      ]
      const groups = computeParallelGroups(steps, new Set([1]))
      expect(groups).toHaveLength(1)
      expect(groups[0][0].step).toBe(2)
    })
  })

  describe('ValidationCache', () => {
    it('保存并查找缓存', () => {
      const key = getValidationCacheKey('skill1', 'file.txt', '文件写入')
      saveValidationCache(key, { intent_match: true, parameter_sane: true, risk_level: 'low' })
      const result = lookupValidationCache(key)
      expect(result).not.toBeNull()
      expect(result!.risk_level).toBe('low')
      expect(result!.from_cache).toBe(true)
    })

    it('未缓存返回null', () => {
      const result = lookupValidationCache('nonexistent-key')
      expect(result).toBeNull()
    })

    it('不同key不互相干扰', () => {
      const key1 = getValidationCacheKey('skill1', 'a.txt', '文件写入')
      const key2 = getValidationCacheKey('skill2', 'b.txt', '文件写入')
      saveValidationCache(key1, { intent_match: true, parameter_sane: true, risk_level: 'low' })
      saveValidationCache(key2, { intent_match: false, parameter_sane: false, risk_level: 'high' })
      const r1 = lookupValidationCache(key1)
      const r2 = lookupValidationCache(key2)
      expect(r1!.risk_level).toBe('low')
      expect(r2!.risk_level).toBe('high')
    })
  })
})
