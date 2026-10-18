//! LLM 规划器的真实集成测试。
//!
//! 需要 `SKY_GLM_API_KEY`。未设置时跳过而非失败。
//!
//! 运行：
//! ```bash
//! SKY_GLM_API_KEY=<key> cargo test -p sky-app --test planner_integration -- --nocapture
//! ```

use sky_app::{EchoRunner, LlmPlanner, Pipeline, PlanOutcome};

/// 真实调用 GLM 生成计划，并验证产出的计划合法可执行。
#[tokio::test]
async fn glm_generates_valid_plan() {
    let planner = LlmPlanner::from_env();
    if !planner.has_key() {
        eprintln!("跳过：未设置 SKY_GLM_API_KEY");
        return;
    }

    let outcome = planner
        .plan("把桌面上的图片按文件类型整理到不同文件夹")
        .await;

    match outcome {
        PlanOutcome::Planned(p) => {
            println!("intent = {}", p.intent);
            println!("needs  = {:?}", p.needs);
            for s in &p.steps {
                println!(
                    "  step {}: {} [{}] deps={:?}",
                    s.step, s.description, s.tool, s.depends_on
                );
            }

            assert!(!p.steps.is_empty(), "LLM 应产出至少一个步骤");
            assert!(p.steps.len() <= 5, "提示词要求最多 5 步");
            // 编号必须从 1 连续
            for (i, s) in p.steps.iter().enumerate() {
                assert_eq!(s.step, (i as u32) + 1, "步骤编号应连续");
            }
            // 依赖只能指向更早步骤（parse_plan 已校验，这里二次确认）
            for s in &p.steps {
                for d in &s.depends_on {
                    assert!(*d < s.step, "依赖必须指向更早步骤");
                }
            }
        }
        PlanOutcome::Unparsable { raw, reason } => {
            panic!("LLM 输出无法解析：{reason}\n原始输出：\n{raw}");
        }
        PlanOutcome::Failed(e) => panic!("LLM 调用失败：{e}"),
    }
}

/// 端到端：探索路径 → LLM 生成计划 → 执行。
#[tokio::test]
async fn explore_path_uses_llm_and_executes() {
    let planner = LlmPlanner::from_env();
    if !planner.has_key() {
        eprintln!("跳过：未设置 SKY_GLM_API_KEY");
        return;
    }

    let pipeline = Pipeline::with_planner(planner);

    // 这条输入不匹配任何确定性规则，必然走探索段
    let result = pipeline
        .run("帮我把一份很长的技术文档总结成三个要点", &EchoRunner)
        .await;

    println!("route_source = {}", result.route_source);
    println!("confidence   = {}", result.route_confidence);
    println!("steps        = {}", result.plan.steps.len());
    for o in &result.outcomes {
        println!("  outcome: step={} status={:?} result={:?}", o.step, o.status, o.result);
    }

    assert!(
        result.route_source.starts_with("explore"),
        "无关输入应走探索段，实际 {}",
        result.route_source
    );
    assert!(
        !result.plan.steps.is_empty(),
        "接入 LLM 后探索路径应有步骤，实际为空（route_source={}）",
        result.route_source
    );
    assert!(
        !result.outcomes.is_empty(),
        "计划有步骤则应被执行，实际无执行结果"
    );
}

/// 确定性路径不受 LLM 影响——保证不会误触发 LLM 调用。
#[tokio::test]
async fn deterministic_path_bypasses_llm() {
    let planner = LlmPlanner::from_env();
    if !planner.has_key() {
        eprintln!("跳过：未设置 SKY_GLM_API_KEY");
        return;
    }

    let pipeline = Pipeline::with_planner(planner);
    let r = pipeline.route_only("把文档转 pdf").await;

    match r {
        sky_app::RouteOutcome::Resolved { source, plan, .. } => {
            assert_eq!(source, "deterministic", "确定性输入不得走向 LLM");
            assert_eq!(plan.steps[0].tool, "doc_convert");
        }
        other => panic!("得到 {other:?}"),
    }
}
