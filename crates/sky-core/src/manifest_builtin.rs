
// ==================== 内置任务书 ====================

use crate::manifest::{parse_all, ManifestLoad};

/// 内置任务书来源：`(文件名, JSON 文本)`。
///
/// 用 `include_str!` 编译期嵌入——任务书是代码资产，随版本发布；
/// 运行时读盘会在打包后因路径变化失效。
///
/// **新增任务书只需两步**：把 JSON 放进 `config/l2_manifests/`，
/// 在下面加一行。测试 `all_builtin_manifests_parse` 会立刻验证它可解析。
pub const BUILTIN_SOURCES: &[(&str, &str)] = &[
    ("l2-announcement-draft.json", include_str!("../../../config/l2_manifests/l2-announcement-draft.json")),
    ("l2-budget-forecast.json", include_str!("../../../config/l2_manifests/l2-budget-forecast.json")),
    ("l2-client-email-compose.json", include_str!("../../../config/l2_manifests/l2-client-email-compose.json")),
    ("l2-competitor-analysis.json", include_str!("../../../config/l2_manifests/l2-competitor-analysis.json")),
    ("l2-contract-risk-review.json", include_str!("../../../config/l2_manifests/l2-contract-risk-review.json")),
    ("l2-data-excel-summary.json", include_str!("../../../config/l2_manifests/l2-data-excel-summary.json")),
    ("l2-doc-translate-en.json", include_str!("../../../config/l2_manifests/l2-doc-translate-en.json")),
    ("l2-email-categorizer.json", include_str!("../../../config/l2_manifests/l2-email-categorizer.json")),
    ("l2-financial-report-brief.json", include_str!("../../../config/l2_manifests/l2-financial-report-brief.json")),
    ("l2-kpi-report-gen.json", include_str!("../../../config/l2_manifests/l2-kpi-report-gen.json")),
    ("l2-legal-clause-compare.json", include_str!("../../../config/l2_manifests/l2-legal-clause-compare.json")),
    ("l2-meeting-minutes-gen.json", include_str!("../../../config/l2_manifests/l2-meeting-minutes-gen.json")),
    ("l2-nd-review-checklist.json", include_str!("../../../config/l2_manifests/l2-nd-review-checklist.json")),
    ("l2-onboarding-guide-gen.json", include_str!("../../../config/l2_manifests/l2-onboarding-guide-gen.json")),
    ("l2-policy-doc-qa.json", include_str!("../../../config/l2_manifests/l2-policy-doc-qa.json")),
    ("l2-ppt-outline-gen.json", include_str!("../../../config/l2_manifests/l2-ppt-outline-gen.json")),
    ("l2-reimbursement-check.json", include_str!("../../../config/l2_manifests/l2-reimbursement-check.json")),
    ("l2-resume-screening.json", include_str!("../../../config/l2_manifests/l2-resume-screening.json")),
    ("l2-sales-proposal-draft.json", include_str!("../../../config/l2_manifests/l2-sales-proposal-draft.json")),
    ("l2-weekly-report-draft.json", include_str!("../../../config/l2_manifests/l2-weekly-report-draft.json")),
];

/// 加载全部内置任务书。
pub fn load_builtin() -> ManifestLoad {
    parse_all(BUILTIN_SOURCES)
}

#[cfg(test)]
mod tests {
    use crate::manifest::referenced_tools;
    use super::*;

    /// 20 份内置任务书必须全部可解析。
    ///
    /// 这是防「静默丢失领域能力」的第一道闸：JSON 写坏了、
    /// 字段名拼错了，都会在这里红，而不是等用户点了发现没反应。
    #[test]
    fn all_builtin_manifests_parse() {
        let load = load_builtin();
        assert!(
            !load.has_failures(),
            "内置任务书必须全部可解析，实际失败：{:?}",
            load.warning()
        );
        assert_eq!(
            load.manifests().len(),
            BUILTIN_SOURCES.len(),
            "解析出的数量应与来源数量一致"
        );
        assert_eq!(load.manifests().len(), 20, "当前应有 20 份内置任务书");
    }

    /// 每份任务书都应有 id、name、keywords，否则无法被路由命中。
    #[test]
    fn every_manifest_has_routing_essentials() {
        let load = load_builtin();
        for m in load.manifests() {
            assert!(!m.identity.id.is_empty(), "{} 缺 id", m.identity.name);
            assert!(!m.identity.name.is_empty(), "存在无 name 的任务书");
            assert!(
                !m.routing.keywords.is_empty(),
                "{} 无 keywords，永远无法被命中",
                m.identity.name
            );
        }
    }

