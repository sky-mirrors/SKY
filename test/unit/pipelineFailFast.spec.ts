import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

const mockGateway = {
  chatCompletion: vi.fn().mockResolvedValue('test response'),
  listModels: vi.fn().mockReturnValue([]),
  switchProvider: vi.fn(),
  switchModel: vi.fn(),
}

vi.mock('@/services/knowledgeBase', () => ({
  knowledgeAdapter: { search: vi.fn().mockResolvedValue([]) },
  hybridSearch: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/services/memory', () => ({
  memoryAdapter: { search: vi.fn().mockResolvedValue([]) },
  getContextWindow: vi.fn().mockReturnValue({ messages: [], summary: '' }),
  addMessage: vi.fn(),
}))
vi.mock('@/services/promptTranslator', () => ({ compileToChain: vi.fn().mockResolvedValue({ steps: [], raw: '' }) }))
vi.mock('@/services/resultBeautifier', () => ({ beautify: vi.fn().mockReturnValue('') }))

import { registerHandler, executePipeline } from '@/services/pipelineExecutor'
import type { Pipeline, PipelineStep } from '@/models'

function makePipeline(steps: PipelineStep[]): Pipeline {
  return {
    id: `fail-fast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'fail-fast',
    mode: 'serial',
    createdAt: Date.now(),
    attachedEntryIds: [],
    steps,
  }
}

function echo(id: string, order: string[]) {
  registerHandler({
    id,
    inputSchema: [],
    outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
    run: vi.fn(async () => {
      order.push(id)
      return { response: id }
    }),
  } as never)
}

describe('H-3: 未注册工具必须让管道失败（不得假完成）', () => {
  let originalWindow: unknown

  beforeEach(() => {
    vault.clearCache()
    originalWindow = (globalThis as unknown as { window: unknown }).window
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
      },
    })
    globalBus.registerHandler('llm:get-gateway', () => mockGateway)
    globalBus.on('debug:register-abort', () => {})
    globalBus.on('debug:clear-abort', () => {})
    globalBus.on('debug:log-probe', () => {})
    globalBus.registerHandler('debug:get-step-cost', () => undefined)
  })

  afterEach(() => {
    globalBus.clear()
    vi.restoreAllMocks()
    ;(globalThis as unknown as { window: unknown }).window = originalWindow
    vi.unstubAllGlobals()
  })

  it('单步工具未注册 → 管道 reject（不再返回「假完成」结果）', async () => {
    const pipeline = makePipeline([{ toolId: 'no-such-tool', params: {}, outputKey: 'x' }])
    await expect(executePipeline(pipeline)).rejects.toThrow(/未注册|not registered/)
  })

  it('前置步骤工具未注册 → 后续步骤不得执行', async () => {
    const order: string[] = []
    echo('t-ok-h3', order)
    const pipeline = makePipeline([
      { toolId: 'no-such-tool', params: {}, outputKey: 'bad' },
      { toolId: 't-ok-h3', params: {}, outputKey: 'ok' },
    ])
    await expect(executePipeline(pipeline)).rejects.toThrow()
    expect(order).toEqual([])
  })

  it('全部工具已注册 → 正常完成', async () => {
    const order: string[] = []
    echo('t-a-h3', order)
    const pipeline = makePipeline([{ toolId: 't-a-h3', params: {}, outputKey: 'a' }])
    const res = await executePipeline(pipeline)
    expect(order).toEqual(['t-a-h3'])
    expect(res['a']).toBe('t-a-h3')
  })
})
