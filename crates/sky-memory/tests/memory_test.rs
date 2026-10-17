//! sky-memory 测试。
//!
//! 重点：FactGuard 阈值边界（critical/minor 分界）、上下文裁剪规则。

use sky_core::ChatMessage;
use sky_memory::*;

fn msg(role: &str, content: &str) -> ChatMessage {
    ChatMessage {
        role: role.into(),
        content: content.into(),
        timestamp: None,
    }
}

// ==================== token 估算 ====================

#[test]
fn cjk_counts_one_per_char() {
    assert_eq!(estimate_tokens("中文测试"), 4);
}

#[test]
fn ascii_counts_one_per_four_chars() {
    assert_eq!(estimate_tokens("abcd"), 1);
    assert_eq!(estimate_tokens("abcdefgh"), 2);
}

#[test]
fn empty_text_zero_tokens() {
    assert_eq!(estimate_tokens(""), 0);
}

// ==================== 上下文裁剪 ====================

#[test]
fn trim_keeps_all_when_within_budget() {
    let msgs = vec![msg("user", "你好"), msg("assistant", "在")];
    let r = trim_to_budget(&msgs, 1000);
    assert_eq!(r.kept.len(), 2);
    assert_eq!(r.dropped, 0);
}

/// 核心语义：超预算时丢最旧的，保留最新的。
#[test]
fn trim_drops_oldest_first() {
    let msgs = vec![
        msg("user", "旧消息旧消息旧消息旧消息旧消息旧消息旧消息旧消息旧消息旧消息"),
        msg("assistant", "新"),
    ];
    let r = trim_to_budget(&msgs, 10);
    assert!(r.dropped >= 1, "超预算应丢弃旧消息");
    assert!(
        r.kept.iter().any(|m| m.content == "新"),
        "最新消息必须保留"
    );
}

/// system 消息永不裁剪。
#[test]
fn system_messages_never_dropped() {
    let msgs = vec![
        msg("system", "你是助手，必须遵守规则"),
        msg("user", "很长的用户消息很长的用户消息很长的用户消息很长的用户消息"),
        msg("assistant", "很长的助手回复很长的助手回复很长的助手回复很长的助手回复"),
    ];
    let r = trim_to_budget(&msgs, 5);
    assert!(
        r.kept.iter().any(|m| m.role == "system"),
        "system 消息不得被裁剪"
    );
}

/// 边界：单条最新消息就超预算 → 仍保留它（不能返回空上下文）。
#[test]
fn single_oversized_message_still_kept() {
    let msgs = vec![msg("user", &"很长的内容".repeat(100))];
    let r = trim_to_budget(&msgs, 1);
    assert_eq!(r.kept.len(), 1, "至少要保留一条消息");
}

#[test]
fn trim_empty_input() {
    let r = trim_to_budget(&[], 100);
    assert!(r.kept.is_empty());
    assert_eq!(r.dropped, 0);
    assert_eq!(r.total_tokens, 0);
}

#[test]
fn context_window_compact_reduces() {
    let mut w = ContextWindow::new(10);
    w.push(msg("system", "系统"));
    for i in 0..20 {
        w.push(msg("user", &format!("消息{i}")));
    }
    let before = w.len();
    let dropped = w.compact();
    assert!(dropped > 0);
    assert!(w.len() < before, "compact 后应更少");
    assert!(w.all().iter().any(|m| m.role == "system"));
}

// ==================== FactGuard 抽取 ====================

#[test]
fn extracts_currency_amount() {
    let e = extract_entities("合同金额 ¥1,500.00 元");
    assert!(e.iter().any(|x| x.kind == EntityType::Amount));
    let a = e.iter().find(|x| x.kind == EntityType::Amount).unwrap();
    assert_eq!(a.normalized, "1500.00");
}

#[test]
fn extracts_date_iso() {
    let e = extract_entities("签署日期 2026-10-11");
    assert!(e.iter().any(|x| x.kind == EntityType::Date));
    let d = e.iter().find(|x| x.kind == EntityType::Date).unwrap();
    assert_eq!(d.normalized, "2026-10-11");
}

#[test]
fn extracts_percentage() {
    let e = extract_entities("利率 3.5%");
    let p = e.iter().find(|x| x.kind == EntityType::Percentage).unwrap();
    assert_eq!(p.normalized, "3.50");
}

/// 拒绝用例：无货币符号的整数不得误判为金额。
#[test]
fn plain_integer_not_amount() {
    let e = extract_entities("共 100 个文件");
    assert!(
        !e.iter().any(|x| x.kind == EntityType::Amount),
        "普通整数不应被当金额"
    );
}

// ==================== 阈值边界 ====================

/// 金额：≤10% 差异为 minor。
#[test]
fn amount_within_10pct_is_minor() {
    let src = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "¥100".into(),
        normalized: "100.00".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "¥109".into(),
        normalized: "109.00".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Minor, "9% < 10% 应为 minor");
}

