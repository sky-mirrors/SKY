//! 逻辑接线层——把 8 个纯逻辑 crate 接进 UI。
//!
//! 这是 Wave 6a 骨架与 Wave 1–5 逻辑层之间的**唯一接缝**。
//! 设计目标：UI 层只调本模块，不直接依赖各 crate 的细节。
//!
//! 数据流（对应计划的核心数据流图）：
//! ```text
//! 用户输入
//!   → Router（四段：Cache → Deterministic → Retrieval → Explore）
//!   → TaskPlan
//!   → Executor（拓扑排序 + 逐步骤执行）
//!   → 结果 / 事件流
//! ```

use sky_core::{ChatMessage, RouteInput, TaskPlan};
use sky_exec::{execute_plan, ExecOptions, StepOutcome, StepRunner};
use sky_router::{default_router, Outcome, Router};
use std::collections::BTreeMap;

/// 一次请求的完整处理结果。
#[derive(Debug, Clone, PartialEq)]
pub struct PipelineResult {
    /// 命中的路由段名（`cache` / `deterministic` / `retrieval` / `explore`）。
    pub route_source: String,
    /// 路由置信度。
    pub route_confidence: f32,
    /// 路由产出的计划。
    pub plan: TaskPlan,
    /// 执行结果（若计划含步骤）。
    pub outcomes: Vec<StepOutcome>,
}

/// 接线层。
///
/// 持有 Router 实例。真实场景下还应持有 Cache、LLM 等，
/// 当前版本先打通「路由 → 执行」这条主干。
pub struct Pipeline {
    router: Router,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl Pipeline {
    pub fn new() -> Self {
        Self {
            router: default_router(),
        }
    }

    /// 仅路由——不执行。用于只想知道决策链的场景（如路由面板）。
    pub async fn route_only(&self, text: &str) -> RouteOutcome {
        let input = RouteInput {
            text: text.to_string(),
            ..Default::default()
        };

        match self.router.route(&input).await {
            Outcome::Resolved {
                plan,
                confidence,
                source,
            } => RouteOutcome::Resolved {
                source: source.to_string(),
                confidence,
                plan,
            },
            Outcome::NeedsArbitration(candidates) => RouteOutcome::NeedsArbitration {
                candidates: candidates.into_iter().map(|c| c.name).collect(),
            },
            Outcome::Unresolved => RouteOutcome::Unresolved,
        }
    }

    /// 完整链路：路由 → 执行。
    pub async fn run(&self, text: &str, runner: &dyn StepRunner) -> PipelineResult {
        let input = RouteInput {
            text: text.to_string(),
            ..Default::default()
        };

        let (route_source, route_confidence, plan) = match self.router.route(&input).await {
            Outcome::Resolved {
                plan,
                confidence,
                source,
            } => (source.to_string(), confidence, plan),
            Outcome::NeedsArbitration(candidates) => {
                // 歧义时取第一名作为计划来源，并在 source 中标注
                let names: Vec<String> = candidates.iter().map(|c| c.name.clone()).collect();
                let plan = TaskPlan {
                    intent: text.to_string(),
                    needs: names.clone(),
                    steps: vec![],
                };
                (format!("arbitration({})", names.join(",")), 0.5, plan)
            }
            Outcome::Unresolved => (
                "unresolved".to_string(),
                0.0,
                TaskPlan {
                    intent: text.to_string(),
                    needs: vec![],
                    steps: vec![],
                },
            ),
        };

        let outcomes = if plan.steps.is_empty() {
            vec![]
        } else {
            match execute_plan(&plan, runner, &ExecOptions::default(), None).await {
                Ok(r) => r.outcomes,
                Err(_) => vec![],
            }
        };

        PipelineResult {
            route_source,
            route_confidence,
            plan,
            outcomes,
        }
    }
}

/// 仅路由的结果。
#[derive(Debug, Clone, PartialEq)]
pub enum RouteOutcome {
    Resolved {
        source: String,
        confidence: f32,
        plan: TaskPlan,
    },
    NeedsArbitration {
        candidates: Vec<String>,
    },
    Unresolved,
}

/// 一个不做实际工作的 runner——用于验证链路连通性。
///
/// 它把每个步骤「执行」为一行说明文本，使 UI 能显示执行轨迹。
pub struct EchoRunner;

#[async_trait::async_trait]
impl StepRunner for EchoRunner {
    async fn run(
        &self,
        step: &sky_core::PlanStep,
        _results: &BTreeMap<u32, String>,
    ) -> Result<String, String> {
        Ok(format!("已执行 {}：{}", step.tool, step.description))
    }
}

/// 构造一条助手消息。
pub fn assistant_message(content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        role: "assistant".into(),
        content: content.into(),
        timestamp: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn route_only_hits_deterministic_for_known_pattern() {
        let p = Pipeline::new();
        match p.route_only("把文档转 pdf").await {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "deterministic"),
            other => panic!("期望 deterministic，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn route_only_falls_back_to_explore() {
        let p = Pipeline::new();
        match p.route_only("完全无关的输入 xyz").await {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "explore"),
            other => panic!("期望 explore，得到 {other:?}"),
        }
    }

    /// 关键：路由命中的计划必须携带可执行步骤，否则链路是断的。
    #[tokio::test]
    async fn deterministic_route_produces_executable_steps() {
        let p = Pipeline::new();
        let r = p.route_only("把文档转 pdf").await;
        match r {
            RouteOutcome::Resolved { plan, .. } => {
                assert!(!plan.steps.is_empty(), "确定性路由必须产出步骤");
                assert_eq!(plan.steps[0].tool, "doc_convert");
            }
            other => panic!("得到 {other:?}"),
        }
    }

    /// 全链路：路由 → 执行，步骤应被 EchoRunner 执行。
    #[tokio::test]
    async fn full_pipeline_executes_plan_steps() {
        let p = Pipeline::new();
        let r = p.run("把文档转 pdf", &EchoRunner).await;
        assert_eq!(r.route_source, "deterministic");
        assert_eq!(r.outcomes.len(), 1, "应有一步被执行");
        assert!(r.outcomes[0].is_success());
        assert!(r.outcomes[0].result.as_ref().unwrap().contains("doc_convert"));
    }

    /// 探索路径无步骤 → 不应调用执行器。
    #[tokio::test]
    async fn explore_path_has_no_steps() {
        let p = Pipeline::new();
        let r = p.run("完全无关 xyz", &EchoRunner).await;
        assert_eq!(r.route_source, "explore");
        assert!(r.outcomes.is_empty(), "探索计划无步骤，不应有执行结果");
    }

    #[tokio::test]
    async fn route_confidence_is_reported() {
        let p = Pipeline::new();
        let r = p.route_only("把文档转 pdf").await;
        match r {
            RouteOutcome::Resolved { confidence, .. } => {
                assert!(confidence > 0.0, "确定性命中应有置信度")
            }
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn assistant_message_sets_role() {
        let m = assistant_message("hi");
        assert_eq!(m.role, "assistant");
        assert_eq!(m.content, "hi");
    }
}
