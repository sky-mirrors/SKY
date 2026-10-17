//! sky-pack 测试。
//!
//! 重点：四阶段事务性（失败不留部分状态）、DSL 校验、版本兼容。

use sky_pack::*;

fn c(id: &str, keyword: &str, rel: Reliability) -> PackConstraint {
    PackConstraint {
        id: id.into(),
        description: format!("约束 {id}"),
        applicability: Applicability::Keyword {
            keyword: keyword.into(),
        },
        reliability: rel,
        advice: None,
        enabled: true,
    }
}

// ==================== DSL 求值 ====================

#[test]
fn keyword_applicability_matches() {
    let cs = vec![c("c1", "合同", Reliability::Reliable)];
    let r = evaluate_constraints(&cs, "这份合同需要审核");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].reliability, Reliability::Reliable);
}

/// 拒绝用例：不适用时不得出现在结果中。
#[test]
fn non_applicable_constraint_excluded() {
    let cs = vec![c("c1", "合同", Reliability::Reliable)];
    let r = evaluate_constraints(&cs, "今天天气不错");
    assert!(r.is_empty(), "不适用约束不得返回");
}

#[test]
fn disabled_constraint_excluded() {
    let mut x = c("c1", "合同", Reliability::Reliable);
    x.enabled = false;
    let r = evaluate_constraints(&[x], "这份合同");
    assert!(r.is_empty(), "禁用约束不得参与求值");
}

#[test]
fn always_applicability_matches_all() {
    let cs = vec![PackConstraint {
        id: "c1".into(),
        description: "总是适用".into(),
        applicability: Applicability::Always,
        reliability: Reliability::NeedsReview,
        advice: Some("请确认".into()),
        enabled: true,
    }];
    assert_eq!(evaluate_constraints(&cs, "任意输入").len(), 1);
}

#[test]
fn reliability_serializes_lowercase() {
    let j = serde_json::to_string(&Reliability::NeedsReview).unwrap();
    assert_eq!(j, "\"needsreview\"");
}

// ==================== schema 校验 ====================

#[test]
fn valid_constraint_passes() {
    let x = c("c1", "合同", Reliability::Reliable);
    assert!(validate_pack_constraint(&x, 0).is_empty());
}

/// 拒绝用例：空 id。
#[test]
fn empty_id_rejected() {
    let mut x = c("", "合同", Reliability::Reliable);
    x.id = "  ".into();
    let errs = validate_pack_constraint(&x, 3);
    assert!(errs.iter().any(|e| e.field == "id"));
    assert_eq!(errs[0].index, 3);
}

#[test]
fn empty_description_rejected() {
    let mut x = c("c1", "合同", Reliability::Reliable);
    x.description = String::new();
    assert!(validate_pack_constraint(&x, 0)
        .iter()
        .any(|e| e.field == "description"));
}

#[test]
fn empty_keyword_rejected() {
    let x = PackConstraint {
        id: "c1".into(),
        description: "d".into(),
        applicability: Applicability::Keyword {
            keyword: "  ".into(),
        },
        reliability: Reliability::Reliable,
        advice: None,
        enabled: true,
    };
    assert!(validate_pack_constraint(&x, 0)
        .iter()
        .any(|e| e.field == "applicability.keyword"));
}

#[test]
fn oversized_advice_rejected() {
    let mut x = c("c1", "合同", Reliability::Reliable);
    x.advice = Some("x".repeat(2001));
    assert!(validate_pack_constraint(&x, 0)
        .iter()
        .any(|e| e.field == "advice"));
}

#[test]
fn advice_at_limit_passes() {
    let mut x = c("c1", "合同", Reliability::Reliable);
    x.advice = Some("x".repeat(2000));
    assert!(validate_pack_constraint(&x, 0).is_empty());
}

// ==================== 四阶段挂载 ====================

struct FakeSource {
    manifest: Result<PackManifest, ()>,
    knowledge: Result<Vec<KnowledgeEntry>, ()>,
    constraints: Result<Vec<PackConstraint>, ()>,
    execution: Result<Option<PackExecution>, ()>,
}

impl FakeSource {
    fn good() -> Self {
        Self {
            manifest: Ok(PackManifest {
                id: "p1".into(),
                version: "1.0.0".into(),
                domain: "legal".into(),
                min_host_version: None,
            }),
            knowledge: Ok(vec![KnowledgeEntry {
                id: "k1".into(),
                title: "标题".into(),
                body: "正文".into(),
            }]),
            constraints: Ok(vec![c("c1", "合同", Reliability::Reliable)]),
            execution: Ok(Some(PackExecution {
                mode: "direct".into(),
                steps: vec![],
            })),
        }
    }
}

impl PackSource for FakeSource {
    fn read_manifest(&self, id: &str) -> Result<PackManifest, MountError> {
        self.manifest.clone().map_err(|_| MountError {
            pack_id: id.into(),
            phase: MountPhase::Manifest,
            reason: MountFailReason::JsonParse,
            detail: "manifest 解析失败".into(),
        })
    }
    fn read_knowledge(&self, id: &str) -> Result<Vec<KnowledgeEntry>, MountError> {
        self.knowledge.clone().map_err(|_| MountError {
            pack_id: id.into(),
            phase: MountPhase::Knowledge,
            reason: MountFailReason::JsonParse,
            detail: "knowledge 解析失败".into(),
        })
    }
    fn read_constraints(&self, id: &str) -> Result<Vec<PackConstraint>, MountError> {
        self.constraints.clone().map_err(|_| MountError {
            pack_id: id.into(),
            phase: MountPhase::Boundary,
            reason: MountFailReason::JsonParse,
            detail: "constraints 解析失败".into(),
        })
    }
    fn read_execution(&self, id: &str) -> Result<Option<PackExecution>, MountError> {
        self.execution.clone().map_err(|_| MountError {
            pack_id: id.into(),
            phase: MountPhase::Execution,
            reason: MountFailReason::JsonParse,
            detail: "execution 解析失败".into(),
        })
    }
}

