//! 真实执行器——按 `tool` 名分发到具体能力实现。
//!
//! **与 [`crate::pipeline::EchoRunner`] 的区别**（这个区别很重要）：
//!
//! | | `EchoRunner` | `RealRunner` |
//! |---|---|---|
//! | 用途 | 路由/链路测试 | 生产运行 |
//! | 行为 | 返回 `Ok("已执行 xxx")` | 真的做事，或明确报未接入 |
//! | 未实现工具 | 假装成功 | 返回 `Err`，步骤标为 `Failed` |
//!
//! **为什么「未实现」必须返回 `Err` 而不是 `Ok`**：
//! 返回 `Ok` 会让 UI 显示「已执行 doc_convert」，而实际上什么都没做。
//! 用户会以为文件已转换，去目标目录却找不到——这是最坏的一类 bug：
//! 系统在撒谎。返回 `Err` 后步骤状态是 `Failed`，UI 必须如实显示
//! 「能力未接入」，用户立刻知道真相。
//!
//! **当前状态**：所有工具都处于未接入状态。真实能力移植自现状
//! `src/services/macroExecutor.ts`（`doc_convert` 走 Electron 的
//! `docConvertToPdf`），需要逐个填入 [`ToolImpl`] 注册表。

use sky_exec::StepRunner;
use sky_core::PlanStep;
use std::collections::BTreeMap;

/// 一个工具的实现。
///
/// 用 `Box<dyn Fn>` 而非 trait 对象：工具实现是有副作用的异步函数，
/// 不需要状态也不需要多方法，闭包足够且接入成本最低。
pub type ToolImpl = Box<
    dyn Fn(&PlanStep, &BTreeMap<u32, String>) -> ToolFuture + Send + Sync,
>;

/// 工具执行的未来类型别名，避免在签名里重复写长异步类型。
pub type ToolFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<String, String>> + Send>,
>;

/// 真实执行器。
///
/// 只有注册在 `tools` 里的工具才能执行；其余一律报「未接入」。
/// 这个设计让「能力清单」成为显式数据，而不是散落在 match 分支里。
pub struct RealRunner {
    tools: BTreeMap<String, ToolImpl>,
}

impl Default for RealRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl RealRunner {
    /// 空执行器——所有工具都未接入。
    pub fn new() -> Self {
        Self {
            tools: BTreeMap::new(),
        }
    }

    /// 注册一个工具实现。
    pub fn register(
        mut self,
        name: impl Into<String>,
        f: impl Fn(&PlanStep, &BTreeMap<u32, String>) -> ToolFuture + Send + Sync + 'static,
    ) -> Self {
        self.tools.insert(name.into(), Box::new(f));
        self
    }

    /// 已接入的工具名，按字典序。
    pub fn available_tools(&self) -> Vec<&str> {
        self.tools.keys().map(|s| s.as_str()).collect()
    }

    /// 该工具是否已接入。
    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }
}

#[async_trait::async_trait]
impl StepRunner for RealRunner {
    async fn run(
        &self,
        step: &PlanStep,
        results: &BTreeMap<u32, String>,
    ) -> Result<String, String> {
        // 统一在此替换上游引用，而不是让每个工具各写一套。
        //
        // 为什么放在这里：上游引用（`{{step_1_top_files}}` 等）是**所有**
        // 工具的共同需求，不是某个工具的特例。放在入口处，任何新增工具
        // 都自动获得这个能力——若各工具自己实现，必然出现「这个工具支持、
        // 那个工具漏了」的分叉。
        //
        // 实测教训：最初只在 llm_generate 里替换，结果 read_file 拿到
        // 字面量 `{{step_1_top_files}}` 当路径，报「文件不存在」——
        // 整个 DAG 断在第二步，而第一步明明成功。
        let mut resolved = step.clone();
        for value in resolved.params.values_mut() {
            crate::tools::replace_upstream_in_value(value, results);
        }

        match self.tools.get(&resolved.tool) {
            Some(f) => f(&resolved, results).await,
            None => Err(format!(
                "能力未接入：{}（步骤 {}「{}」未执行——这不是失败，是尚未实现）",
                resolved.tool, resolved.step, resolved.description
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sky_exec::{execute_plan, ExecOptions};

    fn step(tool: &str) -> PlanStep {
        PlanStep {
            step: 1,
            description: format!("测试 {tool}"),
            tool: tool.into(),
            depends_on: vec![],
            params: BTreeMap::new(),
            expected_output: String::new(),
            fallback: None,
        }
    }

    fn plan_with(tool: &str) -> sky_core::TaskPlan {
        sky_core::TaskPlan {
            intent: "测试".into(),
            needs: vec![],
            steps: vec![step(tool)],
        }
    }

    /// 核心回归：未接入的工具必须报错，不能假装成功。
    ///
    /// 修复前 `EchoRunner` 对所有工具返回 `Ok("已执行 xxx")`，
    /// UI 显示「已执行 doc_convert」而实际什么都没做——系统在撒谎。
    #[tokio::test]
    async fn unimplemented_tool_returns_err_not_fake_success() {
        let r = RealRunner::new();
        let res = r.run(&step("doc_convert"), &BTreeMap::new()).await;
        match res {
            Err(e) => {
                assert!(e.contains("未接入"), "错误应说明未接入：{e}");
                assert!(e.contains("doc_convert"), "错误应点名工具：{e}");
            }
            Ok(v) => panic!("未接入工具绝不能返回 Ok，实际：{v}"),
        }
    }

    /// 未接入时步骤状态必须是 Failed，而非 Done。
    #[tokio::test]
    async fn unimplemented_tool_marks_step_failed() {
        let r = RealRunner::new();
        let out = execute_plan(
            &plan_with("doc_convert"),
            &r,
            &ExecOptions::default(),
            None,
        )
        .await
        .expect("执行不应整体失败");

        assert_eq!(out.outcomes.len(), 1);
        assert!(
            !out.outcomes[0].is_success(),
            "未接入工具的步骤不能被标为成功"
        );
        assert_eq!(
            out.outcomes[0].status,
            sky_exec::StepStatus::Failed,
            "应为 Failed"
        );
    }

    /// 已注册的工具走真实实现。
    #[tokio::test]
    async fn registered_tool_runs_real_impl() {
        let r = RealRunner::new().register("echo", |step, _| {
            let d = step.description.clone();
            Box::pin(async move { Ok(format!("真实实现：{d}")) })
        });
        let res = r.run(&step("echo"), &BTreeMap::new()).await;
        assert_eq!(res.unwrap(), "真实实现：测试 echo");
    }

    #[test]
    fn available_tools_lists_registrations() {
        let r = RealRunner::new().register("b_tool", |_, _| {
            Box::pin(async { Ok(String::new()) })
        });
        assert_eq!(r.available_tools(), vec!["b_tool"]);
        assert!(r.has_tool("b_tool"));
        assert!(!r.has_tool("doc_convert"));
    }

    /// 工具内部失败应透传，不被包装成成功。
    #[tokio::test]
    async fn tool_error_propagates() {
        let r = RealRunner::new().register("bad", |_, _| {
            Box::pin(async { Err("磁盘已满".to_string()) })
        });
        let res = r.run(&step("bad"), &BTreeMap::new()).await;
        assert_eq!(res.unwrap_err(), "磁盘已满");
    }
}
