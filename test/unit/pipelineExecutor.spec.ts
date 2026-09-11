import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

const mockGateway = {
  chatCompletion: vi.fn().mockResolvedValue('test response'),
  listModels: vi.fn().mockReturnValue([]),
  switchProvider: vi.fn(),
  switchModel: vi.fn()
}

vi.mock('@/services/knowledgeBase', () => ({
  knowledgeAdapter: { search: vi.fn().mockResolvedValue([{ text: 'result text', source: 'kb' }]) },
  hybridSearch: vi.fn().mockResolvedValue([{ text: 'result text', source: 'kb' }])
}))

vi.mock('@/services/memory', () => ({
  memoryAdapter: { search: vi.fn().mockResolvedValue([]) },
  getContextWindow: vi.fn().mockReturnValue({ messages: [{ role: 'user', content: 'test' }], summary: 'test summary' }),
  addMessage: vi.fn()
}))

vi.mock('@/services/promptTranslator', () => ({
  compileToChain: vi.fn().mockResolvedValue({
    steps: [{ tool: 'l1-model-gateway', params: { prompt: 'test' }, expectedOutput: 'result' }],
    raw: ''
  })
}))

vi.mock('@/services/resultBeautifier', () => ({
  beautify: vi.fn().mockReturnValue('<p>beautified</p>')
}))

vi.mock('@/services/debugLog', () => ({
  debugLog: vi.fn()
}))

import { registerHandler, getHandler, getAllHandlers, executePipeline } from '@/services/pipelineExecutor'
import { Pipeline, PipelineStep, NodeHandler } from '@/models'

function makePipeline(steps: PipelineStep[], mode: 'serial' | 'parallel' = 'serial'): Pipeline {
  return {
    id: `test-pipe-${Date.now()}`,
    name: 'Test Pipeline',
    steps,
    mode,
    createdAt: Date.now(),
    attachedEntryIds: []
  }
}

