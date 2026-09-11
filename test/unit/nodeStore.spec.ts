import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

function mockLocalStorage() {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null
  })
  return store
}

vi.mock('@/data/topology', () => ({
  generateAllNodes: () => [
    { id: 'l0-core', level: 'L0', name: 'Core', position: { x: 0, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: [], description: 'Core node' },
    { id: 'l1-gateway', level: 'L1', name: 'Gateway', position: { x: 100, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: ['developer'], description: 'Gateway' },
    { id: 'l1-memory', level: 'L1', name: 'Memory', position: { x: 200, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: ['analyst'], description: 'Memory' },
    { id: 'l2-file-creator', level: 'L2', name: 'FileCreator', position: { x: 50, y: 100 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: ['developer'], description: 'File Creator', lastUsedAt: Date.now() },
    { id: 'l3-legacy', level: 'L3', name: 'Legacy', position: { x: 150, y: 200 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: [], description: 'Legacy tool', lastUsedAt: Date.now() - 40 * 86400000 }
  ],
  buildAdjacencyMap: (nodes: any[]) => {
    const map: Record<string, string[]> = {}
    for (const n of nodes) map[n.id] = nodes.filter((o: any) => o.id !== n.id && o.level !== n.level).map((o: any) => o.id)
    return map
  },
  getJobRoleTemplates: (role: string) => role === 'developer' ? ['l2-file-creator'] : []
}))

import { useNodeStore } from '@/stores/nodeStore'

function createStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return useNodeStore()
}

describe('nodeStore', () => {
  let store: ReturnType<typeof useNodeStore>

  beforeEach(() => {
    mockLocalStorage()
    store = createStore()
  })

  describe('node level computeds', () => {
    it('l0Node returns the L0 node', () => {
      expect(store.l0Node).not.toBeNull()
      expect(store.l0Node!.id).toBe('l0-core')
    })

    it('l1Nodes returns L1 nodes', () => {
      expect(store.l1Nodes.length).toBe(2)
      expect(store.l1Nodes.every(n => n.level === 'L1')).toBe(true)
    })

    it('l2Nodes returns L2 nodes', () => {
      expect(store.l2Nodes.length).toBe(1)
      expect(store.l2Nodes[0].id).toBe('l2-file-creator')
    })

    it('l3Nodes returns L3 nodes', () => {
      expect(store.l3Nodes.length).toBe(1)
    })
  })

  describe('selectNode / hoverNode', () => {
    it('selects and deselects a node', () => {
      store.selectNode('l1-gateway')
      expect(store.selectedNode).not.toBeNull()
      expect(store.selectedNode!.id).toBe('l1-gateway')
      store.selectNode(null)
      expect(store.selectedNode).toBeNull()
    })

    it('hovers a node', () => {
      store.hoverNode('l1-memory')
      expect(store.hoveredNode).not.toBeNull()
      expect(store.hoveredNode!.id).toBe('l1-memory')
    })
  })

  describe('drag', () => {
    it('startDrag and endDrag update interaction state', () => {
      store.startDrag('l1-gateway')
      expect(store.interaction.isDragging).toBe(true)
      expect(store.interaction.draggingNodeId).toBe('l1-gateway')
      store.endDrag()
      expect(store.interaction.isDragging).toBe(false)
      expect(store.interaction.draggingNodeId).toBeNull()
    })
  })

  describe('swapLevels', () => {
    it('swaps L2 and L1 node levels', () => {
      const l2Node = store.nodes.find(n => n.id === 'l2-file-creator')!
      const l1Node = store.nodes.find(n => n.id === 'l1-gateway')!
      expect(l2Node.level).toBe('L2')
      expect(l1Node.level).toBe('L1')
      store.swapLevels('l2-file-creator', 'l1-gateway')
      expect(l2Node.level).toBe('L1')
      expect(l1Node.level).toBe('L2')
      expect(l2Node.locked).toBe(true)
    })
  })

  describe('lockL2Tool / unlockL2Tool', () => {
    it('locks and unlocks an L2 node', () => {
      store.lockL2Tool('l2-file-creator')
      const node = store.nodes.find(n => n.id === 'l2-file-creator')!
      expect(node.locked).toBe(true)
      store.unlockL2Tool('l2-file-creator')
      expect(node.locked).toBe(false)
    })

    it('lockL2Tool ignores non-L2 nodes', () => {
      const node = store.nodes.find(n => n.id === 'l1-gateway')!
      const origLocked = node.locked
      store.lockL2Tool('l1-gateway')
      expect(node.locked).toBe(origLocked)
    })
  })

  describe('L1 status', () => {
    it('setL1Status and getL1Status', () => {
      store.setL1Status('l1-gateway', 'working')
      expect(store.getL1Status('l1-gateway')).toBe('working')
      expect(store.consumeL1Flashes()).toContain('l1-gateway')
      expect(store.consumeL1Flashes()).toEqual([])
    })

    it('consumeL1Flashes returns all queued flashes', () => {
      store.setL1Status('l1-gateway', 'success')
      store.setL1Status('l1-memory', 'working')
      const flashes = store.consumeL1Flashes()
      expect(flashes.length).toBe(2)
    })

    it('markTaskChainComplete and consumeTaskChainComplete', () => {
      store.markTaskChainComplete()
      expect(store.consumeTaskChainComplete()).toBe(true)
      expect(store.consumeTaskChainComplete()).toBe(false)
    })
  })

  describe('DAG chain', () => {
    it('setDAGChain and updateDAGStep', () => {
      store.setDAGChain([{ nodeId: 'l1-gateway', stepNum: 1, status: 'pending' }])
      store.updateDAGStep(1, 'running')
      const updates = store.consumeDAGChainUpdate()
      expect(updates.length).toBe(1)
      expect(updates[0].status).toBe('running')
    })

    it('clearDAGChain resets state', () => {
      store.setDAGChain([{ nodeId: 'l1-gateway', stepNum: 1, status: 'pending' }])
      store.clearDAGChain()
      expect(store.consumeDAGChainUpdate()).toEqual([])
    })
  })

  describe('filters', () => {
    it('toggleLevelFilter adds and removes level', () => {
      store.toggleLevelFilter('L1')
      expect(store.levelFilter).toContain('L1')
      store.toggleLevelFilter('L1')
      expect(store.levelFilter).not.toContain('L1')
    })

    it('toggleRoleFilter adds and removes role', () => {
      store.toggleRoleFilter('developer')
      expect(store.roleFilter).toContain('developer')
    })

    it('clearFilters resets both', () => {
      store.toggleLevelFilter('L1')
      store.toggleRoleFilter('developer')
      store.clearFilters()
      expect(store.levelFilter).toEqual([])
      expect(store.roleFilter).toEqual([])
    })

    it('filteredNodes respects levelFilter', () => {
      store.toggleLevelFilter('L0')
      expect(store.filteredNodes.every(n => n.level === 'L0')).toBe(true)
    })
  })

  describe('validateSchema', () => {
    it('validates required fields', () => {
      const result = store.validateSchema('{}', [{ name: 'query', type: 'string', required: true, description: '' }])
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required field: query')
    })

    it('validates types', () => {
      const result = store.validateSchema('{"count":"not-a-number"}', [{ name: 'count', type: 'number', required: true, description: '' }])
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('expected number')
    })

    it('passes valid data', () => {
      const result = store.validateSchema('{"query":"hello"}', [{ name: 'query', type: 'string', required: true, description: '' }])
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('returns error for invalid JSON', () => {
      const result = store.validateSchema('not-json', [{ name: 'x', type: 'string', required: true, description: '' }])
      expect(result.valid).toBe(false)
    })
  })

  describe('history', () => {
    it('addHistoryEntry adds entries', () => {
      store.addHistoryEntry({ action: 'test', toolId: 'l1-gateway', timestamp: Date.now() })
      expect(store.history.length).toBe(1)
    })

    it('caps history at 50', () => {
      for (let i = 0; i < 55; i++) {
        store.addHistoryEntry({ action: `action-${i}`, toolId: 'l1-gateway', timestamp: Date.now() })
      }
      expect(store.history.length).toBe(50)
    })
  })

  describe('connectionFlows', () => {
    it('addConnectionFlow and removeConnectionFlow', () => {
      store.addConnectionFlow('l0-core', 'l1-gateway', 'data', true)
      expect(store.connectionFlows.length).toBe(1)
      store.removeConnectionFlow('l0-core', 'l1-gateway')
      expect(store.connectionFlows.length).toBe(0)
    })

    it('addConnectionFlow updates existing flow', () => {
      store.addConnectionFlow('l0-core', 'l1-gateway', 'data', false)
      store.addConnectionFlow('l0-core', 'l1-gateway', 'control', true)
      expect(store.connectionFlows.length).toBe(1)
      expect(store.connectionFlows[0].type).toBe('control')
    })

    it('setConnectionFlowRunning', () => {
      store.addConnectionFlow('l0-core', 'l1-gateway')
      store.setConnectionFlowRunning('l0-core', 'l1-gateway', true)
      expect(store.connectionFlows[0].isRunning).toBe(true)
    })
  })

  describe('L3 decay', () => {
    it('initL3DecayStates initializes states', () => {
      store.initL3DecayStates()
      expect(store.l3DecayStates.length).toBe(1)
      expect(store.l3DecayStates[0].nodeId).toBe('l3-legacy')
      expect(store.l3DecayStates[0].isCollapsed).toBe(true)
    })

    it('reviveL3Node resets collapse', () => {
      store.initL3DecayStates()
      store.reviveL3Node('l3-legacy')
      const state = store.l3DecayStates.find(s => s.nodeId === 'l3-legacy')
      expect(state!.isCollapsed).toBe(false)
      expect(state!.daysUntilCollapse).toBe(30)
    })

    it('anchorL3Node sets permanent', () => {
      store.initL3DecayStates()
      store.anchorL3Node('l3-legacy')
      const state = store.l3DecayStates.find(s => s.nodeId === 'l3-legacy')
      expect(state!.daysUntilCollapse).toBe(999)
      expect(state!.isCollapsed).toBe(false)
    })
  })

  describe('L2 manifests', () => {
    it('loadL2Manifests stores manifests', () => {
      const manifest = {
        identity: { id: 'l2-file-creator', name: 'FileCreator', version: '1.0' },
        routing: { keywords: ['file'], retrievalSummary: 'Creates files' },
        execution: {},
        cacheMeta: { estimatedTokenSaving: 500 }
      } as any
      store.loadL2Manifests([manifest])
      expect(store.getL2Manifest('l2-file-creator')).not.toBeNull()
      expect(store.getL2ManifestByName('FileCreator')).not.toBeNull()
    })

    it('findManifestByKeywords matches keyword', () => {
      const manifest = {
        identity: { id: 'l2-file-creator', name: 'FileCreator', version: '1.0' },
        routing: { keywords: ['file', 'create'], retrievalSummary: 'Creates files' },
        execution: {},
        cacheMeta: { estimatedTokenSaving: 500 }
      } as any
      store.loadL2Manifests([manifest])
      expect(store.findManifestByKeywords('file')).not.toBeNull()
      expect(store.findManifestByKeywords('nonexistent')).toBeNull()
    })
  })

  describe('circuit breaker', () => {
    it('updateCircuitBreaker sets state', () => {
      store.updateCircuitBreaker({ isOpen: true, failureCount: 5 })
      expect(store.interaction.circuitBreaker.isOpen).toBe(true)
      expect(store.interaction.l0RedFlash).toBe(true)
    })
  })

  describe('gravity weight', () => {
    it('setGravityWeight clamps between 0.1 and 5', () => {
      store.setGravityWeight('l1-gateway', 10)
      const node = store.nodes.find(n => n.id === 'l1-gateway')!
      expect(node.gravityWeight).toBe(5)
      store.setGravityWeight('l1-gateway', -1)
      expect(node.gravityWeight).toBe(0.1)
    })
  })
})
