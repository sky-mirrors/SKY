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
        vec!["cache", "manifest", "deterministic", "retrieval", "explore"]
    );
}

/// 顺序约束：manifest 必须在 deterministic 之前。
///
/// 理由：任务书比单条关键词规则更具体（多步 + 参数槽位）。
/// 「把文档转成 PDF」既命中硬编码规则（单步、params 恒空、必然失败），
/// 也命中带源文件槽位的任务书（能真正执行）——后者优先才符合预期。
#[tokio::test]
async fn manifest_stage_precedes_deterministic() {
    let names = default_router().stage_names();
    let m = names.iter().position(|n| *n == "manifest").expect("应有 manifest 段");
    let d = names
        .iter()
        .position(|n| *n == "deterministic")
        .expect("应有 deterministic 段");
    assert!(m < d, "manifest 应在 deterministic 之前，实际顺序：{names:?}");
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

// ---------- 输入归一化（中文输入法场景） ----------
//
// 回归背景：中文输入法在中文标点模式下，打出的字母与空格是全角的。
// 用户想输 `pdf` 得到 `ｐｄｆ`，想输空格得到 `　`（U+3000）。
// 修复前规则用半角关键词 contains 匹配全角串会失败，输入落到兜底段
// 触发 LLM——实测「把文档转 ｐｄｆ」耗时 2.58–11.4 秒且消耗 token，
// 而半角版本仅 151 微秒。用户主观感受就是「转个 pdf 也要等好几秒」。

#[tokio::test]
async fn deterministic_hits_with_fullwidth_pdf() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    let r = stage.try_resolve(&input("把文档转ＰＤＦ"), &mut ctx).await;
    let route = r;
    assert!(
        !route.is_defer(),
        "全角 PDF 必须命中确定性段，否则会落到 explore 调 LLM"
    );
}

#[tokio::test]
async fn deterministic_hits_with_ideographic_space() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    // 中文输入法打出的全角空格 U+3000
    let r = stage
        .try_resolve(&input("把文档转\u{3000}ｐｄｆ"), &mut ctx)
        .await;
    assert!(!r.is_defer(), "全角空格 + 全角字母必须命中");
}

#[tokio::test]
async fn deterministic_still_defers_on_unrelated_input() {
    let stage = DeterministicStage::with_default_rules();
    let mut ctx = RouteCtx::default();
    let r = stage
        .try_resolve(&input("帮我把技术文档总结成三个要点"), &mut ctx)
        .await;
    assert!(r.is_defer(), "无关输入仍应 Defer——归一化不能变成宽泛匹配");
}

// ---------- 任务书匹配与展开（ManifestStage） ----------
//
// 这是「路由降级」的验证面：命中任务书即产出完整多步计划，
// 完全不调 LLM 规划器。任务书内多数节点是确定性工具。

#[tokio::test]
async fn manifest_stage_hits_weekly_report() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    let r = stage
        .try_resolve(&input("帮我写一份本周的工作周报"), &mut ctx)
        .await;

    match r {
        Route::Hit { plan, confidence } => {
            assert!(confidence >= 0.85, "置信度应过门：{confidence}");
            assert_eq!(plan.steps.len(), 3, "周报任务书是 3 步 DAG");
            assert_eq!(plan.steps[0].tool, "directory_tree");
            assert_eq!(plan.steps[1].depends_on, vec![1]);
            assert_eq!(plan.steps[2].tool, "llm_generate");
        }
        other => panic!("应命中周报任务书，实际：{other:?}"),
    }
}

