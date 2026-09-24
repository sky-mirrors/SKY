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
    key: (i: number) => Object.keys(store)[i] ?? null,
  })
}

// 拓扑节点 id 无版本后缀（与 src/data/topology.ts 真实形态一致）
vi.mock('@/data/topology', () => ({
  generateAllNodes: () => [
    { id: 'l2-file-creator', level: 'L2', name: '文件创建器', position: { x: 0, y: 0 }, enabled: true, locked: false, gravityWeight: 1, jobRoles: [], description: 'x' },
  ],
  buildAdjacencyMap: (nodes: Array<{ id: string }>) => Object.fromEntries(nodes.map(n => [n.id, []])),
  getJobRoleTemplates: () => [],
}))

import { useNodeStore } from '@/stores/nodeStore'

// manifest id 带版本后缀（与 src/data/l2Manifests.ts 真实形态一致）
const manifest = {
  identity: { id: 'l2-file-creator-v1', name: '文件创建器' },
  routing: { retrievalSummary: '创建 docx 文件', keywords: ['文件'] },
  cacheMeta: { estimatedTokenSaving: 100 },
} as never

describe('H-2: L2 manifest id 命名空间归一（拓扑 id 无 -v1 / manifest id 带 -v1）', () => {
  beforeEach(() => {
    mockLocalStorage()
    setActivePinia(createPinia())
  })

  it('用拓扑节点 id（无 -v1）能取到带 -v1 的 manifest', () => {
    const store = useNodeStore()
    store.loadL2Manifests([manifest])
    expect(store.getL2Manifest('l2-file-creator')).not.toBeNull()
  })

  it('用原始 manifest id（带 -v1）同样能取到', () => {
    const store = useNodeStore()
    store.loadL2Manifests([manifest])
    expect(store.getL2Manifest('l2-file-creator-v1')).not.toBeNull()
  })

  it('索引不产生重复条目（getAllL2Manifests 数量 = 载入数）', () => {
    const store = useNodeStore()
    store.loadL2Manifests([manifest])
    expect(store.getAllL2Manifests()).toHaveLength(1)
  })

  it('未知 id 返回 null', () => {
    const store = useNodeStore()
    store.loadL2Manifests([manifest])
    expect(store.getL2Manifest('l2-nope')).toBeNull()
  })
})