describe('pipelineExecutor', () => {
  let originalWindow: any

  beforeEach(() => {
    vault.clearCache()
    originalWindow = (globalThis as any).window
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
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
    ;(globalThis as any).window = originalWindow
    vi.unstubAllGlobals()
  })

  describe('registerHandler / getHandler / getAllHandlers', () => {
    it('registers and retrieves a handler', () => {
      const handler: NodeHandler = {
        id: 'test-handler-reg',
        inputSchema: [],
        outputSchema: [],
        run: vi.fn().mockResolvedValue({ result: 'ok' })
      }
      registerHandler(handler)
      expect(getHandler('test-handler-reg')).toBe(handler)
    })

    it('getHandler returns undefined for unknown id', () => {
      expect(getHandler('nonexistent')).toBeUndefined()
    })

    it('getAllHandlers returns all registered handlers', () => {
      const all = getAllHandlers()
      expect(all.length).toBeGreaterThanOrEqual(6)
    })

    it('built-in handlers are registered', () => {
      expect(getHandler('l1-knowledge-feeder')).toBeDefined()
      expect(getHandler('l1-model-gateway')).toBeDefined()
      expect(getHandler('l1-task-translator')).toBeDefined()
      expect(getHandler('l1-workspace-memory')).toBeDefined()
      expect(getHandler('l1-result-beautifier')).toBeDefined()
      expect(getHandler('l1-pipeline-builder')).toBeDefined()
    })
  })

  describe('executePipeline', () => {
    it('executes a single-step serial pipeline', async () => {
      const handler: NodeHandler = {
        id: 'test-echo',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockResolvedValue({ response: 'hello world' })
      }
      registerHandler(handler)

      const pipeline = makePipeline([
        { toolId: 'test-echo', params: {}, outputKey: 'step1' }
      ])

      const progress = vi.fn()
      const result = await executePipeline(pipeline, progress)

      expect(result['step1']).toBe('hello world')
      expect(handler.run).toHaveBeenCalled()
      expect(progress).toHaveBeenCalled()
    })

    it('returns fallback for unregistered tool', async () => {
      const pipeline = makePipeline([
        { toolId: 'nonexistent-tool', params: {}, outputKey: 'missing' }
      ])

      const result = await executePipeline(pipeline)
      expect(result['missing']).toContain('not registered')
    })

    it('executes serial pipeline steps in order with context passing', async () => {
      const callOrder: string[] = []
      const handler1: NodeHandler = {
        id: 'serial-step1',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockImplementation(async (ctx) => {
          callOrder.push('step1')
          return { response: 'from-step1' }
        })
      }
      const handler2: NodeHandler = {
        id: 'serial-step2',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockImplementation(async (ctx) => {
          callOrder.push('step2')
          expect(ctx.input._context).toBeDefined()
          return { response: 'from-step2' }
        })
      }
      registerHandler(handler1)
      registerHandler(handler2)

      const pipeline = makePipeline([
        { toolId: 'serial-step1', params: {}, outputKey: 'out1' },
        { toolId: 'serial-step2', params: {}, outputKey: 'out2' }
      ], 'serial')

      const result = await executePipeline(pipeline)
      expect(callOrder).toEqual(['step1', 'step2'])
      expect(result['out1']).toBe('from-step1')
      expect(result['out2']).toBe('from-step2')
    })

    it('saves and resumes from checkpoint', async () => {
      const handler: NodeHandler = {
        id: 'checkpoint-test',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockResolvedValue({ response: 'checkpointed' })
      }
      registerHandler(handler)

      const pipeline = makePipeline([
        { toolId: 'checkpoint-test', params: {}, outputKey: 'cp-step' }
      ])

      await executePipeline(pipeline, undefined, false)

      const cpData = vault.readCache('pipeline', 'holo-pipeline-checkpoints')
      if (cpData) {
        const checkpoints = JSON.parse(cpData)
        expect(checkpoints.length).toBe(0)
      }

      const handlerFail: NodeHandler = {
        id: 'checkpoint-fail',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockRejectedValue(new Error('boom'))
      }
      registerHandler(handlerFail)

      const failPipeline = makePipeline([
        { toolId: 'checkpoint-test', params: {}, outputKey: 'ok-step' },
        { toolId: 'checkpoint-fail', params: {}, outputKey: 'fail-step' }
      ])

      try { await executePipeline(failPipeline) } catch {}

      const cpAfterFail = vault.readCache('pipeline', 'holo-pipeline-checkpoints')
      if (cpAfterFail) {
        const parsed = JSON.parse(cpAfterFail)
        expect(parsed.length).toBe(1)
        expect(parsed[0].completedSteps).toContain('step-0')
      }
    })

    it('throws on DAG cycle', async () => {
      const pipeline: Pipeline = {
        id: 'cycle-pipe',
        name: 'Cycle',
        steps: [
          { toolId: 'l1-model-gateway', params: {}, outputKey: 'a' },
          { toolId: 'l1-model-gateway', params: {}, outputKey: 'b' }
        ],
        mode: 'serial',
        createdAt: Date.now(),
        attachedEntryIds: [],
        dagNodes: [
          { id: 'a', toolId: 'l1-model-gateway', toolName: '', toolLevel: 'L1', position: { x: 0, y: 0 }, params: {}, outputKey: 'a' },
          { id: 'b', toolId: 'l1-model-gateway', toolName: '', toolLevel: 'L1', position: { x: 100, y: 0 }, params: {}, outputKey: 'b' }
        ],
        dagEdges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' }
        ]
      }

      const pipeline2 = makePipeline([
        { toolId: 'l1-model-gateway', params: {}, outputKey: 'x' }
      ])

      const result = await executePipeline(pipeline2)
      expect(result['x']).toBeDefined()
    })

    it('handler receives gateway, memory, knowledge adapters', async () => {
      const handler: NodeHandler = {
        id: 'ctx-adapter-test',
        inputSchema: [],
        outputSchema: [{ name: 'response', type: 'string', required: true, description: '' }],
        run: vi.fn().mockImplementation(async (ctx) => {
          expect(ctx.gateway).toBeDefined()
          expect(ctx.gateway.chatCompletion).toBeDefined()
          expect(ctx.memory).toBeDefined()
          expect(ctx.knowledge).toBeDefined()
          expect(ctx.signal).toBeDefined()
          return { response: 'adapters ok' }
        })
      }
      registerHandler(handler)

      const pipeline = makePipeline([
        { toolId: 'ctx-adapter-test', params: {}, outputKey: 'adapter-check' }
      ])

      const result = await executePipeline(pipeline)
      expect(result['adapter-check']).toBe('adapters ok')
    })

    it('stringifies multi-key result objects', async () => {
      const handler: NodeHandler = {
        id: 'multi-key-test',
        inputSchema: [],
        outputSchema: [],
        run: vi.fn().mockResolvedValue({ a: 1, b: 'two' })
      }
      registerHandler(handler)

      const pipeline = makePipeline([
        { toolId: 'multi-key-test', params: {}, outputKey: 'multi' }
      ])

      const result = await executePipeline(pipeline)
      expect(result['multi']).toBe('{"a":1,"b":"two"}')
    })

    it('returns sole value for single-key non-response results', async () => {
      const handler: NodeHandler = {
        id: 'sole-key-test',
        inputSchema: [],
        outputSchema: [{ name: 'results', type: 'array', required: true, description: '' }],
        run: vi.fn().mockResolvedValue({ results: 'plain text result' })
      }
      registerHandler(handler)

      const pipeline = makePipeline([
        { toolId: 'sole-key-test', params: {}, outputKey: 'sole' }
      ])

      const result = await executePipeline(pipeline)
      expect(result['sole']).toBe('plain text result')
    })
  })

  describe('built-in handlers', () => {
    it('l1-model-gateway returns response', async () => {
      mockGateway.chatCompletion.mockResolvedValueOnce('test response')
      const handler = getHandler('l1-model-gateway')!
      const result = await handler.run({
        input: { prompt: 'hello' },
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        gateway: mockGateway,
        memory: {} as any,
        knowledge: {} as any
      })
      expect(result.response).toBeDefined()
    })

    it('l1-model-gateway skips empty prompt', async () => {
      const handler = getHandler('l1-model-gateway')!
      const result = await handler.run({
        input: { prompt: '   ' },
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        gateway: { chatCompletion: vi.fn() } as any,
        memory: {} as any,
        knowledge: {} as any
      })
      expect(result.response).toContain('无有效输入')
    })

    it('l1-knowledge-feeder handler exists and has correct schema', () => {
      const handler = getHandler('l1-knowledge-feeder')!
      expect(handler.id).toBe('l1-knowledge-feeder')
      expect(handler.inputSchema).toBeDefined()
      expect(handler.outputSchema).toBeDefined()
    })

    it('l1-result-beautifier handler exists and has correct schema', () => {
      const handler = getHandler('l1-result-beautifier')!
      expect(handler.id).toBe('l1-result-beautifier')
      expect(handler.inputSchema).toBeDefined()
      expect(handler.outputSchema).toBeDefined()
    })

    it('l1-workspace-memory handler exists and has correct schema', () => {
      const handler = getHandler('l1-workspace-memory')!
      expect(handler.id).toBe('l1-workspace-memory')
      expect(handler.inputSchema).toBeDefined()
      expect(handler.outputSchema).toBeDefined()
    })
  })
})