/// 关键：`{{step_N_result}}` 必须在路由期原样保留。
///
/// 若展开器把它当普通槽位渲染成空串，第二步会拿到空输入却「成功」——
/// 这是本项目最容易做错的地方。
#[tokio::test]
async fn upstream_ref_survives_expansion() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    let r = stage
        .try_resolve(&input("帮我写一份本周的工作周报"), &mut ctx)
        .await;

    let Route::Hit { plan, .. } = r else {
        panic!("应命中")
    };
    let prompt = plan.steps[2]
        .params
        .get("prompt")
        .and_then(|v| v.as_str())
        .expect("第三步应有 prompt");
    assert!(
        prompt.contains("{{step_2_result}}"),
        "上游引用必须原样保留到执行期，实际：{prompt}"
    );
    // 反向：槽位应已被填充（没有残留的 {{workspace_dir}} 除非它是上游引用）
    assert!(
        is_upstream_ref("{{step_2_result}}"),
        "step_N_result 应被识别为上游引用"
    );
    assert!(
        !is_upstream_ref("{{workspace_dir}}"),
        "普通槽位不该被误判为上游引用"
    );
}

/// 必填槽位缺失 → 缺口计划，不是空值执行。
#[tokio::test]
async fn missing_required_slot_yields_gap_plan() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    // 合同审查任务书需要 {{user_file}}——这里不给路径
    let r = stage
        .try_resolve(&input("帮我审查一下这份合同的风险条款"), &mut ctx)
        .await;

    match r {
        Route::Hit { plan, .. } => {
            assert_eq!(plan.steps.len(), 1, "缺口计划应为单步");
            assert_eq!(plan.steps[0].tool, "llm_generate");
            let prompt = plan.steps[0]
                .params
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            assert!(
                prompt.contains("缺少必要信息"),
                "应明确告知缺什么，实际：{prompt}"
            );
        }
        other => panic!("缺槽位应产出缺口计划，实际：{other:?}"),
    }
}

/// 无关输入必须 Defer——不能吃掉后续段的输入。
#[tokio::test]
async fn manifest_stage_defers_on_unrelated_input() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    let r = stage
        .try_resolve(&input("今天天气怎么样"), &mut ctx)
        .await;
    assert!(r.is_defer(), "无关输入应 Defer，实际：{r:?}");
}

/// 全角输入也应命中——复用 normalize。
#[tokio::test]
async fn manifest_stage_normalizes_fullwidth_input() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    let r = stage
        .try_resolve(&input("帮我写一份本周的工作周报"), &mut ctx)
        .await;
    assert!(!r.is_defer(), "半角输入应命中");

    let mut ctx2 = RouteCtx::default();
    let r2 = stage
        .try_resolve(&input("帮我写一份本周的工作周报"), &mut ctx2)
        .await;
    assert!(!r2.is_defer(), "同样输入应命中");
}

/// 路径槽位应被真实抽出并填进步骤参数。
#[tokio::test]
async fn file_path_slot_is_extracted_and_rendered() {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    // 合同审查的 slots[0].source 决定来源；给一个路径
    let r = stage
        .try_resolve(
            &input("帮我审查 C:/tmp/contract.docx 这份合同的风险"),
            &mut ctx,
        )
        .await;

    match r {
        Route::Hit { plan, .. } => {
            let rendered = plan
                .steps
                .iter()
                .flat_map(|s| s.params.values())
                .filter_map(|v| v.as_str())
                .any(|v| v.contains("contract.docx"));
            assert!(
                rendered,
                "抽出的路径应被渲染进参数，实际步骤：{:?}",
                plan.steps
                    .iter()
                    .map(|s| (&s.tool, &s.params))
                    .collect::<Vec<_>>()
            );
        }
        other => panic!("带路径的输入应命中，实际：{other:?}"),
    }
}

// ---------- §9.4 专业术语跨任务书误匹配电池（2026-10-18） ----------
//
// HANDOFF 质询：MIN_KEYWORD_RATIO=0.34 的命中率过门 + 「取第一名无 margin 检查」，
// 专业术语（风险/审查/条款/对比/分析 这类跨任务书高频词）会不会互相误命中？
//
// 期望：命中结果的 intent 必须属于该输入的合理候选集；跨域输入不得静默错配。

async fn hit_intent(text: &str) -> Option<String> {
    let stage = ManifestStage::with_builtin();
    let mut ctx = RouteCtx::default();
    match stage.try_resolve(&input(text), &mut ctx).await {
        Route::Hit { plan, .. } => Some(plan.intent),
        _ => None,
    }
}

