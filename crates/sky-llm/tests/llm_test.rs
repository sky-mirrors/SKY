//! sky-llm 测试。
//!
//! 重点：三处已修复边界（B-11a CRLF / B-11b 冒号空格 / S-4 流内错误），
//! 以及档位降级的单向性与预算检查。

use sky_core::{ChatMessage, ModelTier};
use sky_llm::*;

// ---------- B-11a：行尾兼容 ----------

/// 拒绝用例：只有 LF 的流能解析。
#[test]
fn sse_parses_lf_line_endings() {
    let (events, rest) = parse_sse_lines("data: hello\n\n", "");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, "hello");
    assert_eq!(rest, "");
}

/// B-11a 回归：只有 CRLF 的流必须同样能解析。
/// 旧实现只按 `\n\n` 分割，会让 CRLF 服务器的整条流切不出事件。
#[test]
fn sse_parses_crlf_line_endings() {
    let (events, _) = parse_sse_lines("data: hello\r\n\r\n", "");
    assert_eq!(events.len(), 1, "CRLF 流必须切出事件");
    assert_eq!(events[0].data, "hello");
}

/// 混合行尾。
#[test]
fn sse_parses_mixed_line_endings() {
    let input = "data: a\r\n\r\ndata: b\n\n";
    let (events, _) = parse_sse_lines(input, "");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].data, "a");
    assert_eq!(events[1].data, "b");
}

// ---------- B-11b：冒号后空格 ----------

/// B-11b 回归：`data:xxx`（无空格）必须被接受。
/// 旧实现会整行丢弃。
#[test]
fn sse_accepts_data_without_space() {
    let (events, _) = parse_sse_lines("data:hello\n\n", "");
    assert_eq!(events.len(), 1, "data:hello 不得被丢弃");
    assert_eq!(events[0].data, "hello");
}

#[test]
fn sse_accepts_data_with_one_space() {
    let (events, _) = parse_sse_lines("data: hello\n\n", "");
    assert_eq!(events[0].data, "hello");
}

/// 规范：冒号后**至多**剥离一个空格，第二个空格属于数据。
#[test]
fn sse_strips_at_most_one_space() {
    let (events, _) = parse_sse_lines("data:  two-spaces\n\n", "");
    assert_eq!(events[0].data, " two-spaces");
}

#[test]
fn sse_joins_multiline_data() {
    let (events, _) = parse_sse_lines("data: line1\ndata: line2\n\n", "");
    assert_eq!(events[0].data, "line1\nline2");
}

/// 拒绝用例：没有 data 行的事件必须丢弃。
#[test]
fn sse_drops_event_without_data() {
    let (events, _) = parse_sse_lines("event: ping\n\n", "");
    assert!(events.is_empty());
}

#[test]
fn sse_keeps_incomplete_chunk_as_buffer() {
    let (events, rest) = parse_sse_lines("data: complete\n\ndata: parti", "");
    assert_eq!(events.len(), 1);
    assert_eq!(rest, "data: parti");
}

#[test]
fn sse_completes_across_chunks() {
    let (e1, buf) = parse_sse_lines("data: par", "");
    assert!(e1.is_empty());
    let (e2, _) = parse_sse_lines("tial\n\n", &buf);
    assert_eq!(e2.len(), 1);
    assert_eq!(e2[0].data, "partial");
}

// ---------- OpenAI delta ----------

#[test]
fn openai_extracts_content() {
    let ev = SseEvent {
        event: None,
        data: r#"{"choices":[{"delta":{"content":"你好"}}]}"#.into(),
    };
    let d = extract_openai_delta(&ev);
    assert_eq!(d.content.as_deref(), Some("你好"));
    assert!(!d.done);
}

#[test]
fn openai_done_marker() {
    let ev = SseEvent {
        event: None,
        data: "[DONE]".into(),
    };
    assert!(extract_openai_delta(&ev).done);
}

/// S-4 回归：流内 error 必须判失败，不得静默当成功。
#[test]
fn openai_stream_error_is_reported() {
    let ev = SseEvent {
        event: None,
        data: r#"{"error":{"message":"rate limited"}}"#.into(),
    };
    let d = extract_openai_delta(&ev);
    assert_eq!(d.error.as_deref(), Some("rate limited"));
}

#[test]
fn openai_string_error_is_reported() {
    let ev = SseEvent {
        event: None,
        data: r#"{"error":"boom"}"#.into(),
    };
    assert_eq!(extract_openai_delta(&ev).error.as_deref(), Some("boom"));
}

