import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePipelineStore, registerPipelineExecutor } from '@/stores/pipelineStore'
import { vault } from '@/vault'

describe('pipelineStore', () => {
  beforeEach(() => {
    vault.clearCache()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([]),
      }
    })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with empty pipelines', () => {
    const store = usePipelineStore()
    expect(store.pipelines).toEqual([])
    expect(store.runningPipelineId).toBeNull()
  })

  it('createPipeline adds a new pipeline', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('Test Pipeline', [
      { toolId: 'tool-1', params: { input: 'test' }, outputKey: 'step1' }
    ])
    expect(pipeline.id).toBeDefined()
    expect(pipeline.name).toBe('Test Pipeline')
    expect(pipeline.steps.length).toBe(1)
    expect(pipeline.mode).toBe('serial')
    expect(store.pipelines.length).toBe(1)
  })

  it('createPipeline with parallel mode', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('Parallel Test', [], 'parallel')
    expect(pipeline.mode).toBe('parallel')
  })

  it('removePipeline deletes pipeline', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('To Remove', [])
    expect(store.pipelines.length).toBe(1)
    store.removePipeline(pipeline.id)
    expect(store.pipelines.length).toBe(0)
  })

  it('bindSession and unbindSession manage session binding', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('Session Test', [])
    store.bindSession(pipeline.id, 'session-1')
    expect(store.pipelines[0].sessionId).toBe('session-1')
    store.unbindSession(pipeline.id)
    expect(store.pipelines[0].sessionId).toBeUndefined()
  })

  it('addPipelineEntry and removePipelineEntry manage entries', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('Entry Test', [])
    store.addPipelineEntry(pipeline.id, 'entry-1')
    expect(store.pipelines[0].attachedEntryIds).toContain('entry-1')
    store.removePipelineEntry(pipeline.id, 'entry-1')
    expect(store.pipelines[0].attachedEntryIds).not.toContain('entry-1')
  })

  it('addDagNode adds a DAG node', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('DAG Test', [])
    store.addDagNode(pipeline.id, {
      id: 'dn-1', toolId: 'tool-1', toolName: 'Tool 1', toolLevel: 'L2',
      position: { x: 0, y: 0 }, params: {}, outputKey: 'out1'
    })
    expect(store.pipelines[0].dagNodes!.length).toBe(1)
  })

  it('updateDagNode updates node properties', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('DAG Test', [])
    store.addDagNode(pipeline.id, {
      id: 'dn-1', toolId: 'tool-1', toolName: 'Tool 1', toolLevel: 'L2',
      position: { x: 0, y: 0 }, params: {}, outputKey: 'out1'
    })
    store.updateDagNode(pipeline.id, 'dn-1', { params: { key: 'value' } })
    expect(store.pipelines[0].dagNodes![0].params).toEqual({ key: 'value' })
  })

  it('removeDagNode deletes a DAG node', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('DAG Test', [])
    store.addDagNode(pipeline.id, {
      id: 'dn-1', toolId: 'tool-1', toolName: 'Tool 1', toolLevel: 'L2',
      position: { x: 0, y: 0 }, params: {}, outputKey: 'out1'
    })
    store.removeDagNode(pipeline.id, 'dn-1')
    expect(store.pipelines[0].dagNodes!.length).toBe(0)
  })

  it('addDagEdge and removeDagEdge manage DAG edges', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('DAG Test', [])
    store.addDagEdge(pipeline.id, {
      id: 'de-1', sourceNodeId: 'dn-1', sourceOutputKey: 'out1',
      targetNodeId: 'dn-2', targetParamName: 'input'
    })
    expect(store.pipelines[0].dagEdges!.length).toBe(1)
    store.removeDagEdge(pipeline.id, 'de-1')
    expect(store.pipelines[0].dagEdges!.length).toBe(0)
  })

  it('setActiveDagPipeline sets active DAG pipeline', () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('DAG Test', [])
    store.setActiveDagPipeline(pipeline.id)
    expect(store.activeDagPipelineId).toBe(pipeline.id)
    store.setActiveDagPipeline(null)
    expect(store.activeDagPipelineId).toBeNull()
  })

  it('registerPipelineExecutor registers a function', () => {
    const mockExecutor = vi.fn().mockResolvedValue({ step1: 'result' })
    registerPipelineExecutor(mockExecutor)
  })

  it('saveToStorage persists pipelines', () => {
    const store = usePipelineStore()
    store.createPipeline('Persist Test', [])
    store.saveToStorage()
    const saved = JSON.parse(vault.readCache('pipeline', 'holo-pipelines') || '[]')
    expect(saved.length).toBe(1)
  })

  it('loadFromStorage restores pipelines', () => {
    vault.writeCache('pipeline', 'holo-pipelines', JSON.stringify([{
      id: 'p1', name: 'Restored', steps: [], mode: 'serial',
      createdAt: Date.now(), attachedEntryIds: []
    }]))
    const store = usePipelineStore()
    store.loadFromStorage()
    expect(store.pipelines.length).toBe(1)
    expect(store.pipelines[0].name).toBe('Restored')
  })

  it('startPipeline with registered executor runs pipeline', async () => {
    const store = usePipelineStore()
    const pipeline = store.createPipeline('Run Test', [
      { toolId: 'tool-1', params: {}, outputKey: 'step1' }
    ])
    registerPipelineExecutor(vi.fn().mockResolvedValue({ step1: 'done' }))
    await store.startPipeline(pipeline.id)
  })
})
