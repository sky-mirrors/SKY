//! SKY LLM 层。
//!
//! 对应现状：
//! - `src/services/sseParser.ts`（279 行）→ `sse`
//! - `src/services/providerChain.ts`（220 行）→ `provider`
//! - `src/services/tokenBudget.ts`（365 行）→ `budget`

pub mod budget;
pub mod provider;
pub mod sse;

pub use budget::{
    check_budget, downgrade_tier, find_whitelisted_tier, record_usage, tier_index, BudgetCheck,
    BudgetMode, TierWhitelist, TokenBudget, TIER_ORDER,
};
pub use provider::{
    ChatRequest, ChatResponse, ProviderCall, ProviderChain, ProviderConfig, ProviderError,
    ProviderKind,
};
pub use sse::{
    extract_anthropic_delta, extract_ollama_delta, extract_openai_delta, parse_sse_lines,
    SseEvent, StreamDelta, ToolCallDelta,
};