/// 拒绝用例：无法解析的行不得判失败（可能是 keep-alive）。
#[test]
fn openai_invalid_json_is_ignored_not_failed() {
    let ev = SseEvent {
        event: None,
        data: "not-json".into(),
    };
    let d = extract_openai_delta(&ev);
    assert!(d.error.is_none());
    assert!(d.content.is_none());
}

#[test]
fn openai_extracts_tool_calls() {
    let ev = SseEvent {
        event: None,
        data: r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}"#.into(),
    };
    let d = extract_openai_delta(&ev);
    assert_eq!(d.tool_calls.len(), 1);
    assert_eq!(d.tool_calls[0].name.as_deref(), Some("f"));
}

// ---------- Anthropic delta ----------

#[test]
fn anthropic_message_stop_is_done() {
    let ev = SseEvent {
        event: Some("message_stop".into()),
        data: "{}".into(),
    };
    assert!(extract_anthropic_delta(&ev).done);
}

#[test]
fn anthropic_content_block_delta() {
    let ev = SseEvent {
        event: None,
        data: r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#.into(),
    };
    assert_eq!(extract_anthropic_delta(&ev).content.as_deref(), Some("hi"));
}

#[test]
fn anthropic_error_reported() {
    let ev = SseEvent {
        event: None,
        data: r#"{"type":"error","error":{"message":"overloaded"}}"#.into(),
    };
    assert_eq!(
        extract_anthropic_delta(&ev).error.as_deref(),
        Some("overloaded")
    );
}

// ---------- Ollama ----------

