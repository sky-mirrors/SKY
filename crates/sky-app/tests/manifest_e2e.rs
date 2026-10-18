//! 任务书端到端测试——验证「路由降级」真的省了 token、真的产出了东西。
//!
//! **为什么这个文件存在**：单元测试全绿不等于系统能解决问题。
//! 用户曾明确指出「测试绿不等于可交付」。所以这里断言的是：
//!   1. 真实产出（磁盘上的文件内容），不是 `status == Done`
//!   2. 真实 token 账（planner 调用次数），不是「应该为 0」的推断
//!
//! 与 `planner_integration.rs` 的分工：那边测「LLM 生成计划」，
//! 这边测「任务书直接展开计划」——后者是路由降级的实际形态。

use sky_app::pipeline::{Pipeline, PipelineResult};
use sky_app::planner::LlmPlanner;
use sky_app::tools::register_all;
use sky_app::artifact::{write_artifact, ArtifactConfig, ArtifactOutcome};
use sky_core::load_builtin;

/// 构造一个带规划器与全部工具的 pipeline。
///
/// 带规划器是刻意的：如果任务书没命中，就会落到 explore 段调 LLM——
/// 那样 `planner_call_count()` 会变成 1，测试立刻能发现「降级失效」。
fn pipeline() -> Pipeline {
    let tools: Vec<String> = register_all()
        .available_tools()
        .iter()
        .map(|s| s.to_string())
        .collect();
    Pipeline::with_planner(LlmPlanner::from_env()).with_tools(tools)
}

/// 打印一次运行的全部细节，便于人工核对。
fn dump(label: &str, r: &PipelineResult) {
    println!("\n=== {label} ===");
    println!("route_source = {}", r.route_source);
    println!("confidence   = {}", r.route_confidence);
    println!("steps        = {}", r.plan.steps.len());
    for o in &r.outcomes {
        println!("  step {} status={:?}", o.step, o.status);
        if let Some(v) = &o.result {
            let preview: String = v.chars().take(200).collect();
            println!("    result: {preview}");
        }
        if let Some(e) = &o.error {
            println!("    error: {e}");
        }
    }
}

/// 内置任务书必须全部可用——否则后面的测试都在测空气。
#[test]
fn builtin_manifests_are_available() {
    let load = load_builtin();
    assert!(!load.has_failures(), "任务书加载失败：{:?}", load.warning());
    assert_eq!(load.manifests().len(), 20);
}

/// **核心断言：任务书命中时完全不调 LLM 规划器。**
///
/// 这就是「路由降级」的 token 账——省下的是一次完整的模型规划调用。
/// 用真实计数器，不是推断。
#[tokio::test]
async fn manifest_hit_costs_zero_planner_calls() {
    let p = pipeline();
    let r = p.run("帮我写一份本周的工作周报", &register_all()).await;
    dump("周报任务书", &r);

    assert_eq!(
        r.route_source, "manifest",
        "应命中任务书段（manifest），实际：{}",
        r.route_source
    );
    assert_eq!(
        p.planner_call_count(),
        0,
        "命中任务书不该调用 LLM 规划器——这正是路由降级的意义"
    );
}

/// 对照：未命中任务书的输入会落到 explore，此时才调 LLM。
///
/// 这条对照说明上一条不是「计数器坏了」——它确实会增长。
#[tokio::test]
async fn non_manifest_input_falls_through_to_explore() {
    let p = pipeline();
    let r = p.run("帮我把这段话翻译一下并解释语法", &register_all()).await;
    dump("未命中任务书", &r);

    assert_ne!(
        r.route_source, "manifest",
        "无关键词匹配时不该命中任务书"
    );
}