    /// 多步任务书必须至少有一个执行路径（dagPlan 或 directCall）。
    #[test]
    fn every_manifest_has_an_execution_path() {
        let load = load_builtin();
        for m in load.manifests() {
            let has_dag = m
                .execution
                .dag_plan
                .as_ref()
                .map(|d| !d.steps.is_empty())
                .unwrap_or(false);
            let has_direct = m.execution.direct_call.is_some();
            assert!(
                has_dag || has_direct,
                "{} 既无 dagPlan 也无 directCall，命中后无事可做",
                m.identity.name
            );
        }
    }

    /// DAG 的 depends_on 只能指向更小的步骤号（杜绝前向依赖与自依赖）。
    #[test]
    fn dag_dependencies_point_backwards_only() {
        let load = load_builtin();
        for m in load.manifests() {
            if let Some(plan) = &m.execution.dag_plan {
                for step in &plan.steps {
                    for dep in &step.depends_on {
                        assert!(
                            *dep < step.step,
                            "{} 的步骤 {} 依赖 {}——前向依赖会导致拓扑排序失败",
                            m.identity.name,
                            step.step,
                            dep
                        );
                    }
                }
            }
        }
    }

    /// 损坏的任务书必须报出来，不能静默丢弃。
    #[test]
    fn malformed_manifest_is_reported_not_silently_dropped() {
        let bad = r#"{"identity": {"id": "x", "name": "坏的"}, "routing": {"keywords": ["测试"]}}"#;
        // 缺 execution 字段 → 应失败
        let load = parse_all(&[("broken.json", bad)]);
        assert!(load.has_failures(), "缺必填字段必须报失败");
        let w = load.warning().expect("失败必须给出警告");
        assert!(w.contains("broken.json"), "警告应点名文件：{w}");
    }

    /// 一份坏的不影响其它好的——但坏的仍被记录。
    #[test]
    fn one_bad_manifest_does_not_break_the_rest() {
        let good = include_str!("../../../config/l2_manifests/l2-weekly-report-draft.json");
        let load = parse_all(&[("good.json", good), ("bad.json", "{not json")]);
        assert_eq!(load.manifests().len(), 1, "好的那份应可用");
        assert!(load.has_failures(), "坏的必须被记录");
        assert_eq!(load.manifests()[0].identity.name, "周报自动草稿");
    }

    /// 任务书引用的工具必须能被收集出来——供防漂移检查用。
    #[test]
    fn referenced_tools_collects_from_all_manifests() {
        let load = load_builtin();
        let tools = referenced_tools(load.manifests());
        assert!(!tools.is_empty(), "应收集到工具名");
        // 这些是 20 份任务书里实际出现的
        for expected in ["llm_generate", "read_file"] {
            assert!(
                tools.iter().any(|t| t == expected),
                "应收集到 {expected}，实际：{tools:?}"
            );
        }
    }

    /// 周报任务书的结构必须被完整解析——含槽位与上游引用。
    #[test]
    fn weekly_report_manifest_parses_slots_and_upstream_refs() {
        let load = load_builtin();
        let m = load
            .manifests()
            .iter()
            .find(|m| m.identity.id.starts_with("l2-weekly-report-draft"))
            .expect("应有周报任务书");

        let plan = m.execution.dag_plan.as_ref().expect("应为 macro 模式");
        assert_eq!(plan.steps.len(), 3, "周报任务书有 3 步");
        assert_eq!(plan.steps[0].tool, "directory_tree");
        assert_eq!(plan.steps[1].depends_on, vec![1]);
        assert_eq!(plan.steps[2].tool, "llm_generate");

        let pm = m.execution.param_mapping.as_ref().expect("应有 paramMapping");
        assert_eq!(pm.slots.len(), 1);
        assert_eq!(pm.slots[0].name, "{{workspace_dir}}");
        assert!(pm.slots[0].required);
        assert_eq!(pm.bindings.len(), 1);
        assert_eq!(pm.bindings[0].target_step, 1);
        assert_eq!(pm.bindings[0].target_param, "path");

        // 第三步的 prompt 里必须保留上游引用——路由期不能渲染它
        let prompt = plan.steps[2]
            .params
            .get("prompt")
            .and_then(|v| v.as_str())
            .expect("第三步应有 prompt");
        assert!(
            prompt.contains("{{step_2_result}}"),
            "上游引用必须原样保留在数据里：{prompt}"
        );
    }

    /// direct 模式的任务书应解析出 promptTemplate。
    #[test]
    fn direct_mode_manifest_parses_prompt_template() {
        let load = load_builtin();
        let m = load
            .manifests()
            .iter()
            .find(|m| m.identity.id.starts_with("l2-doc-translate-en"))
            .expect("应有翻译任务书");
        assert_eq!(m.execution.mode, "direct");
        let dc = m.execution.direct_call.as_ref().expect("应有 directCall");
        assert!(dc.prompt_template.contains("{{input}}"), "模板应含输入槽位");
    }
}
