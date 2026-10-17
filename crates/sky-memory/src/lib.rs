//! SKY 记忆层。
//!
//! 对应现状：
//! - `src/services/convMemory.ts`（170 行）+ `sessionMemoryContext.ts` → `context`
//! - `src/services/factGuard.ts`（284 行）→ `fact_guard`

pub mod context;
pub mod fact_guard;

pub use context::{estimate_tokens, message_tokens, trim_to_budget, ContextWindow, TrimResult};
pub use fact_guard::{
    compare_amounts, compare_dates, compare_percentages, extract_entities, guard, judge_conflict,
    should_trigger, EntityType, ExtractedEntity, FactConflict, GuardResult, Severity,
    AMOUNT_CRITICAL_PCT, DATE_CRITICAL_DAYS, PERCENTAGE_CRITICAL_DIFF,
};
