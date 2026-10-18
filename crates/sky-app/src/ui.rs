//! Dioxus UI 骨架。
//!
//! 当前实现的是**最小可运行外壳**：主窗口 + 路由面板 + 输入框。
//! 现状 33 个 Vue 组件（13,128 行）的完整迁移是后续工作——
//! 本文件确立组件组织方式与状态流向，供后续按同一模式扩展。
//!
//! 状态流（对应「单一真相源」设计）：
//! ```text
//! AppState (Signal) ──┬──> MainView      主对话
//!                     ├──> PipelineView  流水线工作台
//!                     └──> DebugView     调试监视器
//! ```
//! 各视图订阅同一 Signal，不再需要现状的 `storeSync*` 四组同步通道。

use crate::bridge::ProgressEvent;
use crate::pipeline::{EchoRunner, Pipeline, RouteOutcome};
use crate::window::WindowId;
use dioxus::prelude::*;
use std::sync::Arc;

/// 路由决策展示项。对应现状 `RuntimePanel.vue`（500 行）展示的内容。
#[derive(Debug, Clone, PartialEq)]
pub struct RouteTrace {
    pub source: String,
    pub confidence: f32,
    /// 计划中的步骤摘要（工具名），供面板展示决策的实际产出。
    pub steps: Vec<String>,
}

/// 应用全局状态——单一真相源。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppState {
    pub input: String,
    pub messages: Vec<(String, String)>,
    pub route_trace: Vec<RouteTrace>,
    pub streaming: bool,
}