#[test]
fn ollama_ndjson_content() {
    let d = extract_ollama_delta(r#"{"message":{"content":"hi"},"done":false}"#).unwrap();
    assert_eq!(d.content.as_deref(), Some("hi"));
    assert!(!d.done);
}

#[test]
fn ollama_done_flag() {
    let d = extract_ollama_delta(r#"{"message":{"content":""},"done":true}"#).unwrap();
    assert!(d.done);
}

/// 拒绝用例：非 JSON 行返回 None。
#[test]
fn ollama_non_json_returns_none() {
    assert!(extract_ollama_delta("garbage").is_none());
}

// ---------- 档位降级 ----------

#[test]
fn tier_order_is_expensive_to_cheap() {
    assert_eq!(tier_index(ModelTier::Pro), 0);
    assert_eq!(tier_index(ModelTier::Nano), 3);
}

/// 关键不变量：降级单向，只会更便宜。
#[test]
fn downgrade_only_goes_cheaper() {
    // 请求 pro，上限 standard → 降到 standard
    assert_eq!(
        downgrade_tier(ModelTier::Pro, ModelTier::Standard),
        ModelTier::Standard
    );
    // 请求 nano，上限 pro → 保持 nano（不反向升级）
    assert_eq!(
        downgrade_tier(ModelTier::Nano, ModelTier::Pro),
        ModelTier::Nano
    );
}

#[test]
fn downgrade_same_tier_is_identity() {
    for t in [ModelTier::Pro, ModelTier::Standard, ModelTier::Mini, ModelTier::Nano] {
        assert_eq!(downgrade_tier(t, t), t);
    }
}

// ---------- 白名单 ----------

#[test]
fn budget_mode_zero_only_allows_nano() {
    let wl = BudgetMode::Zero.whitelist();
    assert!(wl.allows(ModelTier::Nano));
    assert!(!wl.allows(ModelTier::Pro));
    assert!(!wl.allows(ModelTier::Standard));
}

#[test]
fn budget_mode_economy_allows_mini_and_nano() {
    let wl = BudgetMode::Economy.whitelist();
    assert!(wl.allows(ModelTier::Mini));
    assert!(wl.allows(ModelTier::Nano));
    assert!(!wl.allows(ModelTier::Pro));
}

#[test]
fn find_whitelisted_downgrades_to_allowed() {
    let wl = BudgetMode::Economy.whitelist();
    // 请求 pro，economy 不允许 → 应降到 mini
    assert_eq!(find_whitelisted_tier(ModelTier::Pro, &wl), ModelTier::Mini);
}

#[test]
fn find_whitelisted_falls_back_to_nano() {
    let wl = TierWhitelist {
        pro: false,
        standard: false,
        mini: false,
        nano: false,
    };
    assert_eq!(find_whitelisted_tier(ModelTier::Pro, &wl), ModelTier::Nano);
}

// ---------- 预算检查 ----------

#[test]
fn budget_allows_within_limit() {
    let b = TokenBudget {
        per_call_limit: 1000,
        used_tokens: 0,
    };
    let r = check_budget(&b, ModelTier::Standard, 100, &TierWhitelist::default());
    assert!(r.allowed);
    assert_eq!(r.recommended_tier, ModelTier::Standard);
    assert!(!r.budget_capped);
}

#[test]
fn budget_downgrades_when_exceeded() {
    let b = TokenBudget {
        per_call_limit: 1000,
        used_tokens: 950,
    };
    let r = check_budget(&b, ModelTier::Standard, 100, &TierWhitelist::default());
    assert!(r.budget_capped, "超额时应标记 capped");
    assert!(tier_index(r.recommended_tier) > tier_index(ModelTier::Standard));
}

#[test]
fn budget_exhausted_denies() {
    let b = TokenBudget {
        per_call_limit: 100,
        used_tokens: 100,
    };
    let r = check_budget(&b, ModelTier::Pro, 1000, &TierWhitelist::default());
    assert!(!r.allowed, "额度耗尽应拒绝");
}

#[test]
fn record_usage_accumulates() {
    let mut b = TokenBudget::default();
    record_usage(&mut b, 100);
    record_usage(&mut b, 50);
    assert_eq!(b.used_tokens, 150);
}

// ---------- Provider 链 ----------

struct FakeCaller {
    fail_count: std::sync::atomic::AtomicUsize,
    total: usize,
}

#[async_trait::async_trait]
impl ProviderCall for FakeCaller {
    async fn call(
        &self,
        cfg: &ProviderConfig,
        _req: &ChatRequest,
    ) -> Result<ChatResponse, String> {
        use std::sync::atomic::Ordering;
        let n = self.fail_count.fetch_add(1, Ordering::SeqCst);
        if n < self.total {
            Err(format!("{} failed", cfg.name))
        } else {
            Ok(ChatResponse {
                content: "ok".into(),
                provider: cfg.name.clone(),
                model: cfg.model.clone(),
                prompt_tokens: 1,
                completion_tokens: 1,
            })
        }
    }
}

fn cfg(name: &str, prio: u32) -> ProviderConfig {
    ProviderConfig {
        name: name.into(),
        kind: ProviderKind::OpenAi,
        base_url: "http://x".into(),
        model: format!("{name}-model"),
        api_key: None,
        priority: prio,
    }
}

fn req() -> ChatRequest {
    ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "hi".into(),
            timestamp: None,
        }],
        model: "ignored".into(),
        temperature: None,
        max_tokens: None,
    }
}

#[tokio::test]
async fn chain_sorts_by_priority() {
    let c = ProviderChain::new(vec![cfg("b", 2), cfg("a", 1)]);
    assert_eq!(c.configs()[0].name, "a");
    assert_eq!(c.configs()[1].name, "b");
}

/// 关键语义：单个 provider 失败不得中止整条链。
#[tokio::test]
async fn chain_falls_back_on_failure() {
    let c = ProviderChain::new(vec![cfg("a", 1), cfg("b", 2)]);
    let caller = FakeCaller {
        fail_count: std::sync::atomic::AtomicUsize::new(0),
        total: 1, // 第一个失败，第二个成功
    };
    let r = c.execute(&caller, &req()).await.unwrap();
    assert_eq!(r.provider, "b");
}

#[tokio::test]
async fn chain_all_failed_returns_error() {
    let c = ProviderChain::new(vec![cfg("a", 1), cfg("b", 2)]);
    let caller = FakeCaller {
        fail_count: std::sync::atomic::AtomicUsize::new(0),
        total: 10,
    };
    let err = c.execute(&caller, &req()).await.unwrap_err();
    assert!(matches!(err, ProviderError::AllFailed(_)));
}

/// 拒绝用例：空链必须返回 Empty 而非 panic。
#[tokio::test]
async fn empty_chain_returns_empty_error() {
    let c = ProviderChain::new(vec![]);
    let caller = FakeCaller {
        fail_count: std::sync::atomic::AtomicUsize::new(0),
        total: 0,
    };
    assert!(matches!(
        c.execute(&caller, &req()).await.unwrap_err(),
        ProviderError::Empty
    ));
}
