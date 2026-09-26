import { describe, it, expect } from 'vitest'
import { buildCanvasPipeline } from '@/services/canvasRun'

/**
 * H-1 验收：流水线窗口「运行当前画布」的载荷必须带上 dagNodes/dagEdges，
 * 否则 pipelineExecutor 里那段按 dagEdges 做拓扑排序的分支永不可达
 * （原 App.vue 只映射 steps 并写死 mode:'serial'，用户连的依赖边被丢弃）。
 */
describe('H-1: 画布运行载荷 → Pipeline（保留 dagEdges）', () => {
  it('保留 dagEdges/dagNodes，且与 steps 一一对应（执行器 DAG 分支的前置条件）', () => {
    const p = buildCanvasPipeline({
      nodes: [
        { id: 'n0', toolId: 't-a', toolName: 'A', params: {}, outputKey: 't-a' },
        { id: 'n1', toolId: 't-b', toolName: 'B', params: {}, outputKey: 't-b' },
        { id: 'n2', toolId: 't-c', toolName: 'C', params: {}, outputKey: 't-c' },
      ],
      edges: [{ id: 'e0', sourceNodeId: 'n0', sourceOutputKey: 'k', targetNodeId: 'n2', targetParamName: 'in' }],
    })
    expect(p).not.toBeNull()
    expect(p!.steps.map(s => s.toolId)).toEqual(['t-a', 't-b', 't-c'])
    expect(p!.dagNodes?.map(n => n.id)).toEqual(['n0', 'n1', 'n2'])
    expect(p!.dagNodes?.length).toBe(p!.steps.length)
    expect(p!.dagEdges?.length).toBe(1)
    expect(p!.dagEdges?.[0].sourceNodeId).toBe('n0')
    expect(p!.dagEdges?.[0].targetNodeId).toBe('n2')
  })

  it('无连线时 dagEdges 为空数组（执行器回退 steps 数组序）', () => {
    const p = buildCanvasPipeline({ nodes: [{ id: 'n0', toolId: 't-a' }] })
    expect(p).not.toBeNull()
    expect(p!.dagEdges).toEqual([])
    expect(p!.steps.length).toBe(1)
  })

  it('空节点返回 null（不发出空运行）', () => {
    expect(buildCanvasPipeline({ nodes: [] })).toBeNull()
  })
})
