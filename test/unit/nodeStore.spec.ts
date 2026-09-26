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
  getJobRoleTemplates: (role: string) => role === 'developer' ? ['l2-file-creator'] : []
}))

import { useNodeStore } from '@/stores/nodeStore'

function createStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return useNodeStore()
}

/**
 * 2026-09-26：125 节点 3D 星图删除后，nodeStore 只保留**有生产引用**的成员。
 * 原 spec 中针对星图专用状态（拖拽/重力/连线流/滤镜/L3 衰减/校验/节点视觉事件/
 * 星图 DAG 动画/连接流）的用例随成员一并删除——那些用例测的是已不存在的功能。
 */
describe('nodeStore（星图删除后保留的生产 API）', () => {
  let store: ReturnType<typeof useNodeStore>

  beforeEach(() => {
    mockLocalStorage()
    store = createStore()
  })

  describe('node level computeds', () => {
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

  describe('selectNode / selectedNode', () => {
    it('selects and deselects a node', () => {
      store.selectNode('l1-gateway')
      expect(store.selectedNode).not.toBeNull()
      expect(store.selectedNode!.id).toBe('l1-gateway')
      store.selectNode(null)
      expect(store.selectedNode).toBeNull()
    })
  })

  describe('L1 运行态（工作台 StatusBar 读）', () => {
    it('setL1Status 写入 l1WorkStatus 并在 success 后自动回落', () => {
      vi.useFakeTimers()
      try {
        store.setL1Status('l1-gateway', 'working')
        expect(store.l1WorkStatus['l1-gateway']).toBe('working')
        store.setL1Status('l1-gateway', 'success')
        expect(store.l1WorkStatus['l1-gateway']).toBe('success')
        vi.advanceTimersByTime(2100)
        expect(store.l1WorkStatus['l1-gateway']).toBe('idle')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('L2 manifests（路由经 node:get-l2-manifest 读）', () => {
    const manifest = {
      identity: { id: 'l2-file-creator-v1', name: 'FileCreator', version: '1.0' },
      routing: { keywords: ['file'], retrievalSummary: 'Creates files' },
      execution: {},
      cacheMeta: { estimatedTokenSaving: 500 }
    } as any

    it('loadL2Manifests 存储并被 getL2Manifest 取到（含去版本后缀归一化）', () => {
      store.loadL2Manifests([manifest])
      expect(store.getL2Manifest('l2-file-creator-v1')).not.toBeNull()
      // H-2：拓扑节点 id 不带版本后缀，也必须能取到
      expect(store.getL2Manifest('l2-file-creator')).not.toBeNull()
      expect(store.getAllL2Manifests().length).toBe(1)
    })

    it('loadL2Manifests 把摘要回填到同名节点', () => {
      store.loadL2Manifests([manifest])
      const node = store.nodes.find(n => n.id === 'l2-file-creator')
      expect(node?.description).toBe('Creates files')
    })
  })

  describe('getVisibleL2Ids（路由读）', () => {
    it('返回全部 L2 节点 id', () => {
      expect(store.getVisibleL2Ids()).toEqual(['l2-file-creator'])
    })
  })
})
