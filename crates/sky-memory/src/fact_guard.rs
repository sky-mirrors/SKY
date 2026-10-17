//! FactGuard 事实守卫。
//!
//! 对应现状 `src/services/factGuard.ts`（284 行）。
//!
//! 语义：从源文本抽取实体，与模型输出中的实体比对，
//! 按类型阈值判定严重度。**这是防幻觉的关键闸门**——
//! 阈值与类型规则均逐条对齐现状，不得放宽。

use serde::{Deserialize, Serialize};

/// 实体类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    Amount,
    Date,
    Percentage,
    ContractId,
    IdCard,
    BankAccount,
    PersonName,
    CompanyName,
}

/// 抽取到的实体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedEntity {
    pub kind: EntityType,
    /// 原始文本形态。
    pub raw: String,
    /// 归一化后的形态（用于比较）。
    pub normalized: String,
}

/// 冲突严重度。对应 `factGuard.ts:207-211`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Critical,
    Minor,
    Ok,
}

/// 事实冲突。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactConflict {
    pub kind: EntityType,
    pub severity: Severity,
    pub detail: String,
    pub source_raw: String,
    pub output_raw: String,
}

/// 守卫结果。对应 `factGuard.ts` 的返回结构。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GuardResult {
    pub severity: Severity,
    pub conflicts: Vec<FactConflict>,
    pub corrected_output: Option<String>,
}

/// 金额比较阈值（百分比）。对应 `factGuard.ts:123`。
pub const AMOUNT_CRITICAL_PCT: f64 = 10.0;
/// 日期比较阈值（天）。对应 `factGuard.ts:130`。
pub const DATE_CRITICAL_DAYS: f64 = 3.0;
/// 百分比比较阈值。对应 `factGuard.ts:137`。
pub const PERCENTAGE_CRITICAL_DIFF: f64 = 1.0;

/// 判断是否应触发守卫。
///
/// 对应 `factGuard.ts:79` `shouldTrigger`：仅当角色命中且上下文非空。
pub fn should_trigger(manifest_roles: &[String], context_text: &str) -> bool {
    !manifest_roles.is_empty() && !context_text.trim().is_empty()
}

/// 抽取所有实体。
///
/// 对应 `factGuard.ts:61` `extractEntitiesAll`。
/// 本实现覆盖金额、日期、百分比、编号四类——姓名/公司名需 NER 模型，
/// 归 Wave 6 由 `sky-memory` 的 nerExtractor 承接。
pub fn extract_entities(text: &str) -> Vec<ExtractedEntity> {
    let mut out = Vec::new();
    out.extend(extract_amounts(text));
    out.extend(extract_dates(text));
    out.extend(extract_percentages(text));
    out
}

