//! 条件求值。
//!
//! 对应现状 `src/services/macroExecutor.ts:1053` `evaluateCondition`。
//!
//! **D-09 修复（必须保留）**：指定 `from_step` 时只对该步骤的输出求值。
//! 原实现扫描**全部**步骤结果中的任意数字，文件大小、耗时毫秒等无关数字
//! 会让 `$.output.amount > N` 误成立。

use std::collections::BTreeMap;

/// 求值条件表达式。
///
/// 支持两种形态（对齐现状）：
/// - `$.output.amount > N`（也接受 totalAmount / total）
/// - `$.output.contains('keyword')`
///
/// 无法识别的表达式返回 `true`（对齐现状的兜底行为）。
pub fn evaluate_condition(
    expr: &str,
    step_results: &BTreeMap<u32, String>,
    from_step: Option<u32>,
) -> bool {
    // D-09：限定求值范围
    let candidates: Vec<&String> = match from_step {
        Some(n) => step_results.get(&n).into_iter().collect(),
        None => step_results.values().collect(),
    };

    if let Some((field, threshold)) = parse_amount_expr(expr) {
        let _ = field;
        for result in &candidates {
            if let Some(v) = first_number(result) {
                if v > threshold {
                    return true;
                }
            }
        }
        return false;
    }

    if let Some(keyword) = parse_contains_expr(expr) {
        return candidates.iter().any(|r| r.contains(&keyword));
    }

    true
}

/// 解析 `$.output.amount > N` 形态，返回 (字段名, 阈值)。
fn parse_amount_expr(expr: &str) -> Option<(String, f64)> {
    let e = expr.trim();
    if !e.starts_with("$.output.") {
        return None;
    }
    let rest = &e["$.output.".len()..];
    let (field, tail) = rest.split_once('>')?;
    let field = field.trim();
    if !matches!(field, "amount" | "totalAmount" | "total") {
        return None;
    }
    let threshold: f64 = tail.trim().parse().ok()?;
    Some((field.to_string(), threshold))
}

/// 解析 `$.output.contains('x')` 形态。
fn parse_contains_expr(expr: &str) -> Option<String> {
    let e = expr.trim();
    let start = e.find("contains(")?;
    let rest = &e[start + "contains(".len()..];
    let quote = rest.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let after = &rest[quote.len_utf8()..];
    let end = after.find(quote)?;
    Some(after[..end].to_string())
}

/// 取字符串中第一个数字（支持千分位逗号）。
fn first_number(s: &str) -> Option<f64> {
    let mut buf = String::new();
    let mut started = false;
    for ch in s.chars() {
        if ch.is_ascii_digit() || ch == ',' || ch == '.' {
            started = true;
            if ch != ',' {
                buf.push(ch);
            }
        } else if started {
            break;
        }
    }
    buf.parse().ok()
}
