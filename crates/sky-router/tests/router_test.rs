//! 四段路由的测试。
//!
//! 每段必须有**拒绝用例**：不匹配时返回 `Defer`，不得误命中。

use sky_core::RouteInput;
use sky_router::*;

fn input(text: &str) -> RouteInput {
    RouteInput {
        text: text.to_string(),
        ..Default::default()
    }
}

// ---------- CacheStage ----------

#[tokio::test]
async fn cache_defers_when_no_backend() {
    let stage = CacheStage::default();
    let mut ctx = RouteCtx::default();
    assert!(stage.try_resolve(&input("任意输入"), &mut ctx).await.is_defer());
}

#[tokio::test]
async fn cache_hits_above_threshold() {
    let mut stage = CacheStage::with_threshold(0.92);
    stage.lookup = Some(Box::new(|_q: &str| {
        Some((
            sky_core::TaskPlan {
                intent: "缓存命中".into(),
                needs: vec![],
                steps: vec![],
            },
            0.95,
        ))
    }));
    let mut ctx = RouteCtx::default();
    match stage.try_resolve(&input("x"), &mut ctx).await {
        Route::Hit { confidence, .. } => assert!((confidence - 0.95).abs() < 1e-6),
        other => panic!("期望 Hit，得到 {other:?}"),
    }
}

/// 拒绝用例：相似度低于阈值不得算命中。
#[tokio::test]
async fn cache_defers_below_threshold() {
    let mut stage = CacheStage::with_threshold(0.92);
    stage.lookup = Some(Box::new(|_q: &str| {
        Some((
            sky_core::TaskPlan {
                intent: "弱相似".into(),
                needs: vec![],
                steps: vec![],
            },
            0.50,
        ))
    }));
    let mut ctx = RouteCtx::default();
    assert!(
        stage.try_resolve(&input("x"), &mut ctx).await.is_defer(),
        "0.50 < 0.92 必须 Defer"
    );
}

// ---------- DeterministicStage ----------

#[tokio::test]
async fn deterministic_hits_on_all_keywords() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    match stage.try_resolve(&input("帮我把文档转成 PDF"), &mut ctx).await {
        Route::Hit { plan, .. } => assert_eq!(plan.steps[0].tool, "doc_convert"),
        other => panic!("期望 Hit，得到 {other:?}"),
    }
}

/// 拒绝用例：只命中部分关键词不得算命中。
#[tokio::test]
async fn deterministic_defers_on_partial_keywords() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    let r = stage.try_resolve(&input("转"), &mut ctx).await;
    assert!(r.is_defer(), "只命中「转」缺「pdf」，必须 Defer");
}

/// 拒绝用例：完全无关输入必须 Defer。
#[tokio::test]
async fn deterministic_defers_on_unrelated_input() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    assert!(
        stage
            .try_resolve(&input("今天天气怎么样"), &mut ctx)
            .await
            .is_defer()
    );
}

/// 置信度低于门槛时必须 Defer（三门值塌缩为一个的实际效果）。
#[tokio::test]
async fn deterministic_defers_when_confidence_below_min() {
    let stage = DeterministicStage {
        rules: vec![Rule {
            name: "weak",
            keywords: vec!["测试"],
            tool: "weak_tool",
            description: "弱规则",
            confidence: 0.3,
        }],
        min_confidence: 0.6,
    };
    let mut ctx = RouteCtx::default();
    assert!(stage.try_resolve(&input("测试一下"), &mut ctx).await.is_defer());
}

// ---------- RetrievalStage ----------

fn sample_items() -> Vec<Matchable> {
    vec![
        Matchable {
            id: "a".into(),
            name: "整理文件".into(),
            keywords: vec!["整理".into(), "文件".into()],
            tool: "file_organize".into(),
        },
        Matchable {
            id: "b".into(),
            name: "清理回收站".into(),
            keywords: vec!["清理".into(), "回收站".into()],
            tool: "recycle_clean".into(),
        },
    ]
}

