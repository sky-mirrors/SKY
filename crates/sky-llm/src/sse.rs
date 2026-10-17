//! SSE 流式解析。
//!
//! 对应现状 `src/services/sseParser.ts`（279 行）。
//!
//! **必须保留的三处已修复边界**（均为历史 bug，回归代价高）：
//! - **B-11a**：仅按 `\n\n` 分割会让 CRLF（`\r\n\r\n`）服务器的整条流切不出事件
//!   → 必须兼容 `\r?\n\r?\n`（`sseParser.ts:20`）
//! - **B-11b**：`data:xxx`（冒号后无空格）按 SSE 规范也应接受，
//!   此前被整行丢弃 → 冒号后**至多**剥离一个空格（`sseParser.ts:28-32`）
//! - **S-4**：服务端在流内报错必须判失败，不得静默丢弃后当成功收尾
//!   （截断内容会入缓存与账本）（`sseParser.ts:51-56`）

use serde_json::Value;

/// SSE 事件。
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// 流式增量。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StreamDelta {
    pub done: bool,
    pub content: Option<String>,
    pub error: Option<String>,
    pub tool_calls: Vec<ToolCallDelta>,
}

/// 工具调用增量。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallDelta {
    pub index: u32,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// 按 SSE 规范剥离冒号后的**至多一个**空格。
/// B-11b：`data:xxx` 与 `data: xxx` 都必须接受。
fn strip_one_space(v: &str) -> &str {
    v.strip_prefix(' ').unwrap_or(v)
}

/// 解析 SSE 块，返回事件与剩余缓冲。
///
/// 对应 `sseParser.ts:17` `parseSSELines`。
pub fn parse_sse_lines(chunk: &str, buffer: &str) -> (Vec<SseEvent>, String) {
    let combined = format!("{buffer}{chunk}");

    // B-11a：兼容 CRLF 与 LF 两种行尾
    let mut parts: Vec<&str> = split_blank_lines(&combined);
    // 最后一段可能不完整，留作缓冲
    let remaining = parts.pop().unwrap_or("").to_string();

    let mut events = Vec::new();
    for part in parts {
        let mut event: Option<String> = None;
        let mut data_lines: Vec<&str> = Vec::new();

        for line in split_lines(part) {
            if let Some(v) = line.strip_prefix("data:") {
                data_lines.push(strip_one_space(v));
            } else if let Some(v) = line.strip_prefix("event:") {
                event = Some(strip_one_space(v).to_string());
            }
        }

        // 无 data 行的事件丢弃（对齐 sseParser.ts:39-41）
        if !data_lines.is_empty() {
            events.push(SseEvent {
                event,
                data: data_lines.join("\n"),
            });
        }
    }

    (events, remaining)
}

/// 按空行分割，兼容 `\r\n\r\n` 与 `\n\n`。
fn split_blank_lines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        // 找 \n\n 或 \r\n\r\n
        if bytes[i] == b'\n' {
            // \n\n
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                out.push(&s[start..i]);
                start = i + 2;
                i += 2;
                continue;
            }
            // \r\n\r\n —— 此时 i 指向前一组的 \n，需回看
            if i >= 1
                && bytes[i - 1] == b'\r'
                && i + 2 < bytes.len()
                && bytes[i + 1] == b'\r'
                && bytes[i + 2] == b'\n'
            {
                out.push(&s[start..i - 1]);
                start = i + 3;
                i += 3;
                continue;
            }
        }
        i += 1;
    }

    out.push(&s[start..]);
    out
}

/// 按行分割，兼容 `\r\n` 与 `\n`。
fn split_lines(s: &str) -> Vec<&str> {
    s.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// 解析 OpenAI 风格增量。
///
/// 对应 `sseParser.ts:44` `extractOpenAIDelta`。
pub fn extract_openai_delta(event: &SseEvent) -> StreamDelta {
    if event.data.trim() == "[DONE]" {
        return StreamDelta {
            done: true,
            ..Default::default()
        };
    }

    let Ok(p) = serde_json::from_str::<Value>(&event.data) else {
        // 解析失败不判失败——可能是 keep-alive 行，跳过
        return StreamDelta::default();
    };

    // S-4：流内错误必须判失败
    if let Some(err) = p.get("error") {
        if !err.is_null() {
            let msg = match err {
                Value::String(s) => s.clone(),
                other => other
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| other.to_string()),
            };
            return StreamDelta {
                error: Some(msg),
                ..Default::default()
            };
        }
    }

    let mut d = StreamDelta::default();
    if let Some(c) = p
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
    {
        d.content = Some(c.to_string());
    }

    if let Some(tcs) = p
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("tool_calls"))
        .and_then(|t| t.as_array())
    {
        for tc in tcs {
            let f = tc.get("function");
            d.tool_calls.push(ToolCallDelta {
                index: tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as u32,
                id: tc.get("id").and_then(|i| i.as_str()).map(String::from),
                name: f
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                    .map(String::from),
                arguments: f
                    .and_then(|f| f.get("arguments"))
                    .and_then(|a| a.as_str())
                    .map(String::from),
            });
        }
    }

    d
}

/// 解析 Anthropic 风格增量。
///
/// 对应 `sseParser.ts:82` `extractAnthropicDelta`。
/// 终止标记是 `message_stop` 事件，不是 `[DONE]`。
pub fn extract_anthropic_delta(event: &SseEvent) -> StreamDelta {
    if event.event.as_deref() == Some("message_stop") {
        return StreamDelta {
            done: true,
            ..Default::default()
        };
    }

    let Ok(p) = serde_json::from_str::<Value>(&event.data) else {
        return StreamDelta::default();
    };

    // 流内错误判失败（与 S-4 同一原则）
    if p.get("type").and_then(|t| t.as_str()) == Some("error") {
        let msg = p
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error")
            .to_string();
        return StreamDelta {
            error: Some(msg),
            ..Default::default()
        };
    }

    let mut d = StreamDelta::default();
    // content_block_delta → delta.text
    if p.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
        if let Some(t) = p.get("delta").and_then(|x| x.get("text")).and_then(|x| x.as_str()) {
            d.content = Some(t.to_string());
        }
    }
    d
}

/// 解析 Ollama NDJSON 增量（每行一个 JSON，非 SSE）。
///
/// 对应 `sseParser.ts:206` `extractOllamaDelta`。
pub fn extract_ollama_delta(line: &str) -> Option<StreamDelta> {
    let p: Value = serde_json::from_str(line.trim()).ok()?;

    let mut d = StreamDelta::default();
    if let Some(c) = p
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
    {
        d.content = Some(c.to_string());
    }
    if p.get("done").and_then(|x| x.as_bool()).unwrap_or(false) {
        d.done = true;
    }
    Some(d)
}
