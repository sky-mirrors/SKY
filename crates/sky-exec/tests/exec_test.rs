//! sky-exec 测试。
//!
//! 重点：D-09 条件求值范围限定、H-6 失败不逃逸、拓扑排序与循环检测、
//! 断点复用、取消语义。

use sky_core::{PlanStep, TaskPlan};
use sky_exec::*;
use std::collections::BTreeMap;

fn step(n: u32, tool: &str, deps: Vec<u32>) -> PlanStep {
    PlanStep {
        step: n,
        description: format!("step {n}"),
        tool: tool.into(),
        depends_on: deps,
        params: BTreeMap::new(),
        expected_output: String::new(),
        fallback: None,
    }
}

fn plan(steps: Vec<PlanStep>) -> TaskPlan {
    TaskPlan {
        intent: "test".into(),
        needs: vec![],
        steps,
    }
}

// ==================== D-09 条件求值 ====================

/// D-09 回归：限定 from_step 时，不得被其他步骤的无关数字干扰。
#[test]
fn condition_scoped_to_from_step_ignores_other_numbers() {
    let mut results: BTreeMap<u32, String> = BTreeMap::new();
    // 步骤 1 的结果里有大数字（如文件大小），但与本条件无关
    results.insert(1, "文件大小 999999 字节".into());
    // 步骤 2 是真正的目标，amount 很小
    results.insert(2, "amount: 5".into());

    // 只看步骤 2 → 5 > 100 为假
    let r = evaluate_condition("$.output.amount > 100", &results, Some(2));
    assert!(!r, "D-09：限定 from_step 后不得被步骤 1 的 999999 误判为真");

    // 不限定范围时，扫描全部 → 会命中 999999（这是旧行为）
    let r_all = evaluate_condition("$.output.amount > 100", &results, None);
    assert!(r_all, "不限定范围时扫描全部结果");
}

#[test]
fn condition_amount_true_when_exceeds() {
    let mut r = BTreeMap::new();
    r.insert(1, "amount: 500".into());
    assert!(evaluate_condition("$.output.amount > 100", &r, Some(1)));
}

#[test]
fn condition_amount_false_when_below() {
    let mut r = BTreeMap::new();
    r.insert(1, "amount: 50".into());
    assert!(!evaluate_condition("$.output.amount > 100", &r, Some(1)));
}

#[test]
fn condition_accepts_total_and_total_amount() {
    let mut r = BTreeMap::new();
    r.insert(1, "total: 200".into());
    assert!(evaluate_condition("$.output.total > 100", &r, Some(1)));
    let mut r2 = BTreeMap::new();
    r2.insert(1, "totalAmount: 300".into());
    assert!(evaluate_condition("$.output.totalAmount > 100", &r2, Some(1)));
}

#[test]
fn condition_handles_thousand_separators() {
    let mut r = BTreeMap::new();
    r.insert(1, "amount: 1,500".into());
    assert!(evaluate_condition("$.output.amount > 1000", &r, Some(1)));
}

#[test]
fn condition_contains_true_and_false() {
    let mut r = BTreeMap::new();
    r.insert(1, "包含关键词：成功".into());
    assert!(evaluate_condition("$.output.contains('成功')", &r, Some(1)));
    assert!(!evaluate_condition("$.output.contains('失败')", &r, Some(1)));
}

#[test]
fn condition_contains_double_quotes() {
    let mut r = BTreeMap::new();
    r.insert(1, "ok".into());
    assert!(evaluate_condition("$.output.contains(\"ok\")", &r, Some(1)));
}

/// 拒绝用例：未知表达式形态返回 true（对齐现状兜底）。
#[test]
fn condition_unknown_expr_defaults_true() {
    let r = BTreeMap::new();
    assert!(evaluate_condition("some other expr", &r, None));
}

/// 拒绝用例：from_step 指向不存在的步骤 → 无候选 → 条件为假。
#[test]
fn condition_missing_from_step_is_false() {
    let mut r = BTreeMap::new();
    r.insert(1, "amount: 99999".into());
    assert!(!evaluate_condition("$.output.amount > 1", &r, Some(99)));
}

// ==================== 拓扑排序 ====================

#[test]
fn topo_orders_dependencies_first() {
    let p = plan(vec![step(3, "c", vec![2]), step(1, "a", vec![]), step(2, "b", vec![1])]);
    let order = topological_order(&p).unwrap();
    let pos = |n: u32| order.iter().position(|x| *x == n).unwrap();
    assert!(pos(1) < pos(2), "1 应在 2 前");
    assert!(pos(2) < pos(3), "2 应在 3 前");
}

#[test]
fn topo_independent_steps_sorted_by_number() {
    let p = plan(vec![step(5, "e", vec![]), step(2, "b", vec![]), step(9, "i", vec![])]);
    let order = topological_order(&p).unwrap();
    assert_eq!(order, vec![2, 5, 9]);
}

/// 拒绝用例：循环依赖必须报错而非死循环。
#[test]
fn topo_detects_cycle() {
    let p = plan(vec![step(1, "a", vec![2]), step(2, "b", vec![1])]);
    assert!(matches!(topological_order(&p), Err(ExecError::Cycle)));
}

#[test]
fn topo_self_cycle_detected() {
    let p = plan(vec![step(1, "a", vec![1])]);
    assert!(matches!(topological_order(&p), Err(ExecError::Cycle)));
}

/// 拒绝用例：依赖不存在的步骤不得 panic。
#[test]
fn topo_missing_dependency_does_not_panic() {
    let p = plan(vec![step(1, "a", vec![999])]);
    assert!(topological_order(&p).is_ok());
}

#[test]
fn topo_empty_plan_is_ok() {
    let p = plan(vec![]);
    assert_eq!(topological_order(&p).unwrap(), Vec::<u32>::new());
}

