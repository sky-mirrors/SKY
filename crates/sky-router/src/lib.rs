//! SKY 路由。
//!
//! 对应现状六层漏斗（`src/kernel/funnel.ts`）。六层 → 五段：
//! `Cache → Manifest → Deterministic → Retrieval → Explore`。
//!
//! `Manifest` 段是「路由降级」的载体：命中任务书即产出完整多步计划，
//! 完全不调 LLM 规划器（省一次模型调用 + 任务书内多数节点是确定性工具）。

pub mod manifest_stage;
pub mod normalize;
pub mod stage;
pub mod stages;

pub use manifest_stage::{
    expand, is_host_slot, is_upstream_ref, ExpandOutcome, ManifestStage,
};
pub use normalize::normalize;
pub use stage::{Candidate, Outcome, Route, RouteCtx, Router, Stage};
pub use stages::{CacheStage, DeterministicStage, ExploreStage, Matchable, RetrievalStage, Rule};

/// 构造默认五段路由器。
///
/// 顺序即优先级：缓存最便宜，任务书次之（0 token），探索最兜底。
///
/// `ManifestStage` 放在 `Deterministic` 之前：任务书比单条关键词规则更具体
/// （多步 + 参数槽位），且能真正执行；硬编码规则的单步空参数计划常因缺参数失败。
pub fn default_router() -> Router {
    Router::new(vec![
        Box::new(CacheStage::default()),
        Box::new(ManifestStage::with_builtin()),
        Box::new(DeterministicStage::with_default_rules()),
        Box::new(RetrievalStage::new(vec![])),
        Box::new(ExploreStage),
    ])
}
