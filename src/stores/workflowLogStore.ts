import { defineStore } from 'pinia'
import { ref } from 'vue'
import { WorkflowLog } from '@/models'
import { vault } from '@/vault'

export const useWorkflowLogStore = defineStore('workflowLog', () => {
  const logs = ref<WorkflowLog[]>([])
  // C-27：内存与持久化口径一致——持久化截断 50 条而内存无上限，
  // 长时间运行 ioSnapshots 全量累积导致内存持续增长
  const MAX_LOGS = 50
  const MAX_IO_SNAPSHOTS_PER_LOG = 200

  function createLog(name: string, nodeIds: string[], edgeTuples: [string, string, 'data' | 'control'][]): WorkflowLog {
    const log: WorkflowLog = {
      // C-25 同型：纯时间戳 ID 在同毫秒创建两条日志时碰撞，find(logId) 会更新错日志
      id: `wfl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    // C-27：内存上限与持久化一致，丢弃最旧日志（unshift 后最旧在尾部）
    if (logs.value.length > MAX_LOGS) logs.value.length = MAX_LOGS
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
    // C-27：单条日志快照数封顶，超限丢弃最旧快照
    if (log.ioSnapshots.length > MAX_IO_SNAPSHOTS_PER_LOG) {
      log.ioSnapshots.splice(0, log.ioSnapshots.length - MAX_IO_SNAPSHOTS_PER_LOG)
    }
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

  function clearLogs() {
    logs.value = []
    saveToStorage()
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

  // 启动即加载持久化日志（此前 loadFromStorage 零调用方，重启后时间线恒空）
  loadFromStorage()

  return {
    logs,
    createLog,
    updateNodeStatus,
    addIoSnapshot,
    activateEdge,
    completeLog,
    getLog,
    clearLogs,
    loadFromStorage
  }
})