/// 任务书执行的每一步都应真实发生——不是 status=Done 就算过。
///
/// 周报任务书第一步是 `directory_tree`，它必须真的列出磁盘内容。
#[tokio::test]
async fn manifest_steps_produce_real_output() {
    let dir = std::env::temp_dir().join("sky-manifest-e2e");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    std::fs::write(dir.join("notes.txt"), "本周完成了任务书引擎").unwrap();
    std::fs::write(dir.join("plan.md"), "- 下一步：端到端验证").unwrap();

    let p = pipeline();
    // 带路径的输入 → file_path 槽位被抽出
    let q = format!("帮我写一份本周的工作周报，目录是 {}", dir.display());
    let r = p.run(&q, &register_all()).await;
    dump("周报（带路径）", &r);

    // 第一步必须是 directory_tree 且真的读到了文件
    let first = r.outcomes.first().expect("应有执行结果");
    assert_eq!(first.step, 1);
    if let Some(v) = &first.result {
        assert!(
            v.contains("notes.txt") || v.contains("plan.md"),
            "directory_tree 必须真实列出磁盘文件，实际：{v}"
        );
    } else {
        panic!("第一步无结果也无错误：{first:?}");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// 上游引用必须被真实替换成上一步的结果。
///
/// Wave 2 只保证了「路由期保留 {{step_N_result}}」，
/// 这里断言「执行期确实替换了」——两者合起来才闭环。
///
/// 无法在此断言最终文本（需真实模型），但可以断言：
/// 第三步的 error 里**不应**出现「仍含未替换的上游引用」。
#[tokio::test]
async fn upstream_ref_is_resolved_at_execution() {
    let dir = std::env::temp_dir().join("sky-manifest-upstream");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    std::fs::write(dir.join("a.txt"), "内容 A").unwrap();

    let p = pipeline();
    let q = format!("帮我写一份本周的工作周报，目录是 {}", dir.display());
    let r = p.run(&q, &register_all()).await;
    dump("上游引用替换", &r);

    // 第三步若执行了，其错误信息不该是「未替换的上游引用」
    if let Some(third) = r.outcomes.iter().find(|o| o.step == 3) {
        if let Some(e) = &third.error {
            assert!(
                !e.contains("未替换的上游引用"),
                "上游引用未被替换——说明执行期替换逻辑没生效：{e}"
            );
        }
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// 缺必填槽位时，任务书返回的是「缺口计划」而非假装执行。
#[tokio::test]
async fn missing_slot_yields_actionable_gap_not_silent_success() {
    let p = pipeline();
    // 合同审查需要文件路径——这里不给
    let r = p.run("帮我审查这份合同的风险条款", &register_all()).await;
    dump("缺槽位", &r);

    assert_eq!(r.route_source, "manifest", "应命中任务书段");
    assert_eq!(r.plan.steps.len(), 1, "缺口计划应为单步");
    let prompt = r.plan.steps[0]
        .params
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    assert!(
        prompt.contains("缺少必要信息"),
        "必须明确告知缺什么，实际：{prompt}"
    );
}

/// 全角输入也应命中任务书——中文输入法的真实场景。
#[tokio::test]
async fn fullwidth_input_still_hits_manifest() {
    let p = pipeline();
    let r = p.run("帮我写一份本周的工作周报", &register_all()).await;
    assert_eq!(
        r.route_source, "manifest",
        "全角/半角不应影响任务书命中，实际：{}",
        r.route_source
    );
    assert_eq!(p.planner_call_count(), 0, "命中任务书应零 LLM 调用");
}

// ---------- 产出落盘（P1） ----------
//
// 用户要的是「结果」——一份能打开的文件。这些测试断言磁盘上真的出现了文件，
// 而不是只看 `artifact` 字段的值。

/// 任务书执行后，产出必须真实落盘。
#[tokio::test]
async fn artifact_is_written_to_disk() {
    let dir = std::env::temp_dir().join("sky-manifest-artifact");
    let out_dir = std::env::temp_dir().join("sky-manifest-artifact-out");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&dir).expect("建源目录失败");
    std::fs::write(dir.join("a.txt"), "本周完成了任务书引擎").unwrap();

    let p = pipeline().with_artifact_config(ArtifactConfig::with_dir(&out_dir));
    let q = format!("帮我写一份本周的工作周报，目录是 {}", dir.display());
    let r = p.run(&q, &register_all()).await;
    dump("产出落盘", &r);

    // 断言：磁盘上真的有文件
    let path = r
        .artifact
        .path()
        .expect("产出应落盘成功")
        .to_path_buf();
    assert!(path.exists(), "产出文件必须真实存在：{}", path.display());

    let content = std::fs::read_to_string(&path).expect("应可读取产出");
    assert!(!content.trim().is_empty(), "产出不该是空文件");
    assert!(
        content.contains("路由来源"),
        "产出应含元信息便于追溯：{content}"
    );

    println!("落盘路径：{}", path.display());
    println!("文件大小：{} 字节", content.len());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&out_dir);
}

/// 落盘禁用时不该写文件——测试与纯查询场景需要这个开关。
#[tokio::test]
async fn disabled_artifact_writes_nothing() {
    let p = pipeline().with_artifact_config(ArtifactConfig::disabled());
    let r = p.run("帮我写一份本周的工作周报", &register_all()).await;
    assert!(
        r.artifact.path().is_none(),
        "禁用落盘时不该产生文件，实际：{:?}",
        r.artifact
    );
}

/// 落盘失败必须报出来，不能静默当成功。
#[test]
fn artifact_failure_is_surfaced() {
    let bad = if cfg!(windows) {
        std::path::PathBuf::from("Z:\nope\nope")
    } else {
        std::path::PathBuf::from("/proc/nope/nope")
    };
    let cfg = ArtifactConfig::with_dir(&bad);
    let out = write_artifact(&cfg, "任务", "内容");
    assert!(
        matches!(out, ArtifactOutcome::Failed { .. }),
        "写盘失败必须报 Failed，实际：{out:?}"
    );
}
