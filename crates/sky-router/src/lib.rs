//! SKY 四段路由。
//!
//! 对应现状六层漏斗（`src/kernel/funnel.ts`）。六层 → 四段：
//! `Cache → Deterministic → Retrieval → Explore`。

pub mod stage;
pub mod stages;

pub use stage::{Candidate, Outcome, Route, RouteCtx, Router, Stage};
pub use stages::{CacheStage, DeterministicStage, ExploreStage, Matchable, RetrievalStage, Rule};

/// 构造默认四段路由器。
///
/// 顺序即优先级：缓存最便宜，探索最兜底。
pub fn default_router() -> Router {
    Router::new(vec![
        Box::new(CacheStage::default()),
        Box::new(DeterministicStage::with_default_rules()),
        Box::new(RetrievalStage::new(vec![])),
        Box::new(ExploreStage),
    ])
}
