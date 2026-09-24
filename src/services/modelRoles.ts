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

/** 直连分支解析所需的配置形状（apiStore 的 ProviderConfig 结构上满足） */
export interface DirectTargetConfig {
  activeProviderId: string
  activeModel: string
  baseUrl?: string
  providers: Array<{ id: string; baseUrl?: string; chatFormat?: string }>
}

export interface DirectTarget {
  providerId: string
  baseUrl: string
  model: string
  chatFormat: string
}

/**
 * S-1：解析「直连分支」（Ollama 目标 / 降级态 / 无 electronAPI）的实际目标。
 *
 * 原实现直连分支一律用 activeProvider + activeModel，`tierTarget` 一次都没用上——
 * 于是：① aux 角色绑定到某个 Ollama provider 时，辅助调用实际打的是 activeModel；
 * ② resolveEscalationTarget 返回的兜底大模型若也是 Ollama（本项目主打配置），
 * 「升级重试」就是同一个 activeModel 原地重跑，必然再次判不可解，最终给用户挂
 * 「大模型也没做成」横幅——而大模型从未被调用。
 *
 * 未绑定角色时 tierTarget === {activeProviderId, activeModel}，故本解析与旧行为等价。
 */
export function resolveDirectTarget(
  config: DirectTargetConfig,
  tierTarget: { providerId: string; model: string },
  degrade?: { baseUrl: string; model: string } | null
): DirectTarget {
  if (degrade) {
    return {
      providerId: tierTarget.providerId || config.activeProviderId,
      baseUrl: String(degrade.baseUrl || '').replace(/\/+$/, ''),
      model: degrade.model,
      chatFormat: 'ollama',
    }
  }
  const provider =
    config.providers.find(p => p.id === tierTarget.providerId) ??
    config.providers.find(p => p.id === config.activeProviderId)
  return {
    providerId: provider?.id ?? '',
    baseUrl: String(provider?.baseUrl || config.baseUrl || '').replace(/\/+$/, ''),
    model: tierTarget.model || config.activeModel,
    chatFormat: provider?.chatFormat || 'openai',
  }
}
