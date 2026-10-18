//! 论文阅读台（Paper Reader）——领域工作台样板（95 册 §9.7 第 2 步）。
//!
//! **它示范什么**：领域包的 UI 体感层如何消费 WorkMode 动作表——
//! 每个按钮 = 一个规范化 `WorkAction`，经 `Pipeline::dispatch_work_action`
//! 走规范化键缓存。同一篇论文第二次点「翻译本段」= 0 路由成本；
//! `llm_generate` 层的指纹缓存再省一次模型调用。
//!
//! **为什么这是样板而不是特例**：动作表（`work_mode()`）就是领域包
//! workmode 声明的形状——未来任何领域的阅读/审查台（法务合同台、
//! 财务报表台）都按同样的三元组落：动作表（声明）→ 按钮（UI）
//! → dispatch（执行 + 缓存）。
//!
//! minimap：段落锚点列表（每段一个定位按钮 + 已缓存标记）——
//! 真实 PDF 渲染层不在本样板范围（那是 UI 迁移阶段的事），
//! 这里用文档分段索引呈现同样的体感结构。

use crate::pipeline::{Pipeline, RouteOutcome};
use sky_pack::WorkAction;
use std::sync::Arc;

/// 论文分段——minimap 与动作槽位的共同数据源。
#[derive(Debug, Clone, PartialEq)]
pub struct PaperSection {
    /// 段落号（1 起始）。
    pub no: u32,
    /// 段落标题/首句摘要。
    pub digest: String,
}

/// 论文阅读台的 WorkMode 动作表。
///
/// 这是领域包声明自己工作台的**代码形状**：动作名 + 说明 + 默认槽位。
/// **动作名必须能被现有任务书路由匹配**（动作名即路由输入）——
/// 样板用「文档翻译 / 数据摘要 / 政策问答」三份任务书的同义语义。
/// 论文专属任务书（段落翻译 DAG / 论文问答 DAG）是领域包内容层的活，
/// 接入后只需改这里的动作名，按钮与缓存机制不变。
pub fn paper_work_mode() -> sky_pack::WorkMode {
    sky_pack::WorkMode::new("paper-reader")
        .action(
            WorkAction::new("帮我把这份文档翻译成英文")
                .slot("lang_target", "zh"),
        )
        .action(WorkAction::new("帮我对这份数据做摘要分析"))
        .action(WorkAction::new("帮我根据这份规定做政策问答"))
}

/// 默认分段（样板文档：真实场景由 PDF 抽取工具产出）。
pub fn default_sections() -> Vec<PaperSection> {
    vec![
        PaperSection { no: 1, digest: "摘要：本文提出……".into() },
        PaperSection { no: 2, digest: "引言：现有方法的局限……".into() },
        PaperSection { no: 3, digest: "方法：我们设计……".into() },
        PaperSection { no: 4, digest: "实验：在三个数据集上……".into() },
        PaperSection { no: 5, digest: "结论：未来工作……".into() },
    ]
}

/// 为「第 no 段」实例化一个动作（槽位注入段落号与该段摘要）。
pub fn action_for(action_name: &str, section: &PaperSection) -> Option<WorkAction> {
    let mut a = match action_name {
        "translate" => WorkAction::new("帮我把这份文档翻译成英文").slot("lang_target", "zh"),
        "summarize" => WorkAction::new("帮我对这份数据做摘要分析"),
        "ask" => WorkAction::new("帮我根据这份规定做政策问答"),
        _ => return None,
    };
    a = a
        .slot("paragraph", section.no.to_string())
        .slot("digest", section.digest.clone());
    Some(a)
}

/// 阅读台状态：当前段、已触发动作的产出、minimap 缓存命中标记。
#[derive(Debug, Default, Clone)]
pub struct ReaderState {
    pub current: u32,
    /// (动作名, 段落号, 产出文本, 是否缓存命中)
    pub outputs: Vec<(String, u32, String, bool)>,
}

