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
/// 持有 Router 实例。`explore` 分支可选接 LLM 规划器——
/// 未注入时探索路径返回空计划（保持骨架行为）。
pub struct Pipeline {
    router: Router,
    planner: Option<crate::planner::LlmPlanner>,
    /// LLM 规划器被调用的次数。
    ///
    /// 存在的理由：一次用户发送必须只触发一次 LLM 调用（每次约 7 秒、
    /// 消耗 token）。曾经 UI 先调 `route_only` 再调 `run`，而 `run` 内部
    /// 又调一次 `route_only`，导致同一次发送调用两次 LLM。这个计数器让
    /// 该回归可被测试锁住，而不是靠读代码发现。
    planner_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
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
            planner: None,
            planner_calls: Default::default(),
        }
    }

    /// 接入 LLM 规划器——探索路径将由 LLM 生成计划。
    pub fn with_planner(planner: crate::planner::LlmPlanner) -> Self {
        Self {
            router: default_router(),
            planner: Some(planner),
            planner_calls: Default::default(),
        }
    }

    /// LLM 规划器累计被调用次数。供测试断言「一次发送一次调用」。
    pub fn planner_call_count(&self) -> usize {
        self.planner_calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 是否已接入 LLM 规划器。
    pub fn has_planner(&self) -> bool {
        self.planner.is_some()
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
            } => {
                // 探索段命中且接了规划器 → 由 LLM 生成真实计划
                if source == "explore" && plan.steps.is_empty() {
                    if let Some(planner) = &self.planner {
                        self.planner_calls
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        return match planner.plan(text).await {
                            crate::planner::PlanOutcome::Planned(p) => RouteOutcome::Resolved {
                                source: "explore+llm".to_string(),
                                confidence: 0.5,
                                plan: p,
                            },
                            crate::planner::PlanOutcome::Unparsable { reason, .. } => {
                                RouteOutcome::Resolved {
                                    source: "explore+llm(解析失败)".to_string(),
                                    confidence: 0.0,
                                    plan: TaskPlan {
                                        intent: text.to_string(),
                                        needs: vec![reason],
                                        steps: vec![],
                                    },
                                }
                            }
                            crate::planner::PlanOutcome::Failed(e) => RouteOutcome::Resolved {
                                source: "explore+llm(调用失败)".to_string(),
                                confidence: 0.0,
                                plan: TaskPlan {
                                    intent: text.to_string(),
                                    needs: vec![e],
                                    steps: vec![],
                                },
                            },
                        };
                    }
                }
                RouteOutcome::Resolved {
                    source: source.to_string(),
                    confidence,
                    plan,
                }
            }
            Outcome::NeedsArbitration(candidates) => RouteOutcome::NeedsArbitration {
                candidates: candidates.into_iter().map(|c| c.name).collect(),
            },
            Outcome::Unresolved => RouteOutcome::Unresolved,
        }
    }

    /// 完整链路：路由 → 执行。
    ///
    /// **复用 `route_only`**——避免路由逻辑在两处分叉。
    /// 曾经的实现各自复制了一份 router 调用，导致 planner 只接在
    /// `route_only` 而未接在 `run`，探索路径在完整链路里拿不到 LLM 计划。
    pub async fn run(&self, text: &str, runner: &dyn StepRunner) -> PipelineResult {
        let (route_source, route_confidence, plan) = match self.route_only(text).await {
            RouteOutcome::Resolved {
                source,
                confidence,
                plan,
            } => (source, confidence, plan),
            RouteOutcome::NeedsArbitration { candidates } => {
                let plan = TaskPlan {
                    intent: text.to_string(),
                    needs: candidates.clone(),
                    steps: vec![],
                };
                (format!("arbitration({})", candidates.join(",")), 0.5, plan)
            }
            RouteOutcome::Unresolved => (
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

    /// 回归：一次 `run()` 必须只调用一次 LLM 规划器。
    ///
    /// 曾经的 UI 实现先调 `route_only()` 再调 `run()`，而 `run()` 内部
    /// 又调一次 `route_only()`——同一次发送触发两次 LLM 调用，
    /// 实测耗时从 7 秒翻到 14 秒，用户看到的就是「没反应」。
    ///
    /// 这里用无密钥的 planner：调用会走 `Failed` 分支，但计数器照增，
    /// 因此能在不发真实网络请求的前提下断言调用次数。
    #[tokio::test]
    async fn run_calls_planner_exactly_once() {
        let p = Pipeline::with_planner(crate::planner::LlmPlanner::with_key(""));
        let _ = p.run("完全无关的输入 xyz", &EchoRunner).await;
        assert_eq!(
            p.planner_call_count(),
            1,
            "一次 run 只能触发一次 LLM 调用；多于 1 说明路由逻辑分叉了"
        );
    }

    /// 确定性路径不得触碰 LLM——既省 token 也省 7 秒等待。
    #[tokio::test]
    async fn deterministic_path_never_calls_planner() {
        let p = Pipeline::with_planner(crate::planner::LlmPlanner::with_key(""));
        let r = p.run("把文档转 pdf", &EchoRunner).await;
        assert_eq!(r.route_source, "deterministic");
        assert_eq!(
            p.planner_call_count(),
            0,
            "确定性命中不该调用 LLM"
        );
    }
}
