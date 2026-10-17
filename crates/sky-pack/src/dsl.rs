//! constraints DSL 求值。
//!
//! 对应现状 `src/host/pack/dsl.ts`（316 行）。
//!
//! 现状 DSL 是纯函数求值器：约束声明「在什么条件下、对什么输入、判定为可靠/不可靠」。
//! 本实现承接同一语义，但用 Rust 类型系统替代运行时的宽松校验。

use serde::{Deserialize, Serialize};

/// 约束适用范围。对应 `dsl.ts` 的 `ConstraintApplicability`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Applicability {
    /// 适用于所有输入。
    Always,
    /// 仅当输入匹配某关键词。
    Keyword { keyword: String },
    /// 仅当输入匹配某正则（简化：子串）。
    Pattern { pattern: String },
}

impl Applicability {
    pub fn matches(&self, input: &str) -> bool {
        match self {
            Applicability::Always => true,
            Applicability::Keyword { keyword } => input.contains(keyword.as_str()),
            Applicability::Pattern { pattern } => input.contains(pattern.as_str()),
        }
    }
}

/// 约束可靠性。对应 `dsl.ts` 的 `ConstraintReliability`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reliability {
    /// 可靠——结论可直接采用。
    Reliable,
    /// 需人工确认。
    NeedsReview,
    /// 不可靠——不得采用。
    Unreliable,
}

/// 单条约束。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackConstraint {
    pub id: String,
    pub description: String,
    pub applicability: Applicability,
    pub reliability: Reliability,
    /// 触发时给用户的提示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advice: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

/// 约束求值结果。对应 `dsl.ts` 的 `ConstraintResult`。
#[derive(Debug, Clone, PartialEq)]
pub struct ConstraintResult {
    pub constraint_id: String,
    pub reliability: Reliability,
    pub advice: Option<String>,
}

/// 对给定输入求值所有约束。
///
/// 语义：仅返回**适用**的约束；不适用的不出现（不是返回 unreliable）。
pub fn evaluate_constraints(constraints: &[PackConstraint], input: &str) -> Vec<ConstraintResult> {
    constraints
        .iter()
        .filter(|c| c.enabled && c.applicability.matches(input))
        .map(|c| ConstraintResult {
            constraint_id: c.id.clone(),
            reliability: c.reliability,
            advice: c.advice.clone(),
        })
        .collect()
}

/// 校验错误。对应 `dsl.ts:36` 的 `SchemaValidationError`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaValidationError {
    pub index: usize,
    pub field: String,
    pub message: String,
}

/// 校验单条约束。
///
/// 拒绝用例：id 为空、description 为空、advice 超长均报错。
pub fn validate_pack_constraint(c: &PackConstraint, index: usize) -> Vec<SchemaValidationError> {
    let mut errs = Vec::new();

    if c.id.trim().is_empty() {
        errs.push(SchemaValidationError {
            index,
            field: "id".into(),
            message: "约束 id 不得为空".into(),
        });
    }
    if c.description.trim().is_empty() {
        errs.push(SchemaValidationError {
            index,
            field: "description".into(),
            message: "约束 description 不得为空".into(),
        });
    }
    if let Applicability::Keyword { keyword } = &c.applicability {
        if keyword.trim().is_empty() {
            errs.push(SchemaValidationError {
                index,
                field: "applicability.keyword".into(),
                message: "keyword 不得为空".into(),
            });
        }
    }
    if let Some(a) = &c.advice {
        if a.len() > 2000 {
            errs.push(SchemaValidationError {
                index,
                field: "advice".into(),
                message: format!("advice 过长：{} 字符（上限 2000）", a.len()),
            });
        }
    }

    errs
}

/// 批量校验。
pub fn validate_all(constraints: &[PackConstraint]) -> Vec<SchemaValidationError> {
    constraints
        .iter()
        .enumerate()
        .flat_map(|(i, c)| validate_pack_constraint(c, i))
        .collect()
}
