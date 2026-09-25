import { ref, reactive, Ref, onBeforeUnmount, getCurrentInstance } from 'vue'
import { DagNode, DagEdge } from '@/models'

interface Point { x: number; y: number }

type InteractionMode = 'idle' | 'dragging_node' | 'drawing_edge' | 'panning'

const NODE_W = 180
const NODE_H = 60
const PORT_R = 6
const GRID_SIZE = 20
const LAYER_GAP_X = 240
const NODE_GAP_Y = 80

export function useDagEngine(canvasRef: Ref<HTMLCanvasElement | null>) {
  const nodes = ref<DagNode[]>([])
  const edges = ref<DagEdge[]>([])
  const selectedNodeId = ref<string | null>(null)
  const selectedEdgeId = ref<string | null>(null)
  const mode = ref<InteractionMode>('idle')
  const offset = reactive<Point>({ x: 0, y: 0 })
  const scale = ref(1)

  let dragNodeId: string | null = null
  let dragStart: Point | null = null
  let dragNodeStart: Point | null = null
  let edgeSourceNodeId: string | null = null
  let edgeSourcePort: string | null = null
  let tempEdgeEnd: Point | null = null
  let panStart: Point | null = null
  let panOffsetStart: Point | null = null
  let animFrameId = 0
  let needsRender = false

  function screenToCanvas(sx: number, sy: number): Point {
    const canvas = canvasRef.value
    if (!canvas) return { x: sx, y: sy }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (sx - rect.left - offset.x) / scale.value,
      y: (sy - rect.top - offset.y) / scale.value
    }
  }

  function hitTestNode(cx: number, cy: number): DagNode | null {
    for (let i = nodes.value.length - 1; i >= 0; i--) {
      const n = nodes.value[i]
      if (cx >= n.position.x && cx <= n.position.x + NODE_W &&
          cy >= n.position.y && cy <= n.position.y + NODE_H) {
        return n
      }
    }
    return null
  }

  function hitTestOutputPort(cx: number, cy: number): { nodeId: string; key: string } | null {
    for (const n of nodes.value) {
      const px = n.position.x + NODE_W
      const py = n.position.y + NODE_H / 2
      const dist = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2)
      if (dist <= PORT_R + 4) return { nodeId: n.id, key: n.outputKey }
    }
    return null
  }

  function hitTestInputPort(cx: number, cy: number): string | null {
    for (const n of nodes.value) {
      const px = n.position.x
      const py = n.position.y + NODE_H / 2
      const dist = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2)
      if (dist <= PORT_R + 4) return n.id
    }
    return null
  }

  function hitTestEdge(cx: number, cy: number): DagEdge | null {
    for (const e of edges.value) {
      const src = nodes.value.find(n => n.id === e.sourceNodeId)
      const tgt = nodes.value.find(n => n.id === e.targetNodeId)
      if (!src || !tgt) continue
      const sx = src.position.x + NODE_W
      const sy = src.position.y + NODE_H / 2
      const tx = tgt.position.x
      const ty = tgt.position.y + NODE_H / 2
      const cp1x = sx + (tx - sx) * 0.5
      const cp1y = sy
      const cp2x = sx + (tx - sx) * 0.5
      const cp2y = ty
      for (let t = 0; t <= 1; t += 0.05) {
        const it = 1 - t
        const bx = it * it * it * sx + 3 * it * it * t * cp1x + 3 * it * t * t * cp2x + t * t * t * tx
        const by = it * it * it * sy + 3 * it * it * t * cp1y + 3 * it * t * t * cp2y + t * t * t * ty
        const d = Math.sqrt((cx - bx) ** 2 + (cy - by) ** 2)
        if (d < 8) return e
      }
    }
    return null
  }

  function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.strokeStyle = 'rgba(60, 80, 120, 0.15)'
    ctx.lineWidth = 1
    const gs = GRID_SIZE * scale.value
    const ox = offset.x % gs
    const oy = offset.y % gs
    for (let x = ox; x < w; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
    }
    for (let y = oy; y < h; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
  }

  function levelColor(level: string): string {
    switch (level) {
      case 'L1': return '#44aaff'
      case 'L2': return '#00e5ff'
      case 'L3': return '#ff66aa'
      case 'skill': return '#ffaa44'
      case 'mcp': return '#aa66ff'
      default: return '#667788'
    }
  }

  function statusColor(status?: string): string {
    switch (status) {
      case 'running': return '#ffcc44'
      case 'done': return '#44ff88'
      case 'failed': return '#ff4444'
      case 'skipped': return '#888888'
      default: return 'transparent'
    }
  }

  function drawNode(ctx: CanvasRenderingContext2D, node: DagNode) {
    const x = node.position.x * scale.value + offset.x
    const y = node.position.y * scale.value + offset.y
    const w = NODE_W * scale.value
    const h = NODE_H * scale.value
    const r = 8 * scale.value
    const isSelected = selectedNodeId.value === node.id
    const col = levelColor(node.toolLevel)

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + r)
    ctx.lineTo(x + w, y + h - r)
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    ctx.lineTo(x + r, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()

    ctx.fillStyle = isSelected ? 'rgba(20, 40, 70, 0.95)' : 'rgba(12, 20, 40, 0.9)'
    ctx.fill()
    ctx.strokeStyle = isSelected ? col : 'rgba(80, 120, 180, 0.4)'
    ctx.lineWidth = isSelected ? 2 : 1
    ctx.stroke()

    const stCol = statusColor(node.status)
    if (stCol !== 'transparent') {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, 4 * scale.value, h)
      ctx.clip()
      ctx.fillStyle = stCol
      ctx.fillRect(x, y, 4 * scale.value, h)
      ctx.restore()
    }

    ctx.fillStyle = col
    ctx.font = `${10 * scale.value}px "Segoe UI", "Microsoft YaHei", sans-serif`
    const badge = `[${node.toolLevel}]`
    ctx.fillText(badge, x + 8 * scale.value, y + 16 * scale.value)

    ctx.fillStyle = '#e0e8f0'
    ctx.font = `${12 * scale.value}px "Segoe UI", "Microsoft YaHei", sans-serif`
    const name = node.toolName.length > 14 ? node.toolName.substring(0, 13) + '…' : node.toolName
    ctx.fillText(name, x + 8 * scale.value, y + 36 * scale.value)

    ctx.fillStyle = 'rgba(100, 140, 180, 0.5)'
    ctx.font = `${9 * scale.value}px monospace`
    ctx.fillText(node.outputKey || 'out', x + 8 * scale.value, y + 52 * scale.value)

    ctx.restore()

    const ipx = x
    const ipy = y + h / 2
    ctx.beginPath()
    ctx.arc(ipx, ipy, PORT_R * scale.value, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(80, 160, 220, 0.6)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(120, 180, 240, 0.8)'
    ctx.lineWidth = 1
    ctx.stroke()

    const opx = x + w
    const opy = y + h / 2
    ctx.beginPath()
    ctx.arc(opx, opy, PORT_R * scale.value, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(80, 220, 160, 0.6)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(120, 240, 180, 0.8)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  function drawEdge(ctx: CanvasRenderingContext2D, edge: DagEdge) {
    const src = nodes.value.find(n => n.id === edge.sourceNodeId)
    const tgt = nodes.value.find(n => n.id === edge.targetNodeId)
    if (!src || !tgt) return

    const sx = (src.position.x + NODE_W) * scale.value + offset.x
    const sy = (src.position.y + NODE_H / 2) * scale.value + offset.y
    const tx = tgt.position.x * scale.value + offset.x
    const ty = (tgt.position.y + NODE_H / 2) * scale.value + offset.y
    const dx = tx - sx
    const cp1x = sx + dx * 0.5
    const cp1y = sy
    const cp2x = sx + dx * 0.5
    const cp2y = ty

    const isSelected = selectedEdgeId.value === edge.id
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, tx, ty)
    ctx.strokeStyle = isSelected ? 'rgba(100, 220, 180, 0.9)' : 'rgba(60, 120, 180, 0.5)'
    ctx.lineWidth = isSelected ? 2.5 : 1.5
    ctx.stroke()

    const angle = Math.atan2(ty - cp2y, tx - cp2x)
    const arrowLen = 10 * scale.value
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(tx - arrowLen * Math.cos(angle - 0.4), ty - arrowLen * Math.sin(angle - 0.4))
    ctx.lineTo(tx - arrowLen * Math.cos(angle + 0.4), ty - arrowLen * Math.sin(angle + 0.4))
    ctx.closePath()
    ctx.fillStyle = isSelected ? 'rgba(100, 220, 180, 0.9)' : 'rgba(60, 120, 180, 0.5)'
    ctx.fill()
  }

  function drawTempEdge(ctx: CanvasRenderingContext2D) {
    if (!edgeSourceNodeId || !tempEdgeEnd) return
    const src = nodes.value.find(n => n.id === edgeSourceNodeId)
    if (!src) return
    const sx = (src.position.x + NODE_W) * scale.value + offset.x
    const sy = (src.position.y + NODE_H / 2) * scale.value + offset.y
    const tx = tempEdgeEnd.x
    const ty = tempEdgeEnd.y
    const dx = tx - sx
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.bezierCurveTo(sx + dx * 0.5, sy, sx + dx * 0.5, ty, tx, ty)
    ctx.strokeStyle = 'rgba(100, 220, 180, 0.6)'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }

  function render() {
    const canvas = canvasRef.value
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    drawGrid(ctx, w, h)
    for (const e of edges.value) drawEdge(ctx, e)
    for (const n of nodes.value) drawNode(ctx, n)
    if (mode.value === 'drawing_edge') drawTempEdge(ctx)
  }

  function scheduleRender() {
    if (!needsRender) {
      needsRender = true
      animFrameId = requestAnimationFrame(() => {
        render()
        needsRender = false
      })
    }
  }

  function resize() {
    const canvas = canvasRef.value
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    canvas.width = parent.clientWidth
    canvas.height = parent.clientHeight
    scheduleRender()
  }

  function onMouseDown(e: MouseEvent) {
    const cp = screenToCanvas(e.clientX, e.clientY)

    const op = hitTestOutputPort(cp.x, cp.y)
    if (op) {
      mode.value = 'drawing_edge'
      edgeSourceNodeId = op.nodeId
      edgeSourcePort = op.key
      const rect = canvasRef.value?.getBoundingClientRect()
      tempEdgeEnd = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
      return
    }

    const node = hitTestNode(cp.x, cp.y)
    if (node) {
      selectedNodeId.value = node.id
      selectedEdgeId.value = null
      mode.value = 'dragging_node'
      dragNodeId = node.id
      dragStart = cp
      dragNodeStart = { x: node.position.x, y: node.position.y }
      scheduleRender()
      return
    }

    const edge = hitTestEdge(cp.x, cp.y)
    if (edge) {
      selectedEdgeId.value = edge.id
      selectedNodeId.value = null
      scheduleRender()
      return
    }

    selectedNodeId.value = null
    selectedEdgeId.value = null
    mode.value = 'panning'
    panStart = { x: e.clientX, y: e.clientY }
    panOffsetStart = { x: offset.x, y: offset.y }
    scheduleRender()
  }

  function onMouseMove(e: MouseEvent) {
    if (mode.value === 'dragging_node' && dragNodeId && dragStart && dragNodeStart) {
      const cp = screenToCanvas(e.clientX, e.clientY)
      const node = nodes.value.find(n => n.id === dragNodeId)
      if (node) {
        node.position.x = dragNodeStart.x + (cp.x - dragStart.x)
        node.position.y = dragNodeStart.y + (cp.y - dragStart.y)
        scheduleRender()
      }
    } else if (mode.value === 'drawing_edge') {
      const rect = canvasRef.value?.getBoundingClientRect()
      tempEdgeEnd = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
      scheduleRender()
    } else if (mode.value === 'panning' && panStart && panOffsetStart) {
      offset.x = panOffsetStart.x + (e.clientX - panStart.x)
      offset.y = panOffsetStart.y + (e.clientY - panStart.y)
      scheduleRender()
    }
  }

  function onMouseUp(e: MouseEvent) {
    if (mode.value === 'drawing_edge' && edgeSourceNodeId) {
      const cp = screenToCanvas(e.clientX, e.clientY)
      const tgtId = hitTestInputPort(cp.x, cp.y)
      if (tgtId && tgtId !== edgeSourceNodeId) {
        const existing = edges.value.find(
          ed => ed.sourceNodeId === edgeSourceNodeId && ed.targetNodeId === tgtId
        )
        // D-10：画布禁止画环——原实现允许连成环，保存宏时环上节点被拓扑排序
        // 静默丢弃且无任何警告
        if (!existing && !wouldCreateCycle(edgeSourceNodeId, tgtId)) {
          const edge: DagEdge = {
            id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sourceNodeId: edgeSourceNodeId,
            sourceOutputKey: edgeSourcePort || 'out',
            targetNodeId: tgtId,
            targetParamName: 'input'
          }
          edges.value.push(edge)
        }
      }
    }
    mode.value = 'idle'
    dragNodeId = null
    dragStart = null
    dragNodeStart = null
    edgeSourceNodeId = null
    edgeSourcePort = null
    tempEdgeEnd = null
    panStart = null
    panOffsetStart = null
    scheduleRender()
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const newScale = Math.max(0.3, Math.min(3, scale.value * delta))
    const canvas = canvasRef.value
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    offset.x = mx - (mx - offset.x) * (newScale / scale.value)
    offset.y = my - (my - offset.y) * (newScale / scale.value)
    scale.value = newScale
    scheduleRender()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // P1-27：绑定在 window 上，输入框/文本域/可编辑元素内按键必须早退，
      // 否则在属性面板输入退格即摧毁选中节点+边
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (selectedNodeId.value) {
        nodes.value = nodes.value.filter(n => n.id !== selectedNodeId.value)
        edges.value = edges.value.filter(
          ed => ed.sourceNodeId !== selectedNodeId.value && ed.targetNodeId !== selectedNodeId.value
        )
        selectedNodeId.value = null
        scheduleRender()
      } else if (selectedEdgeId.value) {
        edges.value = edges.value.filter(ed => ed.id !== selectedEdgeId.value)
        selectedEdgeId.value = null
        scheduleRender()
      }
    }
  }

  function topologicalSort(): DagNode[] {
    const inDegree: Record<string, number> = {}
    const adj: Record<string, string[]> = {}
    for (const n of nodes.value) {
      inDegree[n.id] = 0
      adj[n.id] = []
    }
    for (const e of edges.value) {
      inDegree[e.targetNodeId] = (inDegree[e.targetNodeId] || 0) + 1
      if (adj[e.sourceNodeId]) adj[e.sourceNodeId].push(e.targetNodeId)
    }
    const queue: string[] = []
    for (const id of Object.keys(inDegree)) {
      if (inDegree[id] === 0) queue.push(id)
    }
    const sorted: DagNode[] = []
    while (queue.length > 0) {
      const id = queue.shift()!
      const node = nodes.value.find(n => n.id === id)
      if (node) sorted.push(node)
      for (const tid of (adj[id] || [])) {
        inDegree[tid]--
        if (inDegree[tid] === 0) queue.push(tid)
      }
    }
    return sorted
  }

  function autoLayout() {
    const sorted = topologicalSort()
    const layers: Record<number, DagNode[]> = {}
    const nodeLayer: Record<string, number> = {}

    for (const n of sorted) {
      let maxDepLayer = -1
      for (const e of edges.value) {
        if (e.targetNodeId === n.id && nodeLayer[e.sourceNodeId] !== undefined) {
          maxDepLayer = Math.max(maxDepLayer, nodeLayer[e.sourceNodeId])
        }
      }
      const layer = maxDepLayer + 1
      nodeLayer[n.id] = layer
      if (!layers[layer]) layers[layer] = []
      layers[layer].push(n)
    }

    const maxLayer = Math.max(0, ...Object.keys(layers).map(Number))
    const centerX = (canvasRef.value?.width || 800) / (2 * scale.value)
    const centerY = (canvasRef.value?.height || 600) / (2 * scale.value)
    const totalWidth = maxLayer * LAYER_GAP_X
    const startX = centerX - totalWidth / 2

    for (let l = 0; l <= maxLayer; l++) {
      const layerNodes = layers[l] || []
      const totalHeight = (layerNodes.length - 1) * NODE_GAP_Y
      const startY = centerY - totalHeight / 2
      for (let i = 0; i < layerNodes.length; i++) {
        layerNodes[i].position.x = startX + l * LAYER_GAP_X
        layerNodes[i].position.y = startY + i * NODE_GAP_Y
      }
    }
    scheduleRender()
  }

  function addNode(node: DagNode) {
    nodes.value.push(node)
    scheduleRender()
  }

  function removeNode(nodeId: string) {
    nodes.value = nodes.value.filter(n => n.id !== nodeId)
    // 2026-09-25：`edges` 是 Ref，直接 `.filter` 在运行时是 TypeError（删除节点必炸）。
    // 类型检查一直在报 TS2339，此前被 typecheck 脚本的 TS6305 掩蔽着看不见。
    edges.value = edges.value.filter(e => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId)
    if (selectedNodeId.value === nodeId) selectedNodeId.value = null
    scheduleRender()
  }

  // D-10：判断新增 source→target 边是否成环——从 target 沿既有边 DFS，
  // 若能回到 source 则加入该边会形成循环依赖
  function wouldCreateCycle(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return true
    const visited = new Set<string>()
    const stack = [targetId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (cur === sourceId) return true
      if (visited.has(cur)) continue
      visited.add(cur)
      for (const e of edges.value) {
        if (e.sourceNodeId === cur) stack.push(e.targetNodeId)
      }
    }
    return false
  }

  function addEdge(edge: DagEdge) {
    // D-10：程序化加边同样拒绝成环
    if (wouldCreateCycle(edge.sourceNodeId, edge.targetNodeId)) return
    edges.value.push(edge)
    scheduleRender()
  }

  function removeEdge(edgeId: string) {
    edges.value = edges.value.filter(e => e.id !== edgeId)
    if (selectedEdgeId.value === edgeId) selectedEdgeId.value = null
    scheduleRender()
  }

  function clearAll() {
    nodes.value = []
    edges.value = []
    selectedNodeId.value = null
    selectedEdgeId.value = null
    scheduleRender()
  }

  function setNodes(newNodes: DagNode[]) {
    nodes.value = newNodes
    scheduleRender()
  }

  function setEdges(newEdges: DagEdge[]) {
    edges.value = newEdges
    scheduleRender()
  }

  function getSelectedNode(): DagNode | null {
    return nodes.value.find(n => n.id === selectedNodeId.value) || null
  }

  // D-16：组件卸载时取消未执行的 requestAnimationFrame——
  // PipelinePage 用 v-if 切走后残留帧会在 canvas 已移除时继续触发渲染
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (animFrameId !== 0) {
        cancelAnimationFrame(animFrameId)
        animFrameId = 0
        needsRender = false
      }
    })
  }

  return {
    nodes,
    edges,
    selectedNodeId,
    selectedEdgeId,
    mode,
    offset,
    scale,
    resize,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onWheel,
    onKeyDown,
    addNode,
    removeNode,
    addEdge,
    removeEdge,
    clearAll,
    autoLayout,
    setNodes,
    setEdges,
    getSelectedNode,
    scheduleRender,
    topologicalSort,
    wouldCreateCycle
  }
}
