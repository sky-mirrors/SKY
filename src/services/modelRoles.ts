/**
 * 模型协同（2026-09-23 用户纠正后的设计）
 *
 * 用户要求的是「**大模型兜底、小模型辅助**」的**协同**：
 *   主模型（大）= 掌舵：理解意图、规划、最终产出、失败时兜底；
 *   辅助模型（小）= 打下手：分类、抽取、命名、语言/意图规范化等**确定性小活**。
 * 而**不是**「按难度二选一」（快速档/强力档）——那种排他式分工已被本模块取代。
 *
 * 分派方式：按**调用标识**（`callerId` / `taskType`）判角色，因此**无需改动各调用点**。
 */
export type ModelRole = 'main' | 'aux'

export interface RoleBinding {
  providerId: string
  model: string
}

/** 解析所需的最小配置形状（避免与 store 循环依赖） */
export interface RoleConfig {
  activeProviderId: string
  activeModel: string
  providers: { id: string; models: { id: string }[] }[]
  roleModels?: Partial<Record<ModelRole, RoleBinding>> | null
}

/** 辅助角色的调用标识前缀（现状取自代码中的 callerId 实值） */
const AUX_CALLER_PREFIXES = [
  'l0SkillRouter',      // 文件名抽取等技能路由判断
  'errorClassifier',    // 错误归类
  'dualEngineValidator',// 步骤前审计
  'promptTranslator'    // 意图/语言/DAG 规范化
]
/** 辅助角色的任务类型 */
const AUX_TASK_TYPES = ['classify']

/** 按调用标识判定角色；未识别的调用一律视为主线（保证主任务永远走大模型） */
export function resolveRole(callerId?: string, taskType?: string): ModelRole {
  if (taskType && AUX_TASK_TYPES.includes(taskType)) return 'aux'
  if (callerId && AUX_CALLER_PREFIXES.some(p => callerId.startsWith(p))) return 'aux'
  return 'main'
}

/**
 * 按角色解析实际 provider+model。
 * 未配置该角色（或绑定已失效）→ 回退 `activeModel`（老配置零迁移，且缺辅助模型不影响可用性）。
 */
export function resolveRoleTarget(config: RoleConfig, role: ModelRole): { providerId: string; model: string } {
  const fallback = { providerId: config.activeProviderId, model: config.activeModel }
  const bind = config.roleModels ? config.roleModels[role] : undefined
  if (!bind || !bind.providerId || !bind.model) return fallback
  const provider = config.providers.find(p => p.id === bind.providerId)
  if (!provider || !provider.models.some(m => m.id === bind.model)) return fallback
  return { providerId: bind.providerId, model: bind.model }
}