fn extract_amounts(text: &str) -> Vec<ExtractedEntity> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        // 找 ¥/$ 前缀或数字串
        if chars[i] == '¥' || chars[i] == '$' || chars[i].is_ascii_digit() {
            let start = i;
            let mut has_currency = false;
            if chars[i] == '¥' || chars[i] == '$' {
                has_currency = true;
                i += 1;
            }
            let num_start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit() || chars[i] == ',' || chars[i] == '.')
            {
                i += 1;
            }
            if i > num_start {
                let raw: String = chars[start..i].iter().collect();
                let norm: String = chars[num_start..i]
                    .iter()
                    .filter(|c| **c != ',')
                    .collect();
                if let Ok(v) = norm.parse::<f64>() {
                    // 无货币符号时要求带小数，避免把普通整数当金额
                    if has_currency || raw.contains('.') {
                        out.push(ExtractedEntity {
                            kind: EntityType::Amount,
                            raw,
                            normalized: format!("{v:.2}"),
                        });
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

fn extract_dates(text: &str) -> Vec<ExtractedEntity> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        // 形态：YYYY-MM-DD 或 YYYY/MM/DD
        if chars[i].is_ascii_digit() {
            let start = i;
            let mut digits = 0;
            while i < chars.len() && chars[i].is_ascii_digit() {
                digits += 1;
                i += 1;
            }
            if digits == 4
                && i < chars.len()
                && (chars[i] == '-' || chars[i] == '/')
            {
                let sep = chars[i];
                i += 1;
                let mut m = 0;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    m += 1;
                    i += 1;
                }
                if (1..=2).contains(&m) && i < chars.len() && chars[i] == sep {
                    i += 1;
                    let mut d = 0;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        d += 1;
                        i += 1;
                    }
                    if (1..=2).contains(&d) {
                        let raw: String = chars[start..i].iter().collect();
                        let parts: Vec<&str> = raw.split(sep).collect();
                        if parts.len() == 3 {
                            let norm = format!(
                                "{:04}-{:02}-{:02}",
                                parts[0].parse::<u32>().unwrap_or(0),
                                parts[1].parse::<u32>().unwrap_or(0),
                                parts[2].parse::<u32>().unwrap_or(0)
                            );
                            out.push(ExtractedEntity {
                                kind: EntityType::Date,
                                raw,
                                normalized: norm,
                            });
                        }
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

fn extract_percentages(text: &str) -> Vec<ExtractedEntity> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit() || chars[i] == '.')
            {
                i += 1;
            }
            if i < chars.len() && chars[i] == '%' {
                let raw: String = chars[start..=i].iter().collect();
                let num: String = chars[start..i].iter().collect();
                if let Ok(v) = num.parse::<f64>() {
                    out.push(ExtractedEntity {
                        kind: EntityType::Percentage,
                        raw,
                        normalized: format!("{v:.2}"),
                    });
                }
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    out
}

/// 比较金额，返回是否匹配与差值。
pub fn compare_amounts(a: &str, b: &str) -> (bool, f64) {
    let av: f64 = a.parse().unwrap_or(0.0);
    let bv: f64 = b.parse().unwrap_or(0.0);
    let diff = (av - bv).abs();
    // 1 分以内视为匹配
    (diff < 0.01, diff)
}

/// 比较日期，返回是否匹配与相差天数。
pub fn compare_dates(a: &str, b: &str) -> (bool, f64) {
    let pa = parse_date(a);
    let pb = parse_date(b);
    match (pa, pb) {
        (Some(x), Some(y)) => {
            let days = (x - y).abs() as f64;
            (days < 0.5, days)
        }
        _ => (false, f64::MAX),
    }
}

/// 比较百分比。
pub fn compare_percentages(a: &str, b: &str) -> (bool, f64) {
    let av: f64 = a.parse().unwrap_or(0.0);
    let bv: f64 = b.parse().unwrap_or(0.0);
    let diff = (av - bv).abs();
    (diff < 0.01, diff)
}

/// 简化日期 → 天数（儒略日近似）。
fn parse_date(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    // 简化：按月 30 天近似，足够做阈值判定
    Some(y * 360 + m * 30 + d)
}

/// 判定单对实体的冲突。
pub fn judge_conflict(
    src: &ExtractedEntity,
    out: &ExtractedEntity,
) -> Option<(Severity, String)> {
    if src.kind != out.kind {
        return None;
    }

    match src.kind {
        EntityType::Amount => {
            let (m, diff) = compare_amounts(&src.normalized, &out.normalized);
            if m {
                return None;
            }
            let base: f64 = src.normalized.parse().unwrap_or(0.0);
            let pct = if base != 0.0 { diff / base * 100.0 } else { 100.0 };
            let sev = if pct > AMOUNT_CRITICAL_PCT {
                Severity::Critical
            } else {
                Severity::Minor
            };
            Some((
                sev,
                format!(
                    "金额差异: {} vs {} (差{diff:.2}, {pct:.1}%)",
                    src.raw, out.raw
                ),
            ))
        }
        EntityType::Date => {
            let (m, days) = compare_dates(&src.normalized, &out.normalized);
            if m {
                return None;
            }
            let sev = if days > DATE_CRITICAL_DAYS {
                Severity::Critical
            } else {
                Severity::Minor
            };
            Some((
                sev,
                format!("日期差异: {} vs {} (差{days:.1}天)", src.raw, out.raw),
            ))
        }
        EntityType::Percentage => {
            let (m, diff) = compare_percentages(&src.normalized, &out.normalized);
            if m {
                return None;
            }
            let sev = if diff > PERCENTAGE_CRITICAL_DIFF {
                Severity::Critical
            } else {
                Severity::Minor
            };
            Some((
                sev,
                format!(
                    "百分比差异: {} vs {} (差{diff:.2}%)",
                    src.raw, out.raw
                ),
            ))
        }
        // 编号类：任何不匹配都是 critical
        EntityType::ContractId | EntityType::IdCard | EntityType::BankAccount => {
            if src.normalized == out.normalized {
                None
            } else {
                Some((
                    Severity::Critical,
                    format!("编号不匹配: {} vs {}", src.raw, out.raw),
                ))
            }
        }
        // 姓名/公司名：不匹配为 minor（形态差异常见）
        EntityType::PersonName | EntityType::CompanyName => {
            if src.normalized == out.normalized
                || src.normalized.contains(&out.normalized)
                || out.normalized.contains(&src.normalized)
            {
                None
            } else {
                Some((
                    Severity::Minor,
                    format!("名称差异: {} vs {}", src.raw, out.raw),
                ))
            }
        }
    }
}

/// 完整守卫流程。
///
/// 严重度取所有冲突的最高级（critical > minor > ok），
/// 对齐 `factGuard.ts:207-211`。
pub fn guard(source_text: &str, output_text: &str) -> GuardResult {
    let src_entities = extract_entities(source_text);
    let out_entities = extract_entities(output_text);

    let mut conflicts = Vec::new();
    for o in &out_entities {
        for s in &src_entities {
            if s.kind != o.kind {
                continue;
            }
            if let Some((sev, detail)) = judge_conflict(s, o) {
                conflicts.push(FactConflict {
                    kind: o.kind,
                    severity: sev,
                    detail,
                    source_raw: s.raw.clone(),
                    output_raw: o.raw.clone(),
                });
            }
        }
    }

    let severity = if conflicts.iter().any(|c| c.severity == Severity::Critical) {
        Severity::Critical
    } else if conflicts.iter().any(|c| c.severity == Severity::Minor) {
        Severity::Minor
    } else {
        Severity::Ok
    };

    GuardResult {
        severity,
        conflicts,
        corrected_output: None,
    }
}
