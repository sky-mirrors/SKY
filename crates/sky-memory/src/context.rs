//! 会话上下文窗口。
//!
//! 对应现状 `src/services/convMemory.ts`（170 行）与
//! `src/services/sessionMemoryContext.ts`。
//!
//! 语义：按 token 预算裁剪历史消息，**保留最近的消息**，
//! 系统消息不参与裁剪。

use sky_core::ChatMessage;

/// 粗略 token 估算：中文按 1 字 1 token，英文按 4 字符 1 token。
///
/// 现状同样使用粗略估算（避免为裁剪单独调用分词器）。
pub fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for ch in text.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

/// 单条消息的 token 估算。
pub fn message_tokens(m: &ChatMessage) -> u64 {
    estimate_tokens(&m.content) + 4 // 角色与分隔开销
}

/// 裁剪结果。
#[derive(Debug, Clone, PartialEq)]
pub struct TrimResult {
    pub kept: Vec<ChatMessage>,
    pub dropped: usize,
    pub total_tokens: u64,
}

/// 按预算裁剪消息列表。
///
/// 规则：
/// - `system` 消息**永不裁剪**（它们是行为约束）
/// - 其余消息从**最旧**开始丢弃，直到总 token 落入预算
/// - 若单条最新消息就超预算，仍保留它（不能返回空上下文）
pub fn trim_to_budget(messages: &[ChatMessage], budget: u64) -> TrimResult {
    let systems: Vec<ChatMessage> = messages
        .iter()
        .filter(|m| m.role == "system")
        .cloned()
        .collect();
    let others: Vec<ChatMessage> = messages
        .iter()
        .filter(|m| m.role != "system")
        .cloned()
        .collect();

    let sys_tokens: u64 = systems.iter().map(message_tokens).sum();
    let mut kept_others: Vec<ChatMessage> = Vec::new();
    let mut used = sys_tokens;
    let mut dropped = 0usize;

    // 从最新往回取
    for m in others.iter().rev() {
        let t = message_tokens(m);
        if used + t <= budget || kept_others.is_empty() {
            used += t;
            kept_others.push(m.clone());
        } else {
            dropped += 1;
        }
    }

    kept_others.reverse();

    let mut kept = systems;
    kept.extend(kept_others);

    TrimResult {
        kept,
        dropped,
        total_tokens: used,
    }
}

/// 上下文窗口。
pub struct ContextWindow {
    messages: Vec<ChatMessage>,
    pub budget: u64,
}

impl ContextWindow {
    pub fn new(budget: u64) -> Self {
        Self {
            messages: Vec::new(),
            budget,
        }
    }

    pub fn push(&mut self, m: ChatMessage) {
        self.messages.push(m);
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn all(&self) -> &[ChatMessage] {
        &self.messages
    }

    /// 返回裁剪后的消息（不修改内部状态）。
    pub fn trimmed(&self) -> TrimResult {
        trim_to_budget(&self.messages, self.budget)
    }

    /// 就地裁剪。
    pub fn compact(&mut self) -> usize {
        let r = trim_to_budget(&self.messages, self.budget);
        let dropped = r.dropped;
        self.messages = r.kept;
        dropped
    }
}
