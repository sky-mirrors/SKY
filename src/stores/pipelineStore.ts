import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Pipeline, PipelineStep, DagNode, DagEdge } from '@/models'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

type ExecuteFn = (pipeline: Pipeline, onProgress?: (stepId: string, msg: string) => void) => Promise<Record<string, string>>

let executeFn: ExecuteFn | null = null

export function registerPipelineExecutor(fn: ExecuteFn) {
  executeFn = fn
}

function ensurePipelineFields(p: Pipeline): void {
  if (!p.attachedEntryIds) p.attachedEntryIds = []
  if (!p.dagNodes) p.dagNodes = []
  if (!p.dagEdges) p.dagEdges = []
}

function migratePipelines(list: Pipeline[]): Pipeline[] {
  return list.map(p => { ensurePipelineFields(p); return p })
}

export const usePipelineStore = defineStore('pipeline', () => {
  const pipelines = ref<Pipeline[]>([])
  const runningPipelineId = ref<string | null>(null)
  const currentStepIndex = ref(0)
  const lastResults = ref<Record<string, string> | null>(null)
  const lastError = ref<string | null>(null)

  function createPipeline(name: string, steps: PipelineStep[], mode: 'serial' | 'parallel' = 'serial', sessionId?: string): Pipeline {
    const pipeline: Pipeline = {
      id: `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      steps,
      mode,
      createdAt: Date.now(),
      sessionId,
      attachedEntryIds: []
    }
    pipelines.value.push(pipeline)
    saveToStorage()
    return pipeline
  }

  function removePipeline(id: string) {
    pipelines.value = pipelines.value.filter(p => p.id !== id)
    // C-26：删除运行中的流水线必须清运行状态，否则 runningPipelineId 悬空，
    // startPipeline 入口守卫会永久拦截所有流水线
    if (runningPipelineId.value === id) {
      runningPipelineId.value = null
      currentStepIndex.value = 0
    }
    saveToStorage()
  }

  async function startPipeline(id: string, onProgress?: (stepId: string, msg: string) => void): Promise<Record<string, string> | undefined> {
    if (runningPipelineId.value) return undefined
    const pipeline = pipelines.value.find(p => p.id === id)
    if (!pipeline) return
    // C-13：执行器未注册时不得先置 running 再静默返回——runningPipelineId 会永久卡死，
    // 入口守卫随后拦截所有流水线直至刷新。改为置错误并直接返回
    if (!executeFn) {
      lastError.value = 'Pipeline executor not registered'
      return undefined
    }

    runningPipelineId.value = id
    currentStepIndex.value = 0
    pipeline.lastRunAt = Date.now()
    // C-26：lastRunAt 此前只在内存中更新、从不落盘，重启后跨天任务的"上次运行时间"丢失
    saveToStorage()
    lastResults.value = null
    lastError.value = null

    try {
      const results = await executeFn(pipeline, onProgress)
      lastResults.value = results
      runningPipelineId.value = null
      currentStepIndex.value = 0
      return results
    } catch (err) {
      lastError.value = String(err)
      runningPipelineId.value = null
      currentStepIndex.value = 0
      throw err
    }
  }

  function advanceStep() {
    currentStepIndex.value++
  }

  function finishPipeline() {
    runningPipelineId.value = null
    currentStepIndex.value = 0
  }

  function loadFromStorage() {
    const saved = vault.readCache('pipeline', 'holo-pipelines')
    if (saved) {
      try { pipelines.value = migratePipelines(JSON.parse(saved) as Pipeline[]) } catch { /* ignore */ }
    }
  }

  function saveToStorage() {
    vault.writeThrough('pipeline', 'holo-pipelines', JSON.stringify(pipelines.value))
  }

  function bindSession(pipelineId: string, sessionId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (p) { p.sessionId = sessionId; saveToStorage() }
  }

  function unbindSession(pipelineId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (p) { p.sessionId = undefined; saveToStorage() }
  }

  async function createPipelineKB(pipelineId: string, name: string): Promise<void> {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p) return
    const group = globalBus.request<{ id: string }>('knowledge:create-group', { name: name || `${p.name} 知识库` })
    p.knowledgeGroupId = group.id
    saveToStorage()
  }

  function addPipelineEntry(pipelineId: string, entryId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p) return
    if (!p.attachedEntryIds) p.attachedEntryIds = []
    if (!p.attachedEntryIds.includes(entryId)) {
      p.attachedEntryIds.push(entryId)
      saveToStorage()
    }
  }

  function removePipelineEntry(pipelineId: string, entryId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p || !p.attachedEntryIds) return
    p.attachedEntryIds = p.attachedEntryIds.filter(id => id !== entryId)
    saveToStorage()
  }

  // C-16：条目删除时清除所有流水线对它的悬空挂载引用
  function removeEntryFromAllPipelines(entryId: string): void {
    let changed = false
    for (const p of pipelines.value) {
      if (p.attachedEntryIds && p.attachedEntryIds.includes(entryId)) {
        p.attachedEntryIds = p.attachedEntryIds.filter(id => id !== entryId)
        changed = true
      }
    }
    if (changed) saveToStorage()
  }

  function addDagNode(pipelineId: string, node: DagNode): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p) return
    if (!p.dagNodes) p.dagNodes = []
    p.dagNodes.push(node)
    saveToStorage()
  }

  function removeDagNode(pipelineId: string, nodeId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p || !p.dagNodes) return
    p.dagNodes = p.dagNodes.filter(n => n.id !== nodeId)
    if (p.dagEdges) {
      p.dagEdges = p.dagEdges.filter(e => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId)
    }
    saveToStorage()
  }

  function updateDagNode(pipelineId: string, nodeId: string, updates: Partial<DagNode>): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p || !p.dagNodes) return
    const node = p.dagNodes.find(n => n.id === nodeId)
    if (node) {
      Object.assign(node, updates)
      saveToStorage()
    }
  }

  function addDagEdge(pipelineId: string, edge: DagEdge): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p) return
    if (!p.dagEdges) p.dagEdges = []
    p.dagEdges.push(edge)
    saveToStorage()
  }

  function removeDagEdge(pipelineId: string, edgeId: string): void {
    const p = pipelines.value.find(p => p.id === pipelineId)
    if (!p || !p.dagEdges) return
    p.dagEdges = p.dagEdges.filter(e => e.id !== edgeId)
    saveToStorage()
  }

  const activeDagPipelineId = ref<string | null>(null)

  function setActiveDagPipeline(id: string | null): void {
    activeDagPipelineId.value = id
  }

  return {
    pipelines,
    runningPipelineId,
    currentStepIndex,
    lastResults,
    lastError,
    activeDagPipelineId,
    createPipeline,
    removePipeline,
    startPipeline,
    advanceStep,
    finishPipeline,
    loadFromStorage,
    saveToStorage,
    bindSession,
    unbindSession,
    createPipelineKB,
    addPipelineEntry,
    removePipelineEntry,
    removeEntryFromAllPipelines,
    addDagNode,
    removeDagNode,
    updateDagNode,
    addDagEdge,
    removeDagEdge,
    setActiveDagPipeline
  }
})