/// 金额：>10% 差异为 critical。
#[test]
fn amount_over_10pct_is_critical() {
    let src = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "¥100".into(),
        normalized: "100.00".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "¥111".into(),
        normalized: "111.00".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Critical, "11% > 10% 应为 critical");
}

#[test]
fn amount_identical_no_conflict() {
    let a = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "¥100".into(),
        normalized: "100.00".into(),
    };
    assert!(judge_conflict(&a, &a).is_none());
}

/// 日期：≤3 天为 minor。
#[test]
fn date_within_3days_is_minor() {
    let src = ExtractedEntity {
        kind: EntityType::Date,
        raw: "2026-10-01".into(),
        normalized: "2026-10-01".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Date,
        raw: "2026-10-04".into(),
        normalized: "2026-10-04".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Minor, "3 天应为 minor");
}

/// 日期：>3 天为 critical。
#[test]
fn date_over_3days_is_critical() {
    let src = ExtractedEntity {
        kind: EntityType::Date,
        raw: "2026-10-01".into(),
        normalized: "2026-10-01".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Date,
        raw: "2026-10-05".into(),
        normalized: "2026-10-05".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Critical, "4 天应为 critical");
}

/// 百分比：≤1 为 minor。
#[test]
fn percentage_within_1_is_minor() {
    let src = ExtractedEntity {
        kind: EntityType::Percentage,
        raw: "3%".into(),
        normalized: "3.00".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Percentage,
        raw: "4%".into(),
        normalized: "4.00".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Minor, "1.0 应为 minor");
}

#[test]
fn percentage_over_1_is_critical() {
    let src = ExtractedEntity {
        kind: EntityType::Percentage,
        raw: "3%".into(),
        normalized: "3.00".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::Percentage,
        raw: "5%".into(),
        normalized: "5.00".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Critical, "2.0 > 1.0 应为 critical");
}

/// 编号类：任何不匹配都是 critical（无 minor 档）。
#[test]
fn id_mismatch_always_critical() {
    let src = ExtractedEntity {
        kind: EntityType::ContractId,
        raw: "HT-001".into(),
        normalized: "HT-001".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::ContractId,
        raw: "HT-002".into(),
        normalized: "HT-002".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Critical);
}

#[test]
fn name_mismatch_is_minor() {
    let src = ExtractedEntity {
        kind: EntityType::PersonName,
        raw: "张三".into(),
        normalized: "张三".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::PersonName,
        raw: "李四".into(),
        normalized: "李四".into(),
    };
    let (sev, _) = judge_conflict(&src, &out).unwrap();
    assert_eq!(sev, Severity::Minor);
}

#[test]
fn name_containment_counts_as_match() {
    let src = ExtractedEntity {
        kind: EntityType::CompanyName,
        raw: "某某科技有限公司".into(),
        normalized: "某某科技有限公司".into(),
    };
    let out = ExtractedEntity {
        kind: EntityType::CompanyName,
        raw: "某某科技".into(),
        normalized: "某某科技".into(),
    };
    assert!(judge_conflict(&src, &out).is_none(), "包含关系视为匹配");
}

#[test]
fn different_kinds_never_conflict() {
    let a = ExtractedEntity {
        kind: EntityType::Amount,
        raw: "100".into(),
        normalized: "100.00".into(),
    };
    let b = ExtractedEntity {
        kind: EntityType::Percentage,
        raw: "100".into(),
        normalized: "100.00".into(),
    };
    assert!(judge_conflict(&a, &b).is_none());
}

// ==================== 完整守卫 ====================

#[test]
fn guard_ok_when_consistent() {
    let r = guard("金额 ¥1,500.00", "金额 ¥1,500.00");
    assert_eq!(r.severity, Severity::Ok);
    assert!(r.conflicts.is_empty());
}

#[test]
fn guard_critical_on_large_amount_diff() {
    let r = guard("金额 ¥1,000.00", "金额 ¥2,000.00");
    assert_eq!(r.severity, Severity::Critical);
}

#[test]
fn guard_takes_highest_severity() {
    // 一个 minor（金额小差）+ 一个 critical（日期大差）→ 总体 critical
    let r = guard(
        "金额 ¥1,000.00 日期 2026-10-01",
        "金额 ¥1,050.00 日期 2026-12-01",
    );
    assert_eq!(r.severity, Severity::Critical, "应取最高严重度");
}

#[test]
fn should_trigger_requires_roles_and_context() {
    assert!(should_trigger(&["legal".into()], "有内容"));
    assert!(!should_trigger(&[], "有内容"));
    assert!(!should_trigger(&["legal".into()], "   "));
}

// ==================== 比较函数 ====================

#[test]
fn compare_amounts_within_cent() {
    let (m, _) = compare_amounts("100.00", "100.005");
    assert!(m, "1 分以内视为匹配");
}

#[test]
fn compare_dates_same_day() {
    let (m, _) = compare_dates("2026-10-01", "2026-10-01");
    assert!(m);
}

#[test]
fn compare_dates_invalid_returns_max() {
    let (m, d) = compare_dates("bad", "2026-10-01");
    assert!(!m);
    assert_eq!(d, f64::MAX);
}
