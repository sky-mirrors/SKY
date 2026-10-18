//! 逻辑接线层——把 8 个纯逻辑 crate 接进 UI。
//!
//! 这是 Wave 6a 骨架与 Wave 1–5 逻辑层之间的**唯一接缝**。
//! 设计目标：UI 层只调本模块，不直接依赖各 crate 的细节。
//!
//! 数据流（对应计划的核心数据流图）：
//! ```text
//! 用户输入
//!   → Router（四段：Cache → Deterministic → Retrieval → Explore）
//!   → TaskPlan
//!   → Executor（拓扑排序 + 逐步骤执行）
//!   → 结果 / 事件流
//! ```

use sky_core::{ChatMessage, RouteInput, TaskPlan};
use sky_exec::{execute_plan, ExecOptions, StepOutcome, StepRunner};
use sky_router::{default_router_with_cache, Outcome, RouteCache, Router};
use std::collections::BTreeMap;
use std::sync::Arc;

/// 一次请求的完整处理结果。
#[derive(Debug, Clone, PartialEq)]
pub struct PipelineResult {
    /// 命中的路由段名（`cache` / `manifest` / `deterministic` / `retrieval` / `explore`）。
    pub route_source: String,
    /// 路由置信度。
    pub route_confidence: f32,
    /// 路由产出的计划。
    pub plan: TaskPlan,
    /// 执行结果（若计划含步骤）。
    pub outcomes: Vec<StepOutcome>,
    /// 产出落盘的结果。
    ///
    /// 用户要的是「结果」——一份能打开的文件，不是控制台里的一行字。
    /// 落盘在管线末端统一完成，不必让 20 份任务书各加 write_file 步骤。
    pub artifact: crate::artifact::ArtifactOutcome,
}

