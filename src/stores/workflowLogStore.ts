import { defineStore } from 'pinia'
import { ref } from 'vue'
import { WorkflowLog } from '@/models'
import { vault } from '@/vault'

export const useWorkflowLogStore = defineStore('workflowLog', () => {
  const logs = ref<WorkflowLog[]>([])

  function createLog(name: string, nodeIds: string[], edgeTuples: [string, string, 'data' | 'control'][]): WorkflowLog {
    const log: WorkflowLog = {
      id: `wfl-${Date.now()}`,
      name,
      nodes: nodeIds.map(id => ({
        toolId: id,
        toolName: id,
        startedAt: 0,
        completedAt: 0,
        status: 'pending' as const
      })),
      edges: edgeTuples.map(([from, to, type]) => ({ from, to, type, activatedAt: undefined })),
      timestamps: [],
      ioSnapshots: [],
      startedAt: Date.now(),
      completedAt: 0,
      status: 'running'
    }
    logs.value.unshift(log)
    saveToStorage()
    return log
  }

  function updateNodeStatus(logId: string, toolId: string, status: 'pending' | 'running' | 'completed' | 'failed', startedAt?: number, completedAt?: number) {
    const log = logs.value.find(l => l.id === logId)
    if (!log) return
    const node = log.nodes.find(n => n.toolId === toolId)
    if (!node) return
    node.status = status
    if (startedAt) node.startedAt = startedAt
    if (completedAt) node.completedAt = completedAt
    if (status === 'running') log.timestamps.push(Date.now())
    saveToStorage()
  }

  function addIoSnapshot(logId: string, toolId: string, input: string, output: string) {
    const log = logs.value.find(l => l.id === logId)
    if (!log) return
    log.ioSnapshots.push({ toolId, input, output, timestamp: Date.now() })
    saveToStorage()
  }

  function activateEdge(logId: string, from: string, to: string) {
    const log = logs.value.find(l => l.id === logId)
    if (!log) return
    const edge = log.edges.find(e => e.from === from && e.to === to)
    if (edge) edge.activatedAt = Date.now()
    saveToStorage()
  }

  function completeLog(logId: string, status: 'completed' | 'failed') {
    const log = logs.value.find(l => l.id === logId)
    if (!log) return
    log.completedAt = Date.now()
    log.status = status
    saveToStorage()
  }

  function getLog(logId: string): WorkflowLog | undefined {
    return logs.value.find(l => l.id === logId)
  }

  function saveToStorage() {
    const toSave = logs.value.slice(0, 50)
    vault.writeThrough('workflow', 'holo-workflow-logs', JSON.stringify(toSave))
  }

  function loadFromStorage() {
    const saved = vault.readCache('workflow', 'holo-workflow-logs')
    if (saved) {
      try { logs.value = JSON.parse(saved) as WorkflowLog[] } catch { /* ignore */ }
    }
  }

  return {
    logs,
    createLog,
    updateNodeStatus,
    addIoSnapshot,
    activateEdge,
    completeLog,
    getLog,
    loadFromStorage
  }
})
