//! 宏执行引擎。
//!
//! 对应现状 `src/services/macroExecutor.ts:1473` `executeMacro` 与
//! `:1086` `executeStep`。
//!
//! **H-6 修复（必须保留）**：参数解析失败不得逃逸出单步——
//! 原实现在 `try` 之外调用 `resolveParams`，模板编译异常会令整条宏抛错，
//! 使工作流日志永久卡在 running 且 abort 控制器泄漏。
//! 现在改为如实标记该步失败并返回，由主循环按 fallback 策略处理。

use crate::condition::evaluate_condition;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sky_core::{PlanStep, TaskPlan};
use std::collections::{BTreeMap, BTreeSet};

/// 步骤状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
    /// 复用先前结果（断点续跑）。
    Reused,
}

/// 单步执行结果。
#[derive(Debug, Clone, PartialEq)]
pub struct StepOutcome {
    pub step: u32,
    pub status: StepStatus,
    pub result: Option<String>,
    pub error: Option<String>,
    /// 是否使用了 fallback。
    pub used_fallback: bool,
}

impl StepOutcome {
    pub fn done(step: u32, result: String) -> Self {
        Self {
            step,
            status: StepStatus::Done,
            result: Some(result),
            error: None,
            used_fallback: false,
        }
    }

    pub fn failed(step: u32, error: String) -> Self {
        Self {
            step,
            status: StepStatus::Failed,
            result: None,
            error: Some(error),
            used_fallback: false,
        }
    }

    pub fn skipped(step: u32) -> Self {
        Self {
            step,
            status: StepStatus::Skipped,
            result: None,
            error: None,
            used_fallback: false,
        }
    }

    pub fn reused(step: u32, result: String) -> Self {
        Self {
            step,
            status: StepStatus::Reused,
            result: Some(result),
            error: None,
            used_fallback: false,
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self.status, StepStatus::Done | StepStatus::Reused)
    }
}

/// 宏运行结果。
#[derive(Debug, Clone, PartialEq)]
pub struct MacroRunResult {
    pub outcomes: Vec<StepOutcome>,
    pub failed_steps: Vec<u32>,
    /// 是否被取消。
    pub cancelled: bool,
}

impl MacroRunResult {
    pub fn all_succeeded(&self) -> bool {
        self.failed_steps.is_empty() && !self.cancelled
    }

    pub fn last_result(&self) -> Option<&str> {
        self.outcomes
            .iter()
            .rev()
            .find_map(|o| o.result.as_deref())
    }
}

/// 执行错误。
#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("步骤 {0} 参数解析失败：{1}")]
    ParamResolve(u32, String),
    #[error("依赖的步骤 {0} 未成功")]
    DependencyFailed(u32),
    #[error("检测到循环依赖")]
    Cycle,
}

/// 步骤执行器抽象。实现方负责实际工具调用。
#[async_trait]
pub trait StepRunner: Send + Sync {
    /// 执行单步。返回 Ok(输出) 或 Err(错误)。
    async fn run(&self, step: &PlanStep, results: &BTreeMap<u32, String>) -> Result<String, String>;
}

/// 执行事件。对齐现状 executeMacro 的 5 个回调。
#[derive(Debug, Clone, PartialEq)]
pub enum ExecEvent {
    StepStart { step: u32, tool: String },
    StepDone { step: u32, result: String },
    StepFailed { step: u32, error: String },
    StepReused { step: u32 },
    StepSkipped { step: u32 },
}

/// 事件监听器。
pub type EventSink<'a> = &'a mut dyn FnMut(ExecEvent);

/// 执行配置。
#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    /// 断点续跑：这些步骤直接复用先前结果，不重新执行。
    pub replay_prior_results: BTreeMap<u32, String>,
    /// 取消标志。
    pub cancelled: bool,
}

