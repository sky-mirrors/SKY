/**
 * 小模型兜底策略（2026-09-23 用户需求）：
 *   「小模型跑确定性工作，大模型兜底；若没有大模型，也要能只用小模型工作，
 *     但小模型解决不了的问题必须诚实陈述。」
 *
 * 分工由 `tierModelBinding` 负责（简单/确定任务落 nano|mini → 小模型；
 * 复杂任务落 standard|pro → 大模型）。本模块补两件事：
 *   1) **兜底**：小档跑出「做不了」的结果时，找大档模型重试一次；
 *   2) **诚实**：无大档可兜底、或兜底也没成时，产出明确的「未完成」陈述，
 *      不允许把小模型的失败包装成成功。
 */
import { resolveTierTarget } from './tierModelBinding'
import type { TierBindingConfig, TierTarget } from './tierModelBinding'

export type EscalationConfig = TierBindingConfig

/** 小档档位（确定性/常规工作）与大档档位（兜底） */
const SMALL_TIERS = ['nano', 'mini'] as const
const BIG_TIER = 'standard' as const

/** 拒答 / 能力不足的典型表述——取自真实运行轨迹（考试 Q3/Q16/Q18 与兜底探针的模型原话） */
const UNSOLVABLE_PATTERNS: RegExp[] = [
  // 「我(做不到|无法|不能)…」类声明——允许「我」与关键字之间有短间隔
  // （实测漏判过：「我做不到——无法直接控制…」）
  /我[^。！？\n]{0,14}(做不到|无法|不能|没办法)/,
  // 能力不足 + 「只能由人做的事」（访问/操作/控制/替你/代你/配对…）；
  // 排除「如果…无法连接」这类条件句（负向先行断言），避免给正常回答乱加"未完成"
  /^(?![如果若假如])[^。！？\n]{0,10}(做不到|无法|不能)[^。！？\n]{0,24}(访问|操作|控制|操控|替你|代你|配对|安装|直接)/m,
  /(作为|因为我是)(一个)?(基于)?(文本|语言)(的)?(AI|助手|模型)/,
  /抱歉[，,][^。]{0,16}(不能|无法)/
]

/** 判断一段模型输出是否属于「我做不了」——用于触发兜底与诚实陈述 */
export function detectUnsolvable(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  return UNSOLVABLE_PATTERNS.some(p => p.test(t))
}

/**
 * 小档遇阻时寻找大档兜底目标。
 * 以下情形返回 null（不升级）：当前档已是大档（防死循环）／未绑定大档／绑定已失效。
 */
export function resolveEscalationTarget(config: EscalationConfig, currentTier: string): TierTarget | null {
  if (!(SMALL_TIERS as readonly string[]).includes(currentTier)) return null
  const bound = config.tierModels ? config.tierModels[BIG_TIER] : undefined
  if (!bound || !bound.providerId || !bound.model) return null
  const target = resolveTierTarget(config, BIG_TIER)
  // 必须确实解析到「大档绑定」本身——若因绑定失效而回退到单值/小档，则视为无兜底（不空转）
  if (target.providerId !== bound.providerId || target.model !== bound.model) return null
  const provider = config.providers.find(p => p.id === target.providerId)
  if (!provider || !provider.models.some(m => m.id === target.model)) return null
  return target
}

export type HonestNoticeKind = 'small-only' | 'both-failed'

/**
 * 诚实陈述：明确告诉用户"这事没办成"，并说明原因与下一步。
 * 刻意使用「未完成／不代表已完成」等直白措辞，避免与成功结果混淆。
 */
export function buildHonestNotice(kind: HonestNoticeKind): string {
  if (kind === 'small-only') {
    return '⚠️ 本任务未完成：当前只配置了小模型，该任务超出它的能力范围（未配置大模型可兜底）。'
      + '以下内容仅为参考或建议，不代表任务已完成。'
  }
  return '⚠️ 本任务未完成：已尝试用大模型兜底，仍未达成目标。'
    + '以下内容仅为参考或建议，不代表任务已完成。'
}
