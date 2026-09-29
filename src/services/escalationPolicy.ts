/**
 * 小模型兜底策略（2026-09-23 用户需求）：
 *   「小模型跑确定性工作，大模型兜底；若没有大模型，也要能只用小模型工作，
 *     但小模型解决不了的问题必须诚实陈述。」
 *
 * 分工由 `modelRoles` 负责（主角色=大模型掌舵、辅助角色=小模型做确定性小活）。本模块补两件事：
 *   1) **兜底**：小档跑出「做不了」的结果时，找大档模型重试一次；
 *   2) **诚实**：无大档可兜底、或兜底也没成时，产出明确的「未完成」陈述，
 *      不允许把小模型的失败包装成成功。
 *
 * T-2 强化（2026-09-27 亲验坐实后补，见快照 §十）：
 *   - 误报源一：模式一会命中法律/财务场景的合理免责措辞（「我无法给出法律意见」）；
 *   - 误报源二：模式三会命中正常的自我能力说明（「作为AI助手，我可以…」）；
 *   - 文案缺陷：触发守卫只看 `escTarget` 是否为空，main 角色作答时会错落到 `small-only`，
 *     谎称「当前只配置了小模型」——明明是大模型在答。
 */
import { resolveRoleTarget } from './modelRoles'
import type { RoleConfig, ModelRole } from './modelRoles'

export type EscalationConfig = RoleConfig

/** 拒答 / 能力不足的典型表述——取自真实运行轨迹（考试 Q3/Q16/Q18 与兜底探针的模型原话） */
const UNSOLVABLE_PATTERNS: RegExp[] = [
  // 「我(做不到|无法|不能)…」类声明——允许「我」与关键字之间有短间隔
  // （实测漏判过：「我做不到——无法直接控制…」）
  /我[^。！？\n]{0,14}(做不到|无法|不能|没办法)/,
  // 能力不足 + 「只能由人做的事」（访问/操作/控制/替你/代你/配对…）；
  // 排除「如果…无法连接」这类条件句（负向先行断言），避免给正常回答乱加"未完成"
  /^(?![如果若假如])[^。！？\n]{0,10}(做不到|无法|不能)[^。！？\n]{0,24}(访问|操作|控制|操控|替你|代你|配对|安装|直接)/m,
  // T-2 收紧：自我能力说明**须与"做不了"同句出现**才算——原模式命中任何「作为AI助手」，
  // 而正常的自我能力说明（「作为AI助手，我可以帮你整理文档」）被误判成拒答。
  /(作为|因为我是|由于我是)[^。！？\n]{0,24}(AI|助手|模型)[^。！？\n]{0,24}(做不到|无法|不能|没办法)/,
  /抱歉[，,][^。]{0,16}(不能|无法)/
]

/**
 * T-2：免责/专业边界语境——否定能力**直接修饰「判断/建议类」动词**（给出意见、预测、
 * 保证…）。这是法律/财务场景的合理免责措辞，不代表任务做不了，故命中时该句不做拒答判定。
 * 刻意只匹配"否定 + 判断类动词"的紧邻组合：反向不成立——「我无法直接操作你的电脑，
 * 建议你咨询专业人士」仍是真拒答，不能被免责排除放过。
 */
const DISCLAIMER_SENTENCE = /(做不到|无法|不能|没办法)\s*(给出|提供|做出|发表|预测|保证|担保|承诺|判断)/

/**
 * 判断一段模型输出是否属于「我做不了」——用于触发兜底与诚实陈述。
 * T-2：改为**逐句**判定并跳过免责句。原实现对整段做 `some` 判定，一句免责声明就足以
 * 让整段逃过（或反之让正常回答被整体标记），两头都不对。
 */
export function detectUnsolvable(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  for (const raw of t.split(/(?<=[。！？\n])/)) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (DISCLAIMER_SENTENCE.test(sentence)) continue
    if (UNSOLVABLE_PATTERNS.some(p => p.test(sentence))) return true
  }
  return false
}

/**
 * 小模型（辅助角色）遇阻时，升级到主模型（大模型）兜底。
 * 语义即用户要求：「大模型兜底、小模型辅助」——辅助做不了就交给主模型。
 * 返回 null 的情形：当前已是主模型（无处可升）／未绑定主模型／绑定已失效。
 */
export function resolveEscalationTarget(
  config: EscalationConfig,
  currentRole: ModelRole
): { providerId: string; model: string } | null {
  if (currentRole !== 'aux') return null
  const bound = config.roleModels ? config.roleModels.main : undefined
  if (!bound || !bound.providerId || !bound.model) return null
  const target = resolveRoleTarget(config, 'main')
  // 必须确实解析到「主模型绑定」本身；若因绑定失效而回退到 active，则视为无兜底
  if (target.providerId !== bound.providerId || target.model !== bound.model) return null
  const provider = config.providers.find(p => p.id === target.providerId)
  if (!provider || !provider.models.some(m => m.id === target.model)) return null
  return target
}

export type HonestNoticeKind = 'small-only' | 'both-failed' | 'main-unsolved'

/**
 * T-2：按**实际角色**与是否存在兜底目标决定横幅种类。
 * 上游触发守卫是 `!forceTarget`（见 apiStore），它区分不了「主模型作答」与「小模型无处可升」
 * ——两者都会让 `escTarget` 为 null。若一律落 `small-only`，main 角色作答时会谎称
 * 「当前只配置了小模型」。此函数把该判定收敛到一处，六个调用点共用。
 */
export function honestNoticeFor(role: ModelRole, hasEscalationTarget: boolean): HonestNoticeKind {
  if (hasEscalationTarget) return 'both-failed'
  return role === 'main' ? 'main-unsolved' : 'small-only'
}

/**
 * 诚实陈述：明确告诉用户"这事没办成"，并说明原因与下一步。
 * 刻意使用「未完成／不代表已完成」等直白措辞，避免与成功结果混淆。
 */
export function buildHonestNotice(kind: HonestNoticeKind): string {
  if (kind === 'small-only') {
    return '⚠️ 本任务未完成：当前只配置了小模型，该任务超出它的能力范围（未配置大模型可兜底）。'
      + '以下内容仅为参考或建议，不代表任务已完成。'
  }
  if (kind === 'main-unsolved') {
    return '⚠️ 本任务未完成：主模型未能完成该任务（已无更高档可兜底）。'
      + '以下内容仅为参考或建议，不代表任务已完成。'
  }
  return '⚠️ 本任务未完成：已尝试用大模型兜底，仍未达成目标。'
    + '以下内容仅为参考或建议，不代表任务已完成。'
}
