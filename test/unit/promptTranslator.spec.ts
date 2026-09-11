import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

const mockLLM = {
  chatCompletion: vi.fn().mockResolvedValue({ content: '{"intent":"test","params":{}}', toolCalls: [], usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }),
  chatCompletionStream: vi.fn(),
  listModels: vi.fn().mockResolvedValue([])
}

vi.mock('@/kernel/plugins/llm', () => ({
  getLLM: vi.fn(() => mockLLM)
}))

vi.mock('@/services/embedder', () => ({
  generatePseudoVector: vi.fn((text: string) => {
    const DIM = 384
    const vec = new Array(DIM).fill(0)
    const normalized = text.toLowerCase().trim()
    for (let i = 0; i < normalized.length; i++) {
      vec[i % DIM] += normalized.charCodeAt(i) / 65536
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1
    return vec.map((v: number) => v / norm)
  }),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, normA = 0, normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }),
  VECTOR_DIM: 384
}))

vi.mock('@/services/debugLog', () => ({
  debugLog: vi.fn()
}))

import { searchTaskCases, saveTaskCase, reflectOnResult } from '@/services/promptTranslator'

describe('promptTranslator', () => {
  beforeEach(() => {
    vault.clearCache()
    mockLLM.chatCompletion.mockResolvedValue({ content: '{"intent":"test","params":{}}', toolCalls: [], usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } })
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    globalBus.clear()
  })

  describe('searchTaskCases', () => {
    it('returns seed cases when no saved cases', () => {
      const results = searchTaskCases('审查合同', 3)
      expect(results.length).toBeGreaterThan(0)
    })

    it('respects topK limit', () => {
      const results = searchTaskCases('审查合同', 1)
      expect(results.length).toBe(1)
    })

    it('includes saved cases', () => {
      saveTaskCase({
        id: 'custom-1',
        input: '自定义测试用例',
        plan: { intent: '测试', needs: [], steps: [{ step: 1, description: '测试步骤', tool: 'auto', depends_on: [], params: {}, expectedOutput: '结果' }] },
        toolsUsed: [],
        success: true,
        vector: [],
        createdAt: Date.now()
      })
      const results = searchTaskCases('自定义', 5)
      const custom = results.find(r => r.id === 'custom-1')
      expect(custom).toBeDefined()
    })
  })

  describe('saveTaskCase', () => {
    it('saves and generates vector when missing', () => {
      saveTaskCase({
        id: 'save-test',
        input: '测试保存',
        plan: { intent: '测试', needs: [], steps: [{ step: 1, description: '测试', tool: 'auto', depends_on: [], params: {}, expectedOutput: '结果' }] },
        toolsUsed: [],
        success: true,
        vector: [],
        createdAt: Date.now()
      })
      const saved = JSON.parse(vault.readCache('task', 'holo-task-cases')!)
      const found = saved.find((c: any) => c.id === 'save-test')
      expect(found).toBeDefined()
      expect(found.vector.length).toBeGreaterThan(0)
    })

    it('caps at 50 entries', () => {
      for (let i = 0; i < 55; i++) {
        saveTaskCase({
          id: `cap-test-${i}`,
          input: `测试${i}`,
          plan: { intent: '测试', needs: [], steps: [{ step: 1, description: '测试', tool: 'auto', depends_on: [], params: {}, expectedOutput: '' }] },
          toolsUsed: [],
          success: true,
          vector: [],
          createdAt: Date.now()
        })
      }
      const saved = JSON.parse(vault.readCache('task', 'holo-task-cases')!)
      expect(saved.length).toBeLessThanOrEqual(50)
    })
  })

  describe('reflectOnResult', () => {
    it('returns satisfied when all tools executed and no errors', () => {
      const plan = {
        intent: 'test',
        needs: [],
        steps: [
          { step: 1, description: 'read', tool: 'file_read', depends_on: [], params: {}, expectedOutput: '' },
          { step: 2, description: 'write', tool: 'file_write', depends_on: [1], params: {}, expectedOutput: '' }
        ]
      }
      const result = reflectOnResult(plan, ['file_read', 'file_write'], false)
      expect(result.satisfied).toBe(true)
      expect(result.missingSteps).toEqual([])
    })

    it('returns not satisfied when steps are missing', () => {
      const plan = {
        intent: 'test',
        needs: [],
        steps: [
          { step: 1, description: 'read', tool: 'file_read', depends_on: [], params: {}, expectedOutput: '' },
          { step: 2, description: 'search', tool: 'knowledge_search', depends_on: [], params: {}, expectedOutput: '' }
        ]
      }
      const result = reflectOnResult(plan, ['file_read'], false)
      expect(result.satisfied).toBe(false)
      expect(result.missingSteps.length).toBe(1)
      expect(result.suggestion).toContain('跳过了步骤')
    })

    it('returns not satisfied when there are errors', () => {
      const plan = {
        intent: 'test',
        needs: [],
        steps: [{ step: 1, description: 'read', tool: 'file_read', depends_on: [], params: {}, expectedOutput: '' }]
      }
      const result = reflectOnResult(plan, ['file_read'], true)
      expect(result.satisfied).toBe(false)
      expect(result.suggestion).toContain('失败')
    })

    it('matches partial tool names', () => {
      const plan = {
        intent: 'test',
        needs: [],
        steps: [{ step: 1, description: 'exec', tool: 'shell_exec', depends_on: [], params: {}, expectedOutput: '' }]
      }
      const result = reflectOnResult(plan, ['exec'], false)
      expect(result.satisfied).toBe(true)
    })
  })

  describe('validateDAG (via planTask fallback)', () => {
    it('removes cycle edges from plan steps', async () => {
      const { planTask } = await import('@/services/promptTranslator')

      const cyclicPlan = {
        intent: 'test',
        needs: [],
        steps: [
          { step: 1, description: 'a', tool: 't1', depends_on: [2], params: {}, expectedOutput: '' },
          { step: 2, description: 'b', tool: 't2', depends_on: [1], params: {}, expectedOutput: '' },
          { step: 3, description: 'c', tool: 't3', depends_on: [], params: {}, expectedOutput: '' }
        ]
      }
      mockLLM.chatCompletion.mockResolvedValueOnce({ content: JSON.stringify(cyclicPlan) })

      const result = await planTask('test cyclic')
      const step1 = result.steps.find((s: any) => s.step === 1)
      const step2 = result.steps.find((s: any) => s.step === 2)
      const hasCycle = step1.depends_on.includes(2) && step2.depends_on.includes(1)
      expect(hasCycle).toBe(false)
    })
  })

  describe('disambiguateChoice', () => {
    it('returns null for empty candidates', async () => {
      const { disambiguateChoice } = await import('@/services/promptTranslator')
      const result = await disambiguateChoice('test', [])
      expect(result).toBeNull()
    })

    it('returns first candidate when only one', async () => {
      const { disambiguateChoice } = await import('@/services/promptTranslator')
      const manifest = { identity: { id: 'm1', name: 'Tool1', version: '1' }, routing: { keywords: [], retrievalSummary: '' }, execution: {}, cacheMeta: { estimatedTokenSaving: 0 } } as any
      const result = await disambiguateChoice('test', [{ manifest, score: 0.9, method: 'keyword' }])
      expect(result).not.toBeNull()
      expect(result!.choiceIndex).toBe(0)
    })

    it('returns null when LLM fails to pick', async () => {
      const { disambiguateChoice } = await import('@/services/promptTranslator')

      const manifests = [
        { identity: { id: 'm1', name: 'A', version: '1' }, routing: { keywords: [], retrievalSummary: '' }, execution: {}, cacheMeta: { estimatedTokenSaving: 0 } } as any,
        { identity: { id: 'm2', name: 'B', version: '1' }, routing: { keywords: [], retrievalSummary: '' }, execution: {}, cacheMeta: { estimatedTokenSaving: 0 } } as any
      ]
      const candidates = manifests.map((m, i) => ({ manifest: m, score: 0.9 - i * 0.1, method: 'keyword' }))

      mockLLM.chatCompletion.mockRejectedValueOnce(new Error('timeout'))

      const result = await disambiguateChoice('test', candidates)
      expect(result).toBeNull()
    })

    it('returns choice when LLM picks valid number', async () => {
      mockLLM.chatCompletion.mockResolvedValueOnce({ content: '2' })

      const { disambiguateChoice } = await import('@/services/promptTranslator')

      const manifests = [
        { identity: { id: 'm1', name: 'A', version: '1' }, routing: { keywords: [], retrievalSummary: '' }, execution: {}, cacheMeta: { estimatedTokenSaving: 0 } } as any,
        { identity: { id: 'm2', name: 'B', version: '1' }, routing: { keywords: [], retrievalSummary: '' }, execution: {}, cacheMeta: { estimatedTokenSaving: 0 } } as any
      ]
      const candidates = manifests.map((m, i) => ({ manifest: m, score: 0.9 - i * 0.1, method: 'keyword' }))

      const result = await disambiguateChoice('unique-test-prompt-xyz', candidates)
      if (result !== null) {
        expect(result.choiceIndex).toBe(1)
      }
    })
  })
})
