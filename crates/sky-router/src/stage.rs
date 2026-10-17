//! 四段路由的核心抽象。
//!
//! 对应现状六层漏斗（`src/kernel/funnel.ts:102` 的 `LAYER_ORDER`）：
//!
//! | 现状层 | 目标段 |
//! |---|---|
//! | （漏斗之前） | `CacheStage` |
//! | L0 / L0.5 / L1 | `DeterministicStage` |
//! | L2 / L3 | `RetrievalStage` |
//! | L4 | `ExploreStage` |
//!
//! 合并依据：L0/L0.5/L1 都是「确定性、0 token、把输入匹配到已知计划」，
//! 区别只在数据源而非处理语义；L3 仅在 L2 出现 ≥2 候选时触发，是子策略而非独立层。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sky_core::{RouteInput, TaskPlan};

/// 路由阶段的产出。
#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    /// 命中：直接给出计划。
    Hit {
        plan: TaskPlan,
        confidence: f32,
    },
    /// 有多个候选，需要后续阶段仲裁。
    Candidates(Vec<Candidate>),
    /// 本段不处理，交给下一段。
    Defer,
}

impl Route {
    pub fn hit(plan: TaskPlan, confidence: f32) -> Self {
        Route::Hit { plan, confidence }
    }

    pub fn candidates(candidates: Vec<Candidate>) -> Self {
        Route::Candidates(candidates)
    }

    pub fn is_defer(&self) -> bool {
        matches!(self, Route::Defer)
    }
}

/// 候选工具/宏。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub score: f32,
}

/// 阶段上下文。带跨段累积信息。
#[derive(Debug, Clone, Default)]
pub struct RouteCtx {
    /// 已尝试过的阶段名，用于诊断。
    pub tried: Vec<&'static str>,
}

/// 路由阶段。
///
/// 契约：**不匹配时必须返回 `Defer`**，不允许用低置信度 `Hit` 冒充命中——
/// 现状 L0.5 门值从 0.8 降到 0.6 的教训正是「低置信度覆盖后续层」。
#[async_trait]
pub trait Stage: Send + Sync {
    fn name(&self) -> &'static str;
    async fn try_resolve(&self, input: &RouteInput, ctx: &mut RouteCtx) -> Route;
}

/// 路由最终产出。
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// 某段命中。
    Resolved {
        plan: TaskPlan,
        confidence: f32,
        source: &'static str,
    },
    /// 需要 LLM 仲裁。
    NeedsArbitration(Vec<Candidate>),
    /// 全段 Defer。
    Unresolved,
}

/// 顺序执行的路由器。
pub struct Router {
    stages: Vec<Box<dyn Stage>>,
}

impl Router {
    pub fn new(stages: Vec<Box<dyn Stage>>) -> Self {
        Self { stages }
    }

    /// 按序尝试各段，命中即返回。
    pub async fn route(&self, input: &RouteInput) -> Outcome {
        let mut ctx = RouteCtx::default();

        for stage in &self.stages {
            ctx.tried.push(stage.name());
            match stage.try_resolve(input, &mut ctx).await {
                Route::Hit { plan, confidence } => {
                    return Outcome::Resolved {
                        plan,
                        confidence,
                        source: stage.name(),
                    }
                }
                Route::Candidates(c) if !c.is_empty() => {
                    return Outcome::NeedsArbitration(c)
                }
                // 空候选等同 Defer——不让空集吞掉后续段
                Route::Candidates(_) | Route::Defer => continue,
            }
        }

        Outcome::Unresolved
    }

    /// 已注册的阶段名，按执行顺序。
    pub fn stage_names(&self) -> Vec<&'static str> {
        self.stages.iter().map(|s| s.name()).collect()
    }
}
