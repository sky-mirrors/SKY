import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowLogStore } from '@/stores/workflowLogStore'
import { vault } from '@/vault'

describe('workflowLogStore', () => {
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

  it('starts with empty logs', () => {
    const store = useWorkflowLogStore()
    expect(store.logs).toEqual([])
  })

  it('createLog adds a new workflow log', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test Workflow', ['tool-a', 'tool-b'], [['tool-a', 'tool-b', 'data' as const]])
    expect(log.id).toBeDefined()
    expect(log.name).toBe('Test Workflow')
    expect(log.nodes.length).toBe(2)
    expect(log.edges.length).toBe(1)
    expect(log.status).toBe('running')
    expect(store.logs.length).toBe(1)
  })

  it('updateNodeStatus changes node status', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1'], [])
    store.updateNodeStatus(log.id, 'tool-1', 'running')
    expect(store.logs[0].nodes[0].status).toBe('running')
    store.updateNodeStatus(log.id, 'tool-1', 'completed', Date.now(), Date.now() + 100)
    expect(store.logs[0].nodes[0].status).toBe('completed')
  })

  it('addIoSnapshot records input/output', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1'], [])
    store.addIoSnapshot(log.id, 'tool-1', 'input data', 'output data')
    expect(store.logs[0].ioSnapshots.length).toBe(1)
    expect(store.logs[0].ioSnapshots[0].toolId).toBe('tool-1')
    expect(store.logs[0].ioSnapshots[0].input).toBe('input data')
    expect(store.logs[0].ioSnapshots[0].output).toBe('output data')
  })

  it('activateEdge marks an edge as activated', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1', 'tool-2'], [['tool-1', 'tool-2', 'data' as const]])
    store.activateEdge(log.id, 'tool-1', 'tool-2')
    expect(store.logs[0].edges[0].activatedAt).toBeDefined()
  })

  it('completeLog sets final status', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1'], [])
    store.completeLog(log.id, 'completed')
    expect(store.logs[0].status).toBe('completed')
    expect(store.logs[0].completedAt).toBeGreaterThan(0)
  })

  it('completeLog with failed status', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1'], [])
    store.completeLog(log.id, 'failed')
    expect(store.logs[0].status).toBe('failed')
  })

  it('getLog retrieves a log by id', () => {
    const store = useWorkflowLogStore()
    const log = store.createLog('Test', ['tool-1'], [])
    const retrieved = store.getLog(log.id)
    expect(retrieved).toBeDefined()
    expect(retrieved!.id).toBe(log.id)
  })

  it('getLog returns undefined for nonexistent id', () => {
    const store = useWorkflowLogStore()
    expect(store.getLog('nonexistent')).toBeUndefined()
  })

  it('loadFromStorage restores logs', () => {
    vault.writeCache('workflow', 'holo-workflow-logs', JSON.stringify([{
      id: 'wf-1', name: 'Restored', nodes: [], edges: [],
      timestamps: [], ioSnapshots: [], startedAt: Date.now(),
      completedAt: 0, status: 'running'
    }]))
    const store = useWorkflowLogStore()
    store.loadFromStorage()
    expect(store.logs.length).toBe(1)
    expect(store.logs[0].name).toBe('Restored')
  })
})