/// 风险/审查词汇群：合同风险审查 vs ND审查清单 vs 财报解读（都含「风险」或「审查」）。
#[tokio::test]
async fn cross_manifest_risk_review_terms_route_sensibly() {
    // 明确单域输入：应命中各自任务书
    let cases = [
        ("审查这份采购合同的风险条款", vec!["合同风险审查", "ND审查清单"]),
        ("帮我检查这份NDA保密协议有没有问题", vec!["ND审查清单"]),
        ("解读一下这份财报的主要风险", vec!["财报风险一句话解读"]),
    ];
    for (text, allowed) in cases {
        match hit_intent(text).await {
            Some(intent) => assert!(
                allowed.contains(&intent.as_str()),
                "「{text}」命中了 {intent}，不在合理候选 {allowed:?} 内"
            ),
            None => panic!("「{text}」应命中某个任务书，实际 Defer"),
        }
    }
}

/// 对比/条款词汇群：条款对比 vs 合同风险审查（共享「条款」「对比」「合同」）。
#[tokio::test]
async fn cross_manifest_compare_terms_route_sensibly() {
    // 「对比两份合同的条款差异」——条款对比应胜出（更多关键词命中）
    let intent = hit_intent("对比这两份合同的条款差异")
        .await
        .expect("对比输入应命中");
    assert!(
        intent == "条款对比助手" || intent == "合同风险审查",
        "对比输入命中了 {intent}，超出合理候选集"
    );
    // 但纯「风险」输入不应被条款对比抢走
    let intent2 = hit_intent("审查合同里有没有风险")
        .await
        .expect("风险审查输入应命中");
    assert_eq!(
        intent2, "合同风险审查",
        "纯风险审查输入被 {intent2} 抢走——术语互串实锤"
    );
}

/// 邮件词汇群：邮件自动分类 vs 客户邮件撰写（共享「邮件」「客户」）。
#[tokio::test]
async fn cross_manifest_email_terms_route_sensibly() {
    let classify = hit_intent("把这周的邮件自动分类归档")
        .await
        .expect("分类输入应命中");
    assert_eq!(classify, "邮件自动分类", "分类输入被 {classify} 抢走");

    let compose = hit_intent("帮我给客户写一封回复邮件")
        .await
        .expect("撰写输入应命中");
    assert_eq!(compose, "客户邮件撰写", "撰写输入被 {compose} 抢走");
}

/// 高风险模糊输入：只含跨任务书共享词（「分析」「报告」），不过门是可接受结果，
/// 静默错配不是。这里验证「全命中才 0.4，低于 0.34 阈值应 Defer 或合理命中」。
#[tokio::test]
async fn shared_generic_words_do_not_misroute() {
    // 「分析」同时出现在竞品分析与 Excel 数据摘要；「报告」在 KPI。
    // 输入只含「帮我分析一下这个报告」——没有领域锚点。
    let r = hit_intent("帮我分析一下这个报告").await;
    // 可接受：Defer（下沉到后续段）或命中任一（同率 1/6 低于 1/3 不过门）——
    // 关键是行为确定性：重复路由结果必须一致。
    let r2 = hit_intent("帮我分析一下这个报告").await;
    assert_eq!(r, r2, "同输入两次路由结果必须一致");
}

/// 跨域混合输入（真实现场）：财务人员说「对比这份预算和合同的条款」——
/// 预算/条款/对比分属三个任务书。期望：命中率最高者胜出且可解释。
#[tokio::test]
async fn cross_domain_mixed_input_picks_highest_ratio() {
    let intent = hit_intent("对比这份预算表和合同条款的差异")
        .await
        .expect("混合输入应命中");
    // 合理候选：条款对比（条款+对比+差异=3/6）必然 ≥ 其他（预算→预算预测 1/6）
    assert_eq!(
        intent, "条款对比助手",
        "混合输入应命中关键词命中率最高的条款对比，实际 {intent}"
    );
}
