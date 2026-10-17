//! Provider 回退链。
//!
//! 对应现状 `src/services/providerChain.ts`（220 行）。
//!
//! 语义：按优先级顺序尝试 provider，任一成功即返回；
//! 全部失败则汇总错误返回。

use serde::{Deserialize, Serialize};
use sky_core::ChatMessage;

/// Provider 种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// OpenAI 兼容（含多数本地推理服务）
    OpenAi,
    /// Anthropic
    Anthropic,
    /// Ollama 本地
    Ollama,
}

/// Provider 配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// 回退优先级，越小越先试。
    pub priority: u32,
}

/// Chat 请求。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// Chat 响应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

/// Provider 错误。
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider {0} 请求失败：{1}")]
    Request(String, String),
    #[error("全部 provider 失败，最后一次错误：{0}")]
    AllFailed(String),
    #[error("provider 列表为空")]
    Empty,
}

/// 单次调用抽象。实现方负责实际 HTTP 请求。
#[async_trait::async_trait]
pub trait ProviderCall: Send + Sync {
    async fn call(&self, cfg: &ProviderConfig, req: &ChatRequest) -> Result<ChatResponse, String>;
}

/// 回退链。
pub struct ProviderChain {
    configs: Vec<ProviderConfig>,
}

impl ProviderChain {
    /// 构造时按 priority 升序排列（越小越先试）。
    pub fn new(mut configs: Vec<ProviderConfig>) -> Self {
        configs.sort_by_key(|c| c.priority);
        Self { configs }
    }

    pub fn len(&self) -> usize {
        self.configs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.configs.is_empty()
    }

    pub fn configs(&self) -> &[ProviderConfig] {
        &self.configs
    }

    /// 依次尝试，任一成功返回；全失败则返回 `AllFailed`。
    ///
    /// 关键语义：**不因单个 provider 失败而中止整条链**。
    pub async fn execute<C: ProviderCall>(
        &self,
        caller: &C,
        req: &ChatRequest,
    ) -> Result<ChatResponse, ProviderError> {
        if self.configs.is_empty() {
            return Err(ProviderError::Empty);
        }

        let mut last_err = String::new();

        for cfg in &self.configs {
            let mut r = req.clone();
            // 用 provider 自己的模型名覆盖请求模型
            r.model = cfg.model.clone();

            match caller.call(cfg, &r).await {
                Ok(resp) => return Ok(resp),
                Err(e) => {
                    last_err = format!("{}: {e}", cfg.name);
                }
            }
        }

        Err(ProviderError::AllFailed(last_err))
    }
}
