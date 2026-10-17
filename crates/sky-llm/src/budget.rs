//! Token 预算与档位降级。
//!
//! 对应现状 `src/services/tokenBudget.ts`（365 行）。
//!
//! 关键语义（`tokenBudget.ts:208-215`）：
//! - `TIER_ORDER = [Pro, Standard, Mini, Nano]`——**索引越大越便宜**
//! - `downgrade_tier` 取 `max(requested_idx, max_allowed_idx)` → 只会往更便宜走，
//!   不会因为「maxAllowed 更贵」而反向升级
//! - 白名单查找：从请求档位往后找第一个允许的，全不允许则回退 `Nano`

use serde::{Deserialize, Serialize};
use sky_core::ModelTier;

/// 档位从贵到便宜。索引越大越便宜。
/// 对齐 `tokenBudget.ts:208`。
pub const TIER_ORDER: [ModelTier; 4] = [
    ModelTier::Pro,
    ModelTier::Standard,
    ModelTier::Mini,
    ModelTier::Nano,
];

/// 档位排序索引。
pub fn tier_index(t: ModelTier) -> usize {
    TIER_ORDER.iter().position(|x| *x == t).unwrap_or(3)
}

/// 档位白名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TierWhitelist {
    pub pro: bool,
    pub standard: bool,
    pub mini: bool,
    pub nano: bool,
}

impl Default for TierWhitelist {
    fn default() -> Self {
        Self {
            pro: true,
            standard: true,
            mini: true,
            nano: true,
        }
    }
}

impl TierWhitelist {
    pub fn allows(&self, t: ModelTier) -> bool {
        match t {
            ModelTier::Pro => self.pro,
            ModelTier::Standard => self.standard,
            ModelTier::Mini => self.mini,
            ModelTier::Nano => self.nano,
        }
    }

    /// 仅允许某档及更便宜的档位。
    ///
    /// 语义：`at_most(Pro)` 全开；`at_most(Nano)` 只留 nano。
    pub fn at_most(t: ModelTier) -> Self {
        let max_idx = tier_index(t);
        Self {
            pro: max_idx == 0,
            standard: max_idx <= 1,
            mini: max_idx <= 2,
            nano: max_idx <= 3,
        }
    }
}

/// 预算模式及其默认白名单。对齐 `tokenBudget.ts:13-49` 的 `MODE_TIER_WHITELIST`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BudgetMode {
    Zero,
    Economy,
    Standard,
}

impl BudgetMode {
    /// zero → 只允许 nano；economy → mini 及以下；standard → 全开。
    pub fn whitelist(self) -> TierWhitelist {
        match self {
            BudgetMode::Zero => TierWhitelist {
                pro: false,
                standard: false,
                mini: false,
                nano: true,
            },
            BudgetMode::Economy => TierWhitelist {
                pro: false,
                standard: false,
                mini: true,
                nano: true,
            },
            BudgetMode::Standard => TierWhitelist::default(),
        }
    }
}

/// 档位降级：取两者中更便宜的那个。
///
/// 对齐 `tokenBudget.ts:210-215`。**单向**——永不反向升级。
pub fn downgrade_tier(requested: ModelTier, max_allowed: ModelTier) -> ModelTier {
    let r = tier_index(requested);
    let m = tier_index(max_allowed);
    TIER_ORDER[r.max(m)]
}

/// 在白名单中查找可用档位。
///
/// 对齐 `tokenBudget.ts:198-205`：从请求档位往后（更便宜方向）找第一个允许的；
/// 全都不允许则回退 `Nano`。
pub fn find_whitelisted_tier(requested: ModelTier, wl: &TierWhitelist) -> ModelTier {
    let start = tier_index(requested);
    for t in TIER_ORDER.iter().skip(start) {
        if wl.allows(*t) {
            return *t;
        }
    }
    ModelTier::Nano
}

/// 预算上限配置。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TokenBudget {
    /// 单次调用 token 上限。
    pub per_call_limit: u64,
    /// 已消耗 token。
    pub used_tokens: u64,
}

impl Default for TokenBudget {
    fn default() -> Self {
        Self {
            per_call_limit: 100_000,
            used_tokens: 0,
        }
    }
}

/// 预算检查结果。
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetCheck {
    pub allowed: bool,
    pub recommended_tier: ModelTier,
    pub reason: String,
    pub budget_capped: bool,
}

/// 检查预算并给出推荐档位。
///
/// 语义：先按白名单收敛请求档位，再检查剩余额度；
/// 超额则沿 `TIER_ORDER` 往更便宜方向降，直到够用或到 `Nano`。
pub fn check_budget(
    budget: &TokenBudget,
    requested: ModelTier,
    estimated_tokens: u64,
    whitelist: &TierWhitelist,
) -> BudgetCheck {
    // 1) 白名单收敛
    let mut tier = find_whitelisted_tier(requested, whitelist);

    let remaining = budget.per_call_limit.saturating_sub(budget.used_tokens);

    // 2) 额度够用
    if estimated_tokens <= remaining {
        return BudgetCheck {
            allowed: true,
            recommended_tier: tier,
            reason: "Within budget".to_string(),
            budget_capped: false,
        };
    }

    // 3) 额度不够 → 逐档降级直到估算够用或到底
    let start = tier_index(tier);
    for t in TIER_ORDER.iter().skip(start) {
        // 更便宜的档位按比例估算：每降一档，估算 token 减半（保守近似）
        let idx = tier_index(*t);
        let factor = 1u64 << (idx - start).min(3);
        let est = estimated_tokens / factor;
        if wl_allows(t, whitelist) && est <= remaining {
            tier = *t;
            return BudgetCheck {
                allowed: true,
                recommended_tier: tier,
                reason: format!("Downgraded to {tier:?} due to budget"),
                budget_capped: true,
            };
        }
    }

    // 4) 到底仍不够 → 用最便宜的允许档位，标记超额
    BudgetCheck {
        allowed: false,
        recommended_tier: ModelTier::Nano,
        reason: "Budget exhausted".to_string(),
        budget_capped: true,
    }
}

fn wl_allows(t: &ModelTier, wl: &TierWhitelist) -> bool {
    wl.allows(*t)
}

/// 累计消耗。
pub fn record_usage(budget: &mut TokenBudget, tokens: u64) {
    budget.used_tokens = budget.used_tokens.saturating_add(tokens);
}