#[tokio::test]
async fn retrieval_hits_single_clear_match() {
    let stage = RetrievalStage::new(sample_items());
    let mut ctx = RouteCtx::default();
    match stage.try_resolve(&input("帮我整理文件"), &mut ctx).await {
        Route::Hit { plan, .. } => assert_eq!(plan.steps[0].tool, "file_organize"),
        other => panic!("期望 Hit，得到 {other:?}"),
    }
}

/// 拒绝用例：无任何关键词命中必须 Defer。
#[tokio::test]
async fn retrieval_defers_on_no_match() {
    let stage = RetrievalStage::new(sample_items());
    let mut ctx = RouteCtx::default();
    assert!(
        stage
            .try_resolve(&input("写一首诗"), &mut ctx)
            .await
            .is_defer()
    );
}

/// 拒绝用例：候选为空集时不得吞掉后续段。
#[tokio::test]
async fn retrieval_defers_on_empty_items() {
    let stage = RetrievalStage::new(vec![]);
    let mut ctx = RouteCtx::default();
    assert!(stage.try_resolve(&input("任意"), &mut ctx).await.is_defer());
}

// ---------- ExploreStage ----------

/// 兜底段永不让路。
#[tokio::test]
async fn explore_never_defers() {
    let stage = ExploreStage;
    let mut ctx = RouteCtx::default();
    assert!(!stage.try_resolve(&input("任意输入"), &mut ctx).await.is_defer());
}

// ---------- Router ----------

#[tokio::test]
async fn router_executes_stages_in_order() {
    let r = default_router();
    assert_eq!(
        r.stage_names(),
        vec!["cache", "deterministic", "retrieval", "explore"]
    );
}

#[tokio::test]
async fn router_resolves_at_deterministic_before_explore() {
    let r = default_router();
    let out = r.route(&input("把文档转 pdf")).await;
    match out {
        Outcome::Resolved { source, .. } => assert_eq!(source, "deterministic"),
        other => panic!("期望 deterministic 命中，得到 {other:?}"),
    }
}

/// 全段 Defer 才 Unresolved——但 explore 兜底，所以默认路由器永不 Unresolved。
#[tokio::test]
async fn router_falls_back_to_explore() {
    let r = default_router();
    let out = r.route(&input("完全无关的输入 abcxyz")).await;
    match out {
        Outcome::Resolved { source, .. } => assert_eq!(source, "explore"),
        other => panic!("期望 explore 兜底，得到 {other:?}"),
    }
}

/// 只有 cache/deterministic 的路由器，无匹配时必须 Unresolved。
#[tokio::test]
async fn router_unresolved_without_fallback() {
    let r = Router::new(vec![
        Box::new(CacheStage::default()),
        Box::new(DeterministicStage::with_default_rules()),
    ]);
    let out = r.route(&input("今天天气怎么样")).await;
    assert!(matches!(out, Outcome::Unresolved), "得到 {out:?}");
}

/// 歧义必须转仲裁，不得静默选一个。
#[tokio::test]
async fn router_returns_arbitration_on_ambiguity() {
    // 两条 keywords 完全相同 → 分差 0 < margin 0.10，且都不够 green
    let items = vec![
        Matchable {
            id: "a".into(),
            name: "方案甲".into(),
            keywords: vec!["处理".into(), "数据".into()],
            tool: "tool_a".into(),
        },
        Matchable {
            id: "b".into(),
            name: "方案乙".into(),
            keywords: vec!["处理".into(), "数据".into()],
            tool: "tool_b".into(),
        },
    ];
    let r = Router::new(vec![Box::new(RetrievalStage::new(items))]);
    match r.route(&input("处理数据")).await {
        Outcome::NeedsArbitration(c) => assert_eq!(c.len(), 2),
        other => panic!("期望 NeedsArbitration，得到 {other:?}"),
    }
}