#[test]
fn mounts_all_four_phases() {
    let mut host = PackHost::new("0.1.0");
    let r = host.mount("p1", &FakeSource::good());
    assert!(r.is_ok(), "得到 {r:?}");
    assert!(host.is_mounted("p1"));
    let p = host.get("p1").unwrap();
    assert_eq!(p.manifest.id, "p1");
    assert_eq!(p.knowledge.len(), 1);
    assert_eq!(p.constraints.len(), 1);
    assert!(p.execution.is_some());
}

/// 事务性：manifest 失败 → 完全不挂载。
#[test]
fn manifest_failure_leaves_nothing_mounted() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    src.manifest = Err(());
    let r = host.mount("p1", &src);
    assert!(!r.is_ok());
    assert!(!host.is_mounted("p1"), "manifest 失败不得留下部分状态");
    assert_eq!(host.mounted_count(), 0);
}

/// 事务性：knowledge 失败 → 完全不挂载（尽管 manifest 已通过）。
#[test]
fn knowledge_failure_rolls_back() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    src.knowledge = Err(());
    let r = host.mount("p1", &src);
    assert!(!r.is_ok());
    assert!(!host.is_mounted("p1"), "knowledge 失败不得留下部分状态");
}

/// 事务性：boundary 的 schema 校验失败 → 完全不挂载。
#[test]
fn schema_failure_rolls_back() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    let mut bad = c("", "合同", Reliability::Reliable);
    bad.id = String::new();
    src.constraints = Ok(vec![bad]);
    let r = host.mount("p1", &src);
    match r {
        MountResult::Failed { error, .. } => {
            assert_eq!(error.phase, MountPhase::Boundary);
            assert_eq!(error.reason, MountFailReason::Schema);
        }
        other => panic!("期望 Failed，得到 {other:?}"),
    }
    assert!(!host.is_mounted("p1"));
}

#[test]
fn execution_failure_rolls_back() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    src.execution = Err(());
    assert!(!host.mount("p1", &src).is_ok());
    assert!(!host.is_mounted("p1"));
}

/// 拒绝用例：重复挂载。
#[test]
fn duplicate_mount_rejected() {
    let mut host = PackHost::new("0.1.0");
    assert!(host.mount("p1", &FakeSource::good()).is_ok());
    let r = host.mount("p1", &FakeSource::good());
    match r {
        MountResult::Failed { error, .. } => {
            assert_eq!(error.reason, MountFailReason::AlreadyMounted)
        }
        other => panic!("期望 AlreadyMounted，得到 {other:?}"),
    }
}

/// 兼容性：宿主版本过低 → 拒绝。
#[test]
fn incompatible_host_version_rejected() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    src.manifest = Ok(PackManifest {
        id: "p1".into(),
        version: "1.0.0".into(),
        domain: "legal".into(),
        min_host_version: Some("2.0.0".into()),
    });
    match host.mount("p1", &src) {
        MountResult::Failed { error, .. } => {
            assert_eq!(error.reason, MountFailReason::Incompatible)
        }
        other => panic!("期望 Incompatible，得到 {other:?}"),
    }
}

#[test]
fn compatible_host_version_accepted() {
    let mut host = PackHost::new("2.1.0");
    let mut src = FakeSource::good();
    src.manifest = Ok(PackManifest {
        id: "p1".into(),
        version: "1.0.0".into(),
        domain: "legal".into(),
        min_host_version: Some("2.0.0".into()),
    });
    assert!(host.mount("p1", &src).is_ok());
}

#[test]
fn missing_execution_warns_but_mounts() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    src.execution = Ok(None);
    match host.mount("p1", &src) {
        MountResult::Ok { warnings, .. } => {
            assert!(!warnings.is_empty(), "缺 execution 应给出 warning")
        }
        other => panic!("期望 Ok，得到 {other:?}"),
    }
    assert!(host.is_mounted("p1"));
}

#[test]
fn unmount_removes_pack() {
    let mut host = PackHost::new("0.1.0");
    host.mount("p1", &FakeSource::good());
    assert!(host.unmount("p1"));
    assert!(!host.is_mounted("p1"));
    assert!(!host.unmount("p1"), "重复卸载返回 false");
}

#[test]
fn list_returns_mounted_ids() {
    let mut host = PackHost::new("0.1.0");
    host.mount("p1", &FakeSource::good());
    assert_eq!(host.list(), vec!["p1".to_string()]);
}

#[test]
fn disabled_constraints_counted() {
    let mut host = PackHost::new("0.1.0");
    let mut src = FakeSource::good();
    let mut a = c("c1", "合同", Reliability::Reliable);
    a.enabled = false;
    src.constraints = Ok(vec![a, c("c2", "发票", Reliability::Reliable)]);
    match host.mount("p1", &src) {
        MountResult::Ok {
            constraints_total,
            constraints_disabled,
            ..
        } => {
            assert_eq!(constraints_total, 2);
            assert_eq!(constraints_disabled, 1);
        }
        other => panic!("期望 Ok，得到 {other:?}"),
    }
}
