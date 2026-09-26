import type { Pipeline, PipelineStep, DagNode, DagEdge } from '@/models'

/** 流水线窗口「运行当前画布」发送的节点载荷（见 electron\preload.ts 的 pipelineRunRequest） */
export interface CanvasRunNode {
  id: string
  toolId: string
  toolName?: string
  params?: Record<string, string>
  outputKey?: string
}

export interface CanvasRunPayload {
  nodes: CanvasRunNode[]
  edges?: unknown[]
}

/**
 * H-1：把流水线窗口「运行当前画布」的载荷转成 Pipeline。
 *
 * 关键点：必须把 dagNodes / dagEdges 一并带上——pipelineExecutor 的 DAG 分支要求
 * `pipeline.dagNodes.length === pipeline.steps.length && pipeline.dagEdges.length > 0`
 * 才会按用户连的依赖边做拓扑排序。原 App.vue 只映射 steps 并写死 mode:'serial'，
 * 那段分支因此**永不可达**，画布上连的依赖边与实际执行顺序完全脱钩。
 *
 * dagNodes 必须与 steps **同序**：执行器用 dagNodes 的下标把边的 source/target
 * 还原成 `step-N` 依赖（见 pipelineExecutor）。无连线时 dagEdges 为空数组
 * ⇒ 执行器回退到 steps 数组序（画布发送前已按拓扑序排过）。
 *
 * 空载荷返回 null，调用方据此不发空运行。
 */
export function buildCanvasPipeline(payload: CanvasRunPayload): Pipeline | null {
  const nodes = payload?.nodes
  if (!Array.isArray(nodes) || nodes.length === 0) return null

  const paramsOf = (n: CanvasRunNode): Record<string, string> =>
    n.params && typeof n.params === 'object' ? { ...n.params } : {}

  const steps: PipelineStep[] = nodes.map(n => ({
    toolId: n.toolId,
    params: paramsOf(n),
    outputKey: n.outputKey || n.toolId
  }))

  const dagNodes: DagNode[] = nodes.map((n, i) => ({
    id: n.id,
    toolId: n.toolId,
    toolName: n.toolName || n.toolId,
    toolLevel: 'L1',
    position: { x: 0, y: i },
    params: paramsOf(n),
    outputKey: n.outputKey || n.toolId
  }))

  const dagEdges: DagEdge[] = Array.isArray(payload.edges) ? (payload.edges as DagEdge[]) : []

  return {
    id: `canvas-run-${Date.now()}`,
    name: '画布运行',
    steps,
    mode: 'serial',
    createdAt: Date.now(),
    attachedEntryIds: [],
    dagNodes,
    dagEdges
  }
}