/// 主视图。
#[component]
pub fn MainView() -> Element {
    let mut state = use_signal(AppState::default);
    // 配置文件的解析警告——必须在界面上可见。
    // 用户改了配置文件却没生效时，静默用默认值会让人排查很久。
    let config_warning = use_signal(|| sky_llm::resolve_config().warning);
    // Pipeline 只构造一次，跨事件复用
    let pipeline = use_signal(|| {
        // 有 GLM 密钥则接入 LLM 规划器，探索路径由 LLM 生成计划；
        // 无密钥则保持骨架行为（探索返回空计划）。
        // 密钥来源：环境变量 SKY_GLM_API_KEY > 用户目录配置文件。
        let planner = crate::planner::LlmPlanner::from_env();
        if planner.has_key() {
            Arc::new(Pipeline::with_planner(planner))
        } else {
            Arc::new(Pipeline::new())
        }
    });

    let on_send = move |_| {
        let text = state.read().input.clone();
        if text.trim().is_empty() {
            return;
        }
        state.write().messages.push(("user".into(), text.clone()));
        state.write().input.clear();

        let pipeline = pipeline.read().clone();
        spawn(async move {
            // 真实路由调用——不再是占位
            let outcome = pipeline.route_only(&text).await;

            let trace = match outcome {
                RouteOutcome::Resolved {
                    source,
                    confidence,
                    plan,
                } => RouteTrace {
                    source,
                    confidence,
                    steps: plan.steps.iter().map(|s| s.tool.clone()).collect(),
                },
                RouteOutcome::NeedsArbitration { candidates } => RouteTrace {
                    source: format!("仲裁（{} 个候选）", candidates.len()),
                    confidence: 0.5,
                    steps: candidates,
                },
                RouteOutcome::Unresolved => RouteTrace {
                    source: "unresolved".into(),
                    confidence: 0.0,
                    steps: vec![],
                },
            };

            // 执行链路
            let result = pipeline.run(&text, &EchoRunner).await;

            let reply = if result.outcomes.is_empty() {
                format!(
                    "路由命中「{}」，置信度 {:.2}。该计划无执行步骤。",
                    trace.source, trace.confidence
                )
            } else {
                let lines: Vec<String> = result
                    .outcomes
                    .iter()
                    .map(|o| {
                        o.result
                            .clone()
                            .unwrap_or_else(|| format!("步骤 {} 失败", o.step))
                    })
                    .collect();
                format!(
                    "路由命中「{}」，置信度 {:.2}。\n执行结果：\n{}",
                    trace.source,
                    trace.confidence,
                    lines.join("\n")
                )
            };

            state.write().route_trace.push(trace);
            state.write().messages.push(("assistant".into(), reply));
        });
    };

    rsx! {
        div {
            style: "display: flex; flex-direction: column; height: 100vh; font-family: 'Microsoft YaHei', sans-serif;",

            // 顶部标题
            div {
                style: "padding: 12px 16px; border-bottom: 1px solid #e0e0e0; font-size: 15px; font-weight: 600;",
                "SKY"
                span {
                    style: "margin-left: 8px; font-size: 12px; font-weight: 400; color: #888;",
                    "本地优先的 AI 工具控制台"
                }
            }

            // 主体：对话区 + 路由面板
            div {
                style: "display: flex; flex: 1; min-height: 0;",

                // 对话区
                div {
                    style: "flex: 1; display: flex; flex-direction: column; min-width: 0;",
                    div {
                        style: "flex: 1; overflow-y: auto; padding: 16px;",
                        for (i, (role, content)) in state.read().messages.iter().cloned().enumerate() {
                            div {
                                key: "{i}",
                                style: "margin-bottom: 12px;",
                                div {
                                    style: "font-size: 12px; color: #888; margin-bottom: 4px;",
                                    "{role}"
                                }
                                div {
                                    style: "font-size: 14px; white-space: pre-wrap;",
                                    "{content}"
                                }
                            }
                        }
                    }
                    // 输入区
                    div {
                        style: "display: flex; padding: 12px; border-top: 1px solid #e0e0e0; gap: 8px;",
                        input {
                            style: "flex: 1; padding: 8px 12px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px;",
                            placeholder: "输入任务…（试试「把文档转 pdf」）",
                            value: "{state.read().input}",
                            oninput: move |e| state.write().input = e.value(),
                        }
                        button {
                            style: "padding: 8px 20px; font-size: 14px; cursor: pointer;",
                            onclick: on_send,
                            "发送"
                        }
                    }
                }

                // 路由决策面板——这是项目论点本身：把决策摊开给人看
                div {
                    style: "width: 280px; border-left: 1px solid #e0e0e0; padding: 16px; overflow-y: auto;",
                    div {
                        style: "font-size: 13px; font-weight: 600; margin-bottom: 12px;",
                        "路由决策"
                    }
                    if let Some(w) = config_warning.read().as_ref() {
                        div {
                            style: "font-size: 11px; color: #b45309; background: #fef3c7; padding: 8px; border-radius: 4px; margin-bottom: 12px; line-height: 1.5;",
                            "{w}"
                        }
                    }
                    if state.read().route_trace.is_empty() {
                        div {
                            style: "font-size: 12px; color: #999;",
                            "尚无决策记录"
                        }
                    }
                    for (i, trace) in state.read().route_trace.iter().cloned().enumerate() {
                        div {
                            key: "{i}",
                            style: "padding: 8px; margin-bottom: 8px; background: #f5f5f5; border-radius: 4px;",
                            div {
                                style: "font-size: 13px; font-weight: 600;",
                                "{trace.source}"
                            }
                            div {
                                style: "font-size: 11px; color: #666;",
                                "置信度 {trace.confidence:.2}"
                            }
                            if !trace.steps.is_empty() {
                                div {
                                    style: "font-size: 11px; color: #444; margin-top: 4px;",
                                    "步骤：{trace.steps.join(\" → \")}"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 把进度事件应用到状态。
pub fn apply_progress(state: &mut AppState, ev: &ProgressEvent) {
    match ev {
        ProgressEvent::RouteDecision { source, confidence } => {
            state.route_trace.push(RouteTrace {
                source: source.clone(),
                confidence: *confidence,
                steps: Vec::new(),
            });
        }
        ProgressEvent::TokenDelta(t) => {
            if let Some(last) = state.messages.last_mut() {
                if last.0 == "assistant" {
                    last.1.push_str(t);
                    return;
                }
            }
            state.messages.push(("assistant".into(), t.clone()));
        }
        ProgressEvent::StepStatus { .. } | ProgressEvent::Notice { .. } => {
            // 归后续视图处理
        }
    }
}

/// 窗口标题（供外壳使用）。
pub fn window_title(id: WindowId) -> &'static str {
    id.title()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_route_decision_appends_trace() {
        let mut s = AppState::default();
        apply_progress(
            &mut s,
            &ProgressEvent::RouteDecision {
                source: "cache".into(),
                confidence: 0.95,
            },
        );
        assert_eq!(s.route_trace.len(), 1);
        assert_eq!(s.route_trace[0].source, "cache");
    }

    #[test]
    fn apply_token_delta_appends_to_assistant_message() {
        let mut s = AppState::default();
        apply_progress(&mut s, &ProgressEvent::TokenDelta("你".into()));
        apply_progress(&mut s, &ProgressEvent::TokenDelta("好".into()));
        assert_eq!(s.messages.len(), 1, "连续 token 应合并到同一条消息");
        assert_eq!(s.messages[0].1, "你好");
    }

    #[test]
    fn token_delta_after_user_message_starts_new_assistant() {
        let mut s = AppState::default();
        s.messages.push(("user".into(), "问题".into()));
        apply_progress(&mut s, &ProgressEvent::TokenDelta("答".into()));
        assert_eq!(s.messages.len(), 2);
        assert_eq!(s.messages[1].0, "assistant");
    }

    #[test]
    fn window_title_delegates_to_id() {
        assert_eq!(window_title(WindowId::Pipeline), "SKY - 流水线工作台");
    }
}