impl ReaderState {
    /// 触发一个动作：dispatch → 记录产出与是否缓存命中。
    pub async fn trigger(&mut self, pipeline: &Arc<Pipeline>, name: &str, section: &PaperSection) {
        let Some(action) = action_for(name, section) else {
            return;
        };
        let outcome = pipeline.dispatch_work_action(&action).await;
        let (text, hit) = match outcome {
            RouteOutcome::Resolved {
                source,
                plan,
                confidence,
            } => {
                let hit = source.starts_with("cache");
                (
                    format!(
                        "[{source} conf={confidence:.2}] 步骤 {}：{:?}",
                        plan.steps.len(),
                        plan.intent
                    ),
                    hit,
                )
            }
            other => (format!("{other:?}"), false),
        };
        self.outputs.push((name.to_string(), section.no, text, hit));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 动作表契约：三个核心动作都可实例化到任意段落，键可预测。
    #[test]
    fn work_mode_declares_three_actions() {
        let wm = paper_work_mode();
        assert_eq!(wm.pack_id, "paper-reader");
        assert_eq!(wm.actions.len(), 3);
        assert!(wm.get("帮我把这份文档翻译成英文").is_some());
    }

    #[test]
    fn action_for_injects_section_slots() {
        let s = PaperSection { no: 3, digest: "方法……".into() };
        let a = action_for("translate", &s).expect("translate 应存在");
        let key = a.canonical_key();
        assert!(
            key.starts_with("workmode:帮我把这份文档翻译成英文?"),
            "键形态错误：{key}"
        );
        assert!(key.contains("paragraph=3"), "键应含段落号：{key}");
        assert!(key.contains("digest="), "键应含段摘要：{key}");
    }

    #[test]
    fn unknown_action_returns_none() {
        let s = PaperSection { no: 1, digest: "x".into() };
        assert!(action_for("nonexistent", &s).is_none());
    }

    /// 键确定性：同段同动作两次实例化 → 同键（缓存命中的前提）。
    #[test]
    fn same_section_same_action_same_key() {
        let s = PaperSection { no: 2, digest: "引言……".into() };
        let k1 = action_for("summarize", &s).unwrap().canonical_key();
        let k2 = action_for("summarize", &s).unwrap().canonical_key();
        assert_eq!(k1, k2);
    }

    /// 样板核心价值：同段同动作第二次触发必须命中缓存（hit=true），
    /// 且产出来自规范化键回放。
    #[tokio::test]
    async fn second_trigger_of_same_section_hits_cache() {
        let pipeline = std::sync::Arc::new(Pipeline::new());
        let s = PaperSection { no: 2, digest: "引言：现有方法的局限……".into() };
        let mut rs = ReaderState::default();

        rs.trigger(&pipeline, "summarize", &s).await;
        let first_hit = rs.outputs.last().map(|(_, _, _, hit)| *hit).unwrap_or(false);
        assert!(!first_hit, "第一次触发不应命中缓存");

        rs.trigger(&pipeline, "summarize", &s).await;
        let last = rs.outputs.last().expect("应有产出");
        assert!(last.3, "第二次同段同动作应命中缓存，实际 {last:?}");
        assert_eq!(last.0, "summarize");
        assert_eq!(last.1, 2);
    }

    /// 不同段互不串缓存（键含段落号）。
    #[tokio::test]
    async fn different_sections_do_not_cross_hit() {
        let pipeline = std::sync::Arc::new(Pipeline::new());
        let s2 = PaperSection { no: 2, digest: "引言……".into() };
        let s3 = PaperSection { no: 3, digest: "方法……".into() };
        let mut rs = ReaderState::default();

        rs.trigger(&pipeline, "summarize", &s2).await;
        rs.trigger(&pipeline, "summarize", &s3).await;
        let last = rs.outputs.last().expect("应有产出");
        assert!(!last.3, "第 3 段不应命中第 2 段的缓存，实际 {last:?}");
    }
}
