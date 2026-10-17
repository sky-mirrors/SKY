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
use crate::window::WindowId;
use dioxus::prelude::*;

/// 路由决策展示项。对应现状 `RuntimePanel.vue`（500 行）展示的内容。
#[derive(Debug, Clone, PartialEq)]
pub struct RouteTrace {
    pub source: String,
    pub confidence: f32,
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

    let on_send = move |_| {
        let text = state.read().input.clone();
        if text.trim().is_empty() {
            return;
        }
        state.write().messages.push(("user".into(), text));
        state.write().input.clear();
        // 路由追踪占位——接入 sky-router 后填充真实决策
        state.write().route_trace.push(RouteTrace {
            source: "deterministic".into(),
            confidence: 0.9,
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
                        for (role, content) in state.read().messages.iter().cloned() {
                            div {
                                key: "{role}-{content}",
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
                            placeholder: "输入任务…",
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
                    if state.read().route_trace.is_empty() {
                        div {
                            style: "font-size: 12px; color: #999;",
                            "尚无决策记录"
                        }
                    }
                    for trace in state.read().route_trace.iter().cloned() {
                        div {
                            key: "{trace.source}",
                            style: "padding: 8px; margin-bottom: 8px; background: #f5f5f5; border-radius: 4px;",
                            div {
                                style: "font-size: 13px;",
                                "{trace.source}"
                            }
                            div {
                                style: "font-size: 11px; color: #666;",
                                "置信度 {trace.confidence:.2}"
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