// ==================== 执行引擎 ====================

struct OkRunner;
#[async_trait::async_trait]
impl StepRunner for OkRunner {
    async fn run(
        &self,
        step: &PlanStep,
        _results: &BTreeMap<u32, String>,
    ) -> Result<String, String> {
        Ok(format!("out-{}", step.step))
    }
}

/// 第 N 步失败的 runner。
struct FailAtRunner(u32);
#[async_trait::async_trait]
impl StepRunner for FailAtRunner {
    async fn run(
        &self,
        step: &PlanStep,
        _results: &BTreeMap<u32, String>,
    ) -> Result<String, String> {
        if step.step == self.0 {
            Err("boom".into())
        } else {
            Ok(format!("out-{}", step.step))
        }
    }
}

#[tokio::test]
async fn executes_all_steps_in_order() {
    let p = plan(vec![step(1, "a", vec![]), step(2, "b", vec![1])]);
    let r = execute_plan(&p, &OkRunner, &ExecOptions::default(), None)
        .await
        .unwrap();
    assert!(r.all_succeeded());
    assert_eq!(r.outcomes.len(), 2);
    assert_eq!(r.last_result(), Some("out-2"));
}

/// H-6 回归：单步失败不得中断整条宏。
#[tokio::test]
async fn step_failure_does_not_abort_macro() {
    let p = plan(vec![
        step(1, "a", vec![]),
        step(2, "b", vec![]),
        step(3, "c", vec![]),
    ]);
    let r = execute_plan(&p, &FailAtRunner(2), &ExecOptions::default(), None)
        .await
        .unwrap();

    assert_eq!(r.failed_steps, vec![2]);
    assert!(!r.all_succeeded());
    // 步骤 1、3 仍应执行（不依赖 2）
    assert_eq!(r.outcomes.len(), 3);
    assert!(r.outcomes.iter().any(|o| o.step == 1 && o.is_success()));
    assert!(r.outcomes.iter().any(|o| o.step == 3 && o.is_success()));
}

/// 依赖失败的步骤必须跳过，不得执行。
#[tokio::test]
async fn dependent_step_skipped_when_dependency_fails() {
    let p = plan(vec![step(1, "a", vec![]), step(2, "b", vec![1])]);
    let r = execute_plan(&p, &FailAtRunner(1), &ExecOptions::default(), None)
        .await
        .unwrap();

    let s2 = r.outcomes.iter().find(|o| o.step == 2).unwrap();
    assert_eq!(s2.status, StepStatus::Failed);
    assert!(s2.error.as_ref().unwrap().contains("依赖"), "错误应说明依赖问题");
}

#[tokio::test]
async fn replay_prior_results_marks_reused() {
    let p = plan(vec![step(1, "a", vec![]), step(2, "b", vec![1])]);
    let mut prior = BTreeMap::new();
    prior.insert(1, "cached-1".to_string());
    let opts = ExecOptions {
        replay_prior_results: prior,
        cancelled: false,
    };

    let r = execute_plan(&p, &OkRunner, &opts, None).await.unwrap();
    let s1 = r.outcomes.iter().find(|o| o.step == 1).unwrap();
    assert_eq!(s1.status, StepStatus::Reused);
    assert_eq!(s1.result.as_deref(), Some("cached-1"));
}

#[tokio::test]
async fn cancelled_run_stops_early() {
    let p = plan(vec![step(1, "a", vec![]), step(2, "b", vec![])]);
    let opts = ExecOptions {
        replay_prior_results: BTreeMap::new(),
        cancelled: true,
    };
    let r = execute_plan(&p, &OkRunner, &opts, None).await.unwrap();
    assert!(r.cancelled);
    assert!(r.outcomes.is_empty(), "取消后不应执行任何步骤");
}

#[tokio::test]
async fn events_emitted_in_order() {
    let p = plan(vec![step(1, "a", vec![])]);
    let mut events: Vec<ExecEvent> = Vec::new();
    let mut sink = |e: ExecEvent| events.push(e);

    execute_plan(&p, &OkRunner, &ExecOptions::default(), Some(&mut sink))
        .await
        .unwrap();

    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], ExecEvent::StepStart { step: 1, .. }));
    assert!(matches!(events[1], ExecEvent::StepDone { step: 1, .. }));
}

#[tokio::test]
async fn failure_emits_failed_event() {
    let p = plan(vec![step(1, "a", vec![])]);
    let mut events: Vec<ExecEvent> = Vec::new();
    let mut sink = |e: ExecEvent| events.push(e);

    execute_plan(&p, &FailAtRunner(1), &ExecOptions::default(), Some(&mut sink))
        .await
        .unwrap();

    assert!(events
        .iter()
        .any(|e| matches!(e, ExecEvent::StepFailed { step: 1, .. })));
}

// ==================== 条件跳过 ====================

#[test]
fn should_run_step_true_without_condition() {
    let s = step(1, "a", vec![]);
    assert!(should_run_step(&s, &BTreeMap::new(), None));
}

#[test]
fn should_run_step_false_when_condition_met_false() {
    let mut s = step(1, "a", vec![]);
    s.params.insert(
        "condition".into(),
        serde_json::Value::String("$.output.amount > 100".into()),
    );
    let mut results = BTreeMap::new();
    results.insert(1, "amount: 5".into());
    assert!(!should_run_step(&s, &results, Some(1)));
}

#[test]
fn should_run_step_true_when_condition_met_true() {
    let mut s = step(1, "a", vec![]);
    s.params.insert(
        "condition".into(),
        serde_json::Value::String("$.output.amount > 100".into()),
    );
    let mut results = BTreeMap::new();
    results.insert(1, "amount: 500".into());
    assert!(should_run_step(&s, &results, Some(1)));
}
