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
import type { Pipeline, DagNode, DagEdge } from '@/models'

function echo(nodeId: string, order: string[]) {
  registerHandler({
    id: nodeId,
    inputSchema: [],
    outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
    run: vi.fn(async () => {
      order.push(nodeId)
      return { response: nodeId }
    }),
  } as never)
}

const dagNode = (id: string, toolId: string): DagNode => ({
  id, toolId, toolName: id, toolLevel: 'L1', position: { x: 0, y: 0 }, params: {}, outputKey: id,
})
const dagEdge = (id: string, from: string, to: string): DagEdge => ({
  id, sourceNodeId: from, sourceOutputKey: 'k', targetNodeId: to, targetParamName: 'in',
})

describe('H-1: 画布依赖边（dagEdges）驱动执行顺序', () => {
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

  it('dagEdges 指定的拓扑序优先于 steps 数组序（A→C→B）', async () => {
    const order: string[] = []
    echo('t-a', order)
    echo('t-b', order)
    echo('t-c', order)
    const pipeline: Pipeline = {
      id: 'dag-order',
      name: 'dag',
      mode: 'serial',
      createdAt: Date.now(),
      attachedEntryIds: [],
      steps: [
        { toolId: 't-a', params: {}, outputKey: 't-a' },
        { toolId: 't-b', params: {}, outputKey: 't-b' },
        { toolId: 't-c', params: {}, outputKey: 't-c' },
      ],
      dagNodes: [dagNode('n0', 't-a'), dagNode('n1', 't-b'), dagNode('n2', 't-c')],
      dagEdges: [dagEdge('e0', 'n0', 'n2'), dagEdge('e1', 'n2', 'n1')],
    }
    await executePipeline(pipeline)
    expect(order).toEqual(['t-a', 't-c', 't-b'])
  })

  it('无 dagEdges 时回退 steps 数组序（serial 链）', async () => {
    const order: string[] = []
    echo('t-a', order)
    echo('t-b', order)
    echo('t-c', order)
    const pipeline: Pipeline = {
      id: 'plain',
      name: 'plain',
      mode: 'serial',
      createdAt: Date.now(),
      attachedEntryIds: [],
      steps: [
        { toolId: 't-a', params: {}, outputKey: 't-a' },
        { toolId: 't-b', params: {}, outputKey: 't-b' },
        { toolId: 't-c', params: {}, outputKey: 't-c' },
      ],
    }
    await executePipeline(pipeline)
    expect(order).toEqual(['t-a', 't-b', 't-c'])
  })

  it('mode=parallel 明确告警（不静默假装并行）', async () => {
    const order: string[] = []
    echo('t-a', order)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pipeline: Pipeline = {
      id: 'par',
      name: 'par',
      mode: 'parallel',
      createdAt: Date.now(),
      attachedEntryIds: [],
      steps: [{ toolId: 't-a', params: {}, outputKey: 't-a' }],
    }
    await executePipeline(pipeline)
    expect(warn).toHaveBeenCalled()
  })
})