/// 执行一条计划。
///
/// 语义对齐 `executeMacro`：
/// - 按 `depends_on` 拓扑顺序执行
/// - 依赖失败的步骤跳过（不执行）
/// - `replay_prior_results` 中的步骤标记为 Reused
/// - 取消时立即停止，剩余步骤保持 Pending
pub async fn execute_plan<R: StepRunner>(
    plan: &TaskPlan,
    runner: &R,
    opts: &ExecOptions,
    sink: Option<EventSink<'_>>,
) -> Result<MacroRunResult, ExecError> {
    let order = topological_order(plan)?;

    let mut results: BTreeMap<u32, String> = BTreeMap::new();
    let mut outcomes: Vec<StepOutcome> = Vec::new();
    let mut failed: Vec<u32> = Vec::new();
    let mut sink = sink;

    for step_num in order {
        let step = match plan.steps.iter().find(|s| s.step == step_num) {
            Some(s) => s.clone(),
            None => continue,
        };

        // 取消：立即停止
        if opts.cancelled {
            return Ok(MacroRunResult {
                outcomes,
                failed_steps: failed,
                cancelled: true,
            });
        }

        // 断点复用
        if let Some(prior) = opts.replay_prior_results.get(&step_num) {
            if let Some(s) = sink.as_mut() {
                s(ExecEvent::StepReused { step: step_num });
            }
            results.insert(step_num, prior.clone());
            outcomes.push(StepOutcome::reused(step_num, prior.clone()));
            continue;
        }

        // 依赖检查：任一依赖失败/未执行则跳过
        let dep_ok = step.depends_on.iter().all(|d| {
            outcomes
                .iter()
                .any(|o| o.step == *d && o.is_success())
        });
        if !dep_ok {
            let missing = step
                .depends_on
                .iter()
                .find(|d| {
                    !outcomes
                        .iter()
                        .any(|o| o.step == **d && o.is_success())
                })
                .copied()
                .unwrap_or(0);
            if let Some(s) = sink.as_mut() {
                s(ExecEvent::StepSkipped { step: step_num });
            }
            failed.push(step_num);
            outcomes.push(StepOutcome::failed(
                step_num,
                format!("依赖的步骤 {missing} 未成功"),
            ));
            continue;
        }

        if let Some(s) = sink.as_mut() {
            s(ExecEvent::StepStart {
                step: step_num,
                tool: step.tool.clone(),
            });
        }

        // H-6：执行失败不逃逸，如实标记并继续
        match runner.run(&step, &results).await {
            Ok(out) => {
                if let Some(s) = sink.as_mut() {
                    s(ExecEvent::StepDone {
                        step: step_num,
                        result: out.clone(),
                    });
                }
                results.insert(step_num, out.clone());
                outcomes.push(StepOutcome::done(step_num, out));
            }
            Err(e) => {
                if let Some(s) = sink.as_mut() {
                    s(ExecEvent::StepFailed {
                        step: step_num,
                        error: e.clone(),
                    });
                }
                failed.push(step_num);
                outcomes.push(StepOutcome::failed(step_num, e));
            }
        }
    }

    Ok(MacroRunResult {
        outcomes,
        failed_steps: failed,
        cancelled: false,
    })
}

/// 拓扑排序。无依赖的步骤按 step 号升序。
///
/// 检测循环依赖 → 返回 `ExecError::Cycle`。
pub fn topological_order(plan: &TaskPlan) -> Result<Vec<u32>, ExecError> {
    let mut visited: BTreeSet<u32> = BTreeSet::new();
    let mut in_progress: BTreeSet<u32> = BTreeSet::new();
    let mut order: Vec<u32> = Vec::new();

    // 按 step 号排序，保证同层稳定
    let mut nums: Vec<u32> = plan.steps.iter().map(|s| s.step).collect();
    nums.sort_unstable();

    fn visit(
        n: u32,
        plan: &TaskPlan,
        visited: &mut BTreeSet<u32>,
        in_progress: &mut BTreeSet<u32>,
        order: &mut Vec<u32>,
    ) -> Result<(), ExecError> {
        if visited.contains(&n) {
            return Ok(());
        }
        if in_progress.contains(&n) {
            return Err(ExecError::Cycle);
        }
        in_progress.insert(n);

        if let Some(step) = plan.steps.iter().find(|s| s.step == n) {
            let mut deps = step.depends_on.clone();
            deps.sort_unstable();
            for d in deps {
                // 依赖不存在的步骤视为错误依赖，跳过（不 panic）
                if plan.steps.iter().any(|s| s.step == d) {
                    visit(d, plan, visited, in_progress, order)?;
                }
            }
        }

        in_progress.remove(&n);
        visited.insert(n);
        order.push(n);
        Ok(())
    }

    for n in nums {
        visit(n, plan, &mut visited, &mut in_progress, &mut order)?;
    }

    Ok(order)
}

/// 判断某步是否应执行（条件为假则跳过）。
pub fn should_run_step(
    step: &PlanStep,
    results: &BTreeMap<u32, String>,
    from_step: Option<u32>,
) -> bool {
    match step.params.get("condition").and_then(|v| v.as_str()) {
        Some(expr) => evaluate_condition(expr, results, from_step),
        None => true,
    }
}
