import type { KnowledgeGroup, ProjectMemory } from '@/models'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { useSessionStore } from '@/stores/sessionStore'

export interface CreateProjectSpaceInput {
  name: string
  sessionIds: string[]
  groupIds: string[]
}

export interface ProjectSpaceResult {
  project: ProjectMemory
  group: KnowledgeGroup
}

/**
 * 2026-10-01（用户裁定）：合并式新建项目空间。
 * 原话：「新建项目空间可以把多个会话和多个知识库合为一个知识库和多个会话，但原知识库应该保持不变」。
 *
 * 语义：
 *  - 新建一个知识库分组，sharedEntryIds = 所选各库 sharedEntryIds 的**并集**。
 *    条目本身是全局的（`knowledgeBase` 的 entries），分组只是**引用集合**——因此
 *    取并集即「合为一个知识库」，且原分组一字未动即满足「原知识库保持不变」。
 *  - 新建项目空间（ProjectMemory），记录 `sessionIds` 与 `parentGroupId`(= 新分组)。
 *  - 所选会话的 `knowledgeGroupId` 改指新分组（此后检索只走新库，「每个会话隔离」不变）。
 *
 * 失败语义（fail-closed）：项目名为空或重名 ⇒ 返回 null，**不产生任何副作用**
 * （不建组、不改会话、不建项目）。传入不存在的 groupId 会被静默跳过（不抛错）。
 */
export function createProjectSpace(input: CreateProjectSpaceInput): ProjectSpaceResult | null {
  const name = input.name?.trim()
  if (!name) return null

  const memoryStore = useMemoryStore()
  const knowledgeStore = useKnowledgeStore()
  const sessionStore = useSessionStore()

  // 先做准入校验再动手——避免「建了组才发现重名」这类需要回滚的中间态
  if (memoryStore.projectMemories.some(p => p.name === name)) return null

  const entryIds = new Set<string>()
  for (const gid of input.groupIds) {
    const g = knowledgeStore.knowledgeGroups.find(x => x.id === gid)
    if (!g) continue
    for (const eid of g.sharedEntryIds) entryIds.add(eid)
  }
  const mergedEntryIds = Array.from(entryIds)

  const group = knowledgeStore.createGroupWithEntries(name, mergedEntryIds)

  const project = memoryStore.addProjectMemory(name, {
    parentGroupId: group.id,
    sessionIds: input.sessionIds,
    knowledgeEntryIds: mergedEntryIds
  })
  if (!project) {
    // 前置查重后理论不可达；万一并发插入同名项目，撤销刚建的分组保持 fail-closed
    knowledgeStore.deleteGroup(group.id)
    return null
  }

  for (const sid of input.sessionIds) {
    sessionStore.connectKnowledge(sid, group.id)
  }

  return { project, group }
}
