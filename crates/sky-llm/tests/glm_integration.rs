//! GLM provider 的真实集成测试。
//!
//! 需要环境变量 `SKY_GLM_API_KEY`。未设置时测试**跳过而非失败**——
//! 这样 CI（无密钥）不会红，而本地开发能真实验证。
//!
//! 运行：
//! ```bash
//! SKY_GLM_API_KEY=<key> cargo test -p sky-llm --test glm_integration -- --nocapture
//! ```

use sky_core::ChatMessage;
use sky_llm::{api_key_from_env, glm_config, ChatRequest, HttpProviderCall, ProviderCall};

fn req(content: &str) -> ChatRequest {
    ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: content.into(),
            timestamp: None,
        }],
        model: "glm-4-flash".into(),
        temperature: Some(0.1),
        max_tokens: Some(50),
    }
}

/// 真实调用 GLM，验证密钥与端到端连通。
#[tokio::test]
async fn glm_real_call_returns_content() {
    if api_key_from_env().is_none() {
        eprintln!("跳过：未设置 SKY_GLM_API_KEY");
        return;
    }

    let caller = HttpProviderCall::from_env();
    assert!(caller.has_key(), "环境变量存在则应读到密钥");

    let cfg = glm_config("glm-4-flash");
    let resp = caller
        .call(&cfg, &req("Reply with exactly: PONG"))
        .await
        .expect("GLM 调用应成功");

    println!("provider={} model={}", resp.provider, resp.model);
    println!("content={:?}", resp.content);
    println!(
        "tokens: prompt={} completion={}",
        resp.prompt_tokens, resp.completion_tokens
    );

    assert!(!resp.content.trim().is_empty(), "回复内容不得为空");
    assert_eq!(resp.provider, "glm");
    assert!(resp.completion_tokens > 0, "应报告 token 用量");
}

/// 中文往返——验证 UTF-8 编码正确处理。
#[tokio::test]
async fn glm_handles_chinese_text() {
    if api_key_from_env().is_none() {
        eprintln!("跳过：未设置 SKY_GLM_API_KEY");
        return;
    }

    let caller = HttpProviderCall::from_env();
    let cfg = glm_config("glm-4-flash");
    let resp = caller
        .call(&cfg, &req("用中文回答：把文档转成 PDF 这个任务属于什么类别？一句话。"))
        .await
        .expect("中文调用应成功");

    println!("中文回复：{}", resp.content);
    assert!(!resp.content.trim().is_empty());
    // 中文回复应包含 CJK 字符
    let has_cjk = resp
        .content
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    assert!(has_cjk, "中文请求应返回中文内容，实际：{}", resp.content);
}

/// 错误路径：无效密钥应返回明确错误，且不泄漏密钥本身。
#[tokio::test]
async fn invalid_key_returns_error_without_leaking_key() {
    let caller = HttpProviderCall::with_key("invalid-key-for-test.ABCDEFGH");
    let cfg = glm_config("glm-4-flash");
    let err = caller
        .call(&cfg, &req("hi"))
        .await
        .expect_err("无效密钥应失败");

    println!("错误信息：{err}");
    assert!(
        !err.contains("invalid-key-for-test"),
        "错误信息不得回显密钥：{err}"
    );
}