/// 接线层。
///
/// 持有 Router 实例。`explore` 分支可选接 LLM 规划器——
/// 未注入时探索路径返回空计划（保持骨架行为）。
pub struct Pipeline {
    router: Router,
    planner: Option<crate::planner::LlmPlanner>,
    /// LLM 规划器被调用的次数。
    ///
    /// 存在的理由：一次用户发送必须只触发一次 LLM 调用（每次约 7 秒、
    /// 消耗 token）。曾经 UI 先调 `route_only` 再调 `run`，而 `run` 内部
    /// 又调一次 `route_only`，导致同一次发送调用两次 LLM。这个计数器让
    /// 该回归可被测试锁住，而不是靠读代码发现。
    planner_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// 已接入的工具名。传给 LLM 规划器，避免它发明不存在的工具。
    available_tools: Vec<String>,
    /// 产出落盘配置。
    artifact_config: crate::artifact::ArtifactConfig,
    /// 路由级计划缓存（共享给 router 的 cache 段）。
    ///
    /// **为什么在 Pipeline 层回填**：缓存键要的是「最终胜出的计划」，
    /// 只有 `route_only` 知道谁胜出（manifest / deterministic / explore+llm）；
    /// CacheStage 自己不知道下游结果。
    plan_cache: Arc<RouteCache>,
    /// 缓存命中次数。供测试断言「第二次相同输入走缓存」。
    plan_cache_hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl Pipeline {
    pub fn new() -> Self {
        let (router, plan_cache) = default_router_with_cache(Arc::new(RouteCache::default()));
        Self {
            router,
            planner: None,
            planner_calls: Default::default(),
            available_tools: Vec::new(),
            artifact_config: crate::artifact::ArtifactConfig::default(),
            plan_cache_hits: Default::default(),
            plan_cache,
        }
    }

    /// 接入 LLM 规划器——探索路径将由 LLM 生成计划。
    pub fn with_planner(planner: crate::planner::LlmPlanner) -> Self {
        let (router, plan_cache) = default_router_with_cache(Arc::new(RouteCache::default()));
        Self {
            router,
            planner: Some(planner),
            planner_calls: Default::default(),
            available_tools: Vec::new(),
            artifact_config: crate::artifact::ArtifactConfig::default(),
            plan_cache_hits: Default::default(),
            plan_cache,
        }
    }

    /// 声明已接入的工具名，供 LLM 规划器参考。
    ///
    /// 不声明时 LLM 只能靠猜，实测会产出「终端」「ls」等
    /// 不存在的工具名，导致全部步骤执行失败。
    pub fn with_tools(mut self, tools: Vec<String>) -> Self {
        self.available_tools = tools;
        self
    }

    /// 配置产出落盘。
    ///
    /// 测试里通常传 `ArtifactConfig::disabled()`——单元测试不该往磁盘写文件。
    pub fn with_artifact_config(mut self, cfg: crate::artifact::ArtifactConfig) -> Self {
        self.artifact_config = cfg;
        self
    }

    /// LLM 规划器累计被调用次数。供测试断言「一次发送一次调用」。
    pub fn planner_call_count(&self) -> usize {
        self.planner_calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 是否已接入 LLM 规划器。
    pub fn has_planner(&self) -> bool {
        self.planner.is_some()
    }

    /// 路由缓存累计命中次数（cache 段直接回放的请求数）。
    pub fn plan_cache_hits(&self) -> usize {
        self.plan_cache_hits
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 路由缓存当前条目数。
    pub fn plan_cache_entries(&self) -> usize {
        self.plan_cache.len()
    }

    /// 仅路由——不执行。用于只想知道决策链的场景（如路由面板）。
    pub async fn route_only(&self, text: &str) -> RouteOutcome {
        let input = RouteInput {
            text: text.to_string(),
            ..Default::default()
        };

        match self.router.route(&input).await {
            Outcome::Resolved {
                plan,
                confidence,
                source,
            } => {
                // 缓存段命中即回放：直接计一次命中，不回填。
                if source == "cache" {
                    self.plan_cache_hits
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    return RouteOutcome::Resolved {
                        source: source.to_string(),
                        confidence,
                        plan,
                    };
                }
                // 命中且计划可执行 → 回填缓存，让重复输入下次直达 cache 段。
                // explore+llm 的规划结果同样回填——重复探索请求省一次 7 秒 LLM 规划。
                // explore 空计划（无 planner）不缓存，保持骨架行为。
                if !plan.steps.is_empty() {
                    self.plan_cache.store(text, &plan);
                }
                // 探索段命中且接了规划器 → 由 LLM 生成真实计划
                if source == "explore" && plan.steps.is_empty() {
                    if let Some(planner) = &self.planner {
                        self.planner_calls
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        // 把已接入的工具清单交给规划器——不给清单时
                        // LLM 会发明「终端」「ls」这类不存在的工具名，
                        // 导致每一步都执行失败（实测确认）。
                        let tool_names: Vec<&str> = self
                            .available_tools
                            .iter()
                            .map(|s| s.as_str())
                            .collect();
                        return match planner.plan_with_tools(text, &tool_names).await {
                            crate::planner::PlanOutcome::Planned(p) => RouteOutcome::Resolved {
                                source: "explore+llm".to_string(),
                                confidence: 0.5,
                                plan: p,
                            },
                            crate::planner::PlanOutcome::Unparsable { reason, .. } => {
                                RouteOutcome::Resolved {
                                    source: "explore+llm(解析失败)".to_string(),
                                    confidence: 0.0,
                                    plan: TaskPlan {
                                        intent: text.to_string(),
                                        needs: vec![reason],
                                        steps: vec![],
                                    },
                                }
                            }
                            crate::planner::PlanOutcome::Failed(e) => RouteOutcome::Resolved {
                                source: "explore+llm(调用失败)".to_string(),
                                confidence: 0.0,
                                plan: TaskPlan {
                                    intent: text.to_string(),
                                    needs: vec![e],
                                    steps: vec![],
                                },
                            },
                        };
                    }
                }
                RouteOutcome::Resolved {
                    source: source.to_string(),
                    confidence,
                    plan,
                }
            }
            Outcome::NeedsArbitration(candidates) => RouteOutcome::NeedsArbitration {
                candidates: candidates.into_iter().map(|c| c.name).collect(),
            },
            Outcome::Unresolved => RouteOutcome::Unresolved,
        }
    }

    /// 完整链路：路由 → 执行。
    ///
    /// **复用 `route_only`**——避免路由逻辑在两处分叉。
    /// 曾经的实现各自复制了一份 router 调用，导致 planner 只接在
    /// `route_only` 而未接在 `run`，探索路径在完整链路里拿不到 LLM 计划。
    pub async fn run(&self, text: &str, runner: &dyn StepRunner) -> PipelineResult {
        let (route_source, route_confidence, plan) = match self.route_only(text).await {
            RouteOutcome::Resolved {
                source,
                confidence,
                plan,
            } => (source, confidence, plan),
            RouteOutcome::NeedsArbitration { candidates } => {
                let plan = TaskPlan {
                    intent: text.to_string(),
                    needs: candidates.clone(),
                    steps: vec![],
                };
                (format!("arbitration({})", candidates.join(",")), 0.5, plan)
            }
            RouteOutcome::Unresolved => (
                "unresolved".to_string(),
                0.0,
                TaskPlan {
                    intent: text.to_string(),
                    needs: vec![],
                    steps: vec![],
                },
            ),
        };

        // 执行前注入宿主槽位（不改变返回给调用方的 plan——
        // 调用方看到的是路由产出的原始计划，注入只发生在执行副本上）。
        //
        // `{{workspace_dir}}` 这类槽位的 `source = "context"`，由宿主在
        // 执行期提供——不是用户输入，也不是上游结果。路由期把它们原样
        // 保留下来（否则任务书会永远卡在「缺槽位」），到这里才替换成真实值。
        //
        // 实测教训：少了这一步，字面量 `{{workspace_dir}}` 会被当成路径
        // 传给 directory_tree，报「目录不存在：{{workspace_dir}}」。
        let exec_plan = inject_host_slots(plan.clone());

        let outcomes = if exec_plan.steps.is_empty() {
            vec![]
        } else {
            match execute_plan(&exec_plan, runner, &ExecOptions::default(), None).await {
                Ok(r) => r.outcomes,
                Err(_) => vec![],
            }
        };

        // 产出落盘：把最后一个成功步骤的结果写成文件。
        //
        // 用户要的结果是「能打开的文件」，不是控制台一行字。
        // 落盘放在管线末端而非任务书里，是为了一次覆盖全部 20 份任务书——
        // 任务书管「怎么做」，落盘是运行环境的关切。
        let artifact = match crate::artifact::pick_final_output(&outcomes) {
            Some(final_text) => {
                let doc = crate::artifact::compose_document(
                    &plan.intent,
                    &route_source,
                    &outcomes,
                    &final_text,
                );
                crate::artifact::write_artifact(&self.artifact_config, &plan.intent, &doc)
            }
            None => crate::artifact::ArtifactOutcome::Skipped {
                reason: "本次执行没有可落盘的产出".to_string(),
            },
        };

        PipelineResult {
            route_source,
            route_confidence,
            plan,
            outcomes,
            artifact,
        }
    }
}

/// 仅路由的结果。
#[derive(Debug, Clone, PartialEq)]
pub enum RouteOutcome {
    Resolved {
        source: String,
        confidence: f32,
        plan: TaskPlan,
    },
    NeedsArbitration {
        candidates: Vec<String>,
    },
    Unresolved,
}

/// 一个不做实际工作的 runner——用于验证链路连通性。
///
/// 它把每个步骤「执行」为一行说明文本，使 UI 能显示执行轨迹。
pub struct EchoRunner;

#[async_trait::async_trait]
impl StepRunner for EchoRunner {
    async fn run(
        &self,
        step: &sky_core::PlanStep,
        _results: &BTreeMap<u32, String>,
    ) -> Result<String, String> {
        Ok(format!("已执行 {}：{}", step.tool, step.description))
    }
}

/// 构造一条助手消息。
pub fn assistant_message(content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        role: "assistant".into(),
        content: content.into(),
        timestamp: None,
    }
}

/// 执行前把宿主槽位替换成真实值。
///
/// 处理 `source = "context"` 的槽位（如 `{{workspace_dir}}`）：
/// 它们既不是用户输入、也不是上游结果，而是运行环境提供的信息。
///
/// **当前注入的宿主槽位**：
/// - `{{workspace_dir}}` → 进程当前工作目录
///
/// 未知的宿主槽位（如 `{{user_file}}` 若被误标为 context）**不注入**——
/// 保留原样让下游工具报「路径不存在」，比静默替换成空串安全：
/// 空串会让工具把当前目录当成目标，做错事还报成功。
fn inject_host_slots(plan: TaskPlan) -> TaskPlan {
    let workspace = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut plan = plan;
    for step in &mut plan.steps {
        for value in step.params.values_mut() {
            replace_in_value(value, "{{workspace_dir}}", &workspace);
        }
    }
    plan
}

/// 递归替换 JSON 值里的占位符（只处理字符串）。
fn replace_in_value(v: &mut serde_json::Value, placeholder: &str, replacement: &str) {
    match v {
        serde_json::Value::String(s) => {
            if s.contains(placeholder) {
                *s = s.replace(placeholder, replacement);
            }
        }
        serde_json::Value::Array(a) => {
            for item in a {
                replace_in_value(item, placeholder, replacement);
            }
        }
        serde_json::Value::Object(o) => {
            for item in o.values_mut() {
                replace_in_value(item, placeholder, replacement);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn route_only_hits_deterministic_for_known_pattern() {
        let p = Pipeline::new();
        match p.route_only("把文档转 pdf").await {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "deterministic"),
            other => panic!("期望 deterministic，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn route_only_falls_back_to_explore() {
        let p = Pipeline::new();
        match p.route_only("完全无关的输入 xyz").await {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "explore"),
            other => panic!("期望 explore，得到 {other:?}"),
        }
    }

    /// 关键：路由命中的计划必须携带可执行步骤，否则链路是断的。
    #[tokio::test]
    async fn deterministic_route_produces_executable_steps() {
        let p = Pipeline::new();
        let r = p.route_only("把文档转 pdf").await;
        match r {
            RouteOutcome::Resolved { plan, .. } => {
                assert!(!plan.steps.is_empty(), "确定性路由必须产出步骤");
                assert_eq!(plan.steps[0].tool, "doc_convert");
            }
            other => panic!("得到 {other:?}"),
        }
    }

    /// 缓存回填与二次命中：第一次走下游段并回填，第二次相同输入直接命中 cache 段。
    /// 归一化变体（全角/大小写）必须共享同一条目。
    #[tokio::test]
    async fn repeated_input_hits_cache_with_normalized_variant() {
        let p = Pipeline::new();

        // 第一次：走 deterministic（缓存为空）
        let first = p.route_only("把文档转 pdf").await;
        match &first {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "deterministic"),
            other => panic!("第一次应 deterministic，得到 {other:?}"),
        }
        assert_eq!(p.plan_cache_entries(), 1, "命中计划应回填缓存");
        assert_eq!(p.plan_cache_hits(), 0);

        // 第二次：完全相同输入 → cache 段直达
        let second = p.route_only("把文档转 pdf").await;
        match &second {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "cache"),
            other => panic!("第二次应命中 cache，得到 {other:?}"),
        }
        assert_eq!(p.plan_cache_hits(), 1);

        // 第三次：全角+大写变体 → 同一条目，仍命中 cache
        let third = p.route_only("把文档转　ＰＤＦ").await;
        match &third {
            RouteOutcome::Resolved { source, plan, .. } => {
                assert_eq!(source, "cache");
                assert_eq!(plan.steps[0].tool, "doc_convert", "回放计划必须与原计划等价");
            }
            other => panic!("变体应命中 cache，得到 {other:?}"),
        }
        assert_eq!(p.plan_cache_hits(), 2);
        assert_eq!(p.plan_cache_entries(), 1, "变体不得新增条目");
    }

    /// 缓存命中不得劫持探索路径——不同输入互不污染。
    #[tokio::test]
    async fn cache_does_not_cross_contaminate_inputs() {
        let p = Pipeline::new();
        let _ = p.route_only("把文档转 pdf").await;
        let other = p.route_only("完全无关的输入 xyz").await;
        match &other {
            RouteOutcome::Resolved { source, .. } => assert_eq!(source, "explore"),
            other => panic!("不同输入不得命中缓存，得到 {other:?}"),
        }
        assert_eq!(p.plan_cache_hits(), 0);
    }

    /// 全链路：路由 → 执行，步骤应被 EchoRunner 执行。
    #[tokio::test]
    async fn full_pipeline_executes_plan_steps() {
        let p = Pipeline::new();
        let r = p.run("把文档转 pdf", &EchoRunner).await;
        assert_eq!(r.route_source, "deterministic");        assert_eq!(r.outcomes.len(), 1, "应有一步被执行");
        assert!(r.outcomes[0].is_success());
        assert!(r.outcomes[0].result.as_ref().unwrap().contains("doc_convert"));
    }

    /// 探索路径无步骤 → 不应调用执行器。
    #[tokio::test]
    async fn explore_path_has_no_steps() {
        let p = Pipeline::new();
        let r = p.run("完全无关 xyz", &EchoRunner).await;
        assert_eq!(r.route_source, "explore");
        assert!(r.outcomes.is_empty(), "探索计划无步骤，不应有执行结果");
    }

    #[tokio::test]
    async fn route_confidence_is_reported() {
        let p = Pipeline::new();
        let r = p.route_only("把文档转 pdf").await;
        match r {
            RouteOutcome::Resolved { confidence, .. } => {
                assert!(confidence > 0.0, "确定性命中应有置信度")
            }
            other => panic!("得到 {other:?}"),
        }
    }

    #[test]
    fn assistant_message_sets_role() {
        let m = assistant_message("hi");
        assert_eq!(m.role, "assistant");
        assert_eq!(m.content, "hi");
    }

    /// 回归：一次 `run()` 必须只调用一次 LLM 规划器。
    ///
    /// 曾经的 UI 实现先调 `route_only()` 再调 `run()`，而 `run()` 内部
    /// 又调一次 `route_only()`——同一次发送触发两次 LLM 调用，
    /// 实测耗时从 7 秒翻到 14 秒，用户看到的就是「没反应」。
    ///
    /// 这里用无密钥的 planner：调用会走 `Failed` 分支，但计数器照增，
    /// 因此能在不发真实网络请求的前提下断言调用次数。
    #[tokio::test]
    async fn run_calls_planner_exactly_once() {
        let p = Pipeline::with_planner(crate::planner::LlmPlanner::with_key(""));
        let _ = p.run("完全无关的输入 xyz", &EchoRunner).await;
        assert_eq!(
            p.planner_call_count(),
            1,
            "一次 run 只能触发一次 LLM 调用；多于 1 说明路由逻辑分叉了"
        );
    }

    /// 确定性路径不得触碰 LLM——既省 token 也省 7 秒等待。
    #[tokio::test]
    async fn deterministic_path_never_calls_planner() {
        let p = Pipeline::with_planner(crate::planner::LlmPlanner::with_key(""));
        let r = p.run("把文档转 pdf", &EchoRunner).await;
        assert_eq!(r.route_source, "deterministic");
        assert_eq!(
            p.planner_call_count(),
            0,
            "确定性命中不该调用 LLM"
        );
    }
}
