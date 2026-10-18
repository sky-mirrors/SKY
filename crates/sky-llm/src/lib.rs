//! SKY LLM 层。
//!
//! 对应现状：
//! - `src/services/sseParser.ts`（279 行）→ `sse`
//! - `src/services/providerChain.ts`（220 行）→ `provider`
//! - `src/services/tokenBudget.ts`（365 行）→ `budget`
//! - 新增 `glm`：智谱 GLM provider 的 HTTP 实现
//! - 新增 `config`：用户目录配置文件（免去每次设环境变量）

pub mod budget;
pub mod config;
pub mod glm;
pub mod provider;
pub mod sse;

pub use budget::{
    check_budget, downgrade_tier, find_whitelisted_tier, record_usage, tier_index, BudgetCheck,
    BudgetMode, TierWhitelist, TokenBudget, TIER_ORDER,
};
pub use config::{
    config_path, load as load_user_config, resolve as resolve_config, template as config_template,
    ConfigLoad, ResolvedConfig, UserConfig, CONFIG_PATH_ENV, DEFAULT_MODEL,
};
pub use glm::{
    api_key_from_env, glm_config, glm_config_with, HttpProviderCall, GLM_API_KEY_ENV, GLM_BASE_URL,
};
pub use provider::{
    ChatRequest, ChatResponse, ProviderCall, ProviderChain, ProviderConfig, ProviderError,
    ProviderKind,
};
pub use sse::{
    extract_anthropic_delta, extract_ollama_delta, extract_openai_delta, parse_sse_lines,
    SseEvent, StreamDelta, ToolCallDelta,
};
