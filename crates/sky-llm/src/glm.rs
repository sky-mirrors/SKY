//! GLM（智谱）provider 实现。
//!
//! 端点与协议与 OpenAI 兼容（`/chat/completions`），差异在于：
//! - base url: `https://open.bigmodel.cn/api/paas/v4`
//! - 认证: `Authorization: Bearer <api_key>`
//!
//! **密钥来源**：只从环境变量读取，绝不硬编码、绝不落库。
//! 缺失时返回明确错误而非静默降级——fail-closed。

use crate::provider::{ChatRequest, ChatResponse, ProviderCall, ProviderConfig, ProviderKind};
use async_trait::async_trait;
use serde_json::{json, Value};

/// GLM 默认端点。
pub const GLM_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";
/// 环境变量名。
pub const GLM_API_KEY_ENV: &str = "SKY_GLM_API_KEY";

/// 从环境变量读取密钥。
///
/// 返回 `None` 表示未配置——调用方应报错而非发无认证请求。
pub fn api_key_from_env() -> Option<String> {
    std::env::var(GLM_API_KEY_ENV)
        .ok()
        .filter(|k| !k.trim().is_empty())
}

/// 构造 GLM provider 配置。
pub fn glm_config(model: &str) -> ProviderConfig {
    glm_config_with(model, GLM_BASE_URL)
}

/// 构造 GLM provider 配置，端点可覆盖。
///
/// 端点来自用户配置时用这个——尾部斜杠会归一化，避免拼出 `//chat/completions`。
pub fn glm_config_with(model: &str, base_url: &str) -> ProviderConfig {
    ProviderConfig {
        name: "glm".into(),
        kind: ProviderKind::OpenAi,
        base_url: base_url.trim_end_matches('/').to_string(),
        model: model.into(),
        api_key: None, // 从环境变量取，不放入配置结构
        priority: 1,
    }
}

/// HTTP 调用器。
pub struct HttpProviderCall {
    client: reqwest::Client,
    /// 密钥。构造时注入，避免每次请求读环境变量。
    api_key: Option<String>,
}

impl HttpProviderCall {
    /// 从环境变量构造。密钥缺失时 `api_key` 为 None，
    /// `call` 会返回明确错误。
    pub fn from_env() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            api_key: api_key_from_env(),
        }
    }

    /// 显式注入密钥（测试用）。
    pub fn with_key(key: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .unwrap_or_default(),
            api_key: Some(key.into()),
        }
    }

    pub fn has_key(&self) -> bool {
        self.api_key.is_some()
    }
}

#[async_trait]
impl ProviderCall for HttpProviderCall {
    async fn call(&self, cfg: &ProviderConfig, req: &ChatRequest) -> Result<ChatResponse, String> {
        let key = self
            .api_key
            .as_ref()
            .ok_or_else(|| format!("未配置 {GLM_API_KEY_ENV}，拒绝发起无认证请求"))?;

        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

        let mut body = json!({
            "model": cfg.model,
            "messages": req.messages.iter().map(|m| json!({
                "role": m.role,
                "content": m.content,
            })).collect::<Vec<_>>(),
        });

        if let Some(t) = req.temperature {
            // GLM 要求 temperature 小数点不超过 2 位。
            // 必须四舍五入——f32 的 0.1 序列化为 JSON 会变成
            // 0.10000000149011612，会被服务端拒绝（错误码 1210）。
            let rounded = (t as f64 * 100.0).round() / 100.0;
            body["temperature"] = json!(rounded);
        }
        if let Some(mt) = req.max_tokens {
            body["max_tokens"] = json!(mt);
        }

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求失败：{e}"))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败：{e}"))?;

        if !status.is_success() {
            // 不把密钥写进错误信息
            return Err(format!("HTTP {}：{}", status.as_u16(), truncate(&text, 300)));
        }

        let v: Value =
            serde_json::from_str(&text).map_err(|e| format!("响应不是合法 JSON：{e}"))?;

        let content = v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .ok_or_else(|| format!("响应缺少 choices[0].message.content：{}", truncate(&text, 300)))?
            .to_string();

        Ok(ChatResponse {
            content,
            provider: cfg.name.clone(),
            model: v
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or(&cfg.model)
                .to_string(),
            prompt_tokens: v
                .get("usage")
                .and_then(|u| u.get("prompt_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0),
            completion_tokens: v
                .get("usage")
                .and_then(|u| u.get("completion_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0),
        })
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sky_core::ChatMessage;

    #[test]
    fn glm_config_uses_correct_base_url() {
        let c = glm_config("glm-4-flash");
        assert_eq!(c.base_url, "https://open.bigmodel.cn/api/paas/v4");
        assert_eq!(c.name, "glm");
        assert_eq!(c.model, "glm-4-flash");
    }

    /// 拒绝用例：无密钥时必须在发请求前就报错。
    #[tokio::test]
    async fn missing_key_fails_before_request() {
        let caller = HttpProviderCall {
            client: reqwest::Client::new(),
            api_key: None,
        };
        assert!(!caller.has_key());
        let cfg = glm_config("glm-4-flash");
        let req = ChatRequest {
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
                timestamp: None,
            }],
            model: "glm-4-flash".into(),
            temperature: None,
            max_tokens: None,
        };
        let err = caller.call(&cfg, &req).await.unwrap_err();
        assert!(err.contains(GLM_API_KEY_ENV), "错误应指明缺失的环境变量：{err}");
    }

    #[test]
    fn truncate_keeps_short_strings() {
        assert_eq!(truncate("abc", 10), "abc");
    }

    #[test]
    fn truncate_cuts_long_strings() {
        let s = "x".repeat(50);
        let t = truncate(&s, 10);
        assert!(t.chars().count() <= 11);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn with_key_marks_has_key() {
        let c = HttpProviderCall::with_key("dummy");
        assert!(c.has_key());
    }

    /// 回归：`serde_json::json!` 宏把 f32 提升为 f64，暴露完整精度——
    /// `json!(0.1f32)` 产生 0.10000000149011612，GLM 以错误码 1210 拒绝
    /// （「temperature参数非法：限制小数点[2]位」）。
    /// 注意：`to_string(&0.1f32)` 走最短表示会得到 "0.1"，不暴露问题，
    /// 必须用 json! 宏复现真实路径。
    #[test]
    fn json_macro_exposes_f32_precision() {
        let raw = serde_json::json!(0.1f32).to_string();
        let decimals = raw.split('.').nth(1).map(|d| d.len()).unwrap_or(0);
        assert!(
            decimals > 2,
            "json! 宏应暴露 f32 精度问题（实际 {raw}），否则修复无必要"
        );
    }

    /// 修复后：经 f64 舍入再序列化，小数位不超过 2 位。
    #[test]
    fn temperature_is_rounded_to_two_decimals() {
        for (input, expect) in [
            (0.1f32, 0.1f64),
            (0.7f32, 0.7f64),
            (1.0f32, 1.0f64),
            (0.35f32, 0.35f64),
        ] {
            let rounded = (input as f64 * 100.0).round() / 100.0;
            assert!(
                (rounded - expect).abs() < 1e-9,
                "temperature {input} 应舍入为 {expect}，得到 {rounded}"
            );
            let s = serde_json::json!(rounded).to_string();
            let decimals = s.split('.').nth(1).map(|d| d.len()).unwrap_or(0);
            assert!(decimals <= 2, "序列化 {s} 小数位应 <= 2，实际 {decimals}");
        }
    }
}
