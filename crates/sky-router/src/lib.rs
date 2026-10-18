//! SKY 路由。
//!
//! 对应现状六层漏斗（`src/kernel/funnel.ts`）。六层 → 五段：
//! `Cache → Manifest → Deterministic → Retrieval → Explore`。
//!
//! `Manifest` 段是「路由降级」的载体：命中任务书即产出完整多步计划，
//! 完全不调 LLM 规划器（省一次模型调用 + 任务书内多数节点是确定性工具）。

pub mod manifest_stage;
pub mod normalize;
pub mod route_cache;
pub mod stage;
pub mod stages;

pub use manifest_stage::{
    expand, is_host_slot, is_upstream_ref, ExpandOutcome, ManifestStage,
};
pub use normalize::normalize;
pub use route_cache::{RouteCache, ROUTE_CACHE_MAX_ENTRIES, ROUTE_CACHE_TTL};
pub use stage::{Candidate, Outcome, RouteCtx, Route, Router, Stage};
pub use stages::{CacheStage, DeterministicStage, ExploreStage, Matchable, RetrievalStage, Rule};

use std::sync::Arc;

/// 构造默认五段路由器。
///
/// 顺序即优先级：缓存最便宜，任务书次之（0 token），探索最兜底。
///
/// `ManifestStage` 放在 `Deterministic` 之前：任务书比单条关键词规则更具体
/// （多步 + 参数槽位），且能真正执行；硬编码规则的单步空参数计划常因缺参数失败。
pub fn default_router() -> Router {
    default_router_with_cache(Arc::new(route_cache::RouteCache::default())).0
}

/// 构造默认五段路由器，并注入共享的 [`RouteCache`]。
///
/// 与 [`default_router`] 的唯一区别：缓存后端是**真实接线**的——
/// 同一归一化文本的重复输入直接复用已解析的计划（含 manifest 多步计划与
/// explore+llm 规划结果），不再走重复匹配。
///
/// 返回 `(Router, Arc<RouteCache>)`：调用方持有 `Arc` 以便回填与观测。
pub fn default_router_with_cache(
    cache: std::sync::Arc<route_cache::RouteCache>,
) -> (Router, std::sync::Arc<route_cache::RouteCache>) {
    let lookup_cache = cache.clone();
    let router = Router::new(vec![
        Box::new(CacheStage {
            threshold: 0.92,
            // 精确命中返回 (plan, 1.0)——重复输入即是完全置信；
            // 见 route_cache::RouteCache::lookup 的文档。
            lookup: Some(Box::new(move |text: &str| {
                lookup_cache.lookup(text)
            })),
        }),
        Box::new(ManifestStage::with_builtin()),
        Box::new(DeterministicStage::with_default_rules()),
        Box::new(RetrievalStage::new(vec![])),
        Box::new(ExploreStage),
    ]);
    (router, cache)
}
