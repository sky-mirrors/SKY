import type { HoloEventBus } from '@/kernel/bus'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { getKnowledgeEntries } from '@/services/knowledgeBase'

type Disposer = (() => void) | null

let _disposeEntryDeleted: Disposer = null
let _disposeEntriesChanged: Disposer = null
export function registerKnowledgeHandlers(bus: HoloEventBus) {
  bus.registerHandler('knowledge:get-entries', () => {
    return getKnowledgeEntries()
  })

  bus.registerHandler('knowledge:get-groups', () => {
    const store = useKnowledgeStore()
    return store.knowledgeGroups
  })

  // C-07：pipelineStore.createPipelineKB 一直调用 'knowledge:create-group'，
  // 但该通道从未注册——globalBus.request 直接 throw，管道知识库创建必炸。
  // 重名时按幂等语义返回已有分组
  bus.registerHandler('knowledge:create-group', (payload: { name: string }) => {
    const store = useKnowledgeStore()
    const created = store.createGroup(payload.name)
    if (created) return created
    return store.knowledgeGroups.find(g => g.name === payload.name) || null
  })

  // C-08：knowledgeBase 检索走单数通道 'knowledge:get-group'，
  // 此前只注册了复数 'knowledge:get-groups'，带分组的检索必然 reject
  bus.registerHandler('knowledge:get-group', (payload: { groupId: string }) => {
    const store = useKnowledgeStore()
    return store.knowledgeGroups.find(g => g.id === payload.groupId) || null
  })

  // C-16：条目删除广播——清理 memoryStore/knowledgeStore/pipelineStore 三处悬空引用。
  // knowledgeBase 用 emit() 发布，必须桥接 on() 才可达（与 debug:* 同理）
  const entryDeletedHandler = (payload: { entryId?: string }) => {
    const entryId = payload?.entryId
    if (!entryId) return
    try { useKnowledgeStore().removeSharedEntryEverywhere(entryId) } catch { /* store 未就绪 */ }
    try { useMemoryStore().removeKnowledgeEntryRef(entryId) } catch { /* store 未就绪 */ }
    try { usePipelineStore().removeEntryFromAllPipelines(entryId) } catch { /* store 未就绪 */ }
  }
  bus.registerHandler('knowledge:entry-deleted', entryDeletedHandler)
  _disposeEntryDeleted?.()
  _disposeEntryDeleted = bus.on('knowledge:entry-deleted', entryDeletedHandler as (payload: unknown) => unknown)

  // 2026-10-01（用户反馈：知识库窗口需接成响应式）：条目增删信号 → 自增 store 版本号。
  // 知识条目本身不经过 store（存在 knowledgeBase 的模块级数组），只能靠这个信号把「变了」
  // 这件事送进 store，进而经跨窗口镜像传播到独立的知识库窗口。
  const entriesChangedHandler = () => {
    try { useKnowledgeStore().bumpEntriesVersion() } catch { /* store 未就绪 */ }
  }
  bus.registerHandler('knowledge:entries-changed', entriesChangedHandler)
  _disposeEntriesChanged?.()
  _disposeEntriesChanged = bus.on('knowledge:entries-changed', entriesChangedHandler as (payload: unknown) => unknown)
}
