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
use crate::pipeline::Pipeline;
use crate::real_runner::RealRunner;
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

    // 发送逻辑。不接收事件参数，鼠标点击与回车键共用。
    // 用 use_callback 而非裸闭包——裸 FnMut 被两处 move 捕获会冲突，
    // 而复制两份逻辑正是上次「run 与 route_only 分叉」bug 的来源。
    let submit = use_callback(move |_: ()| {
        let text = state.read().input.clone();
        if text.trim().is_empty() {
            return;
        }
        // 处理中：防止重复提交，并让用户看到「确实在跑」。
        // 探索路径要调一次 LLM，实测约 7 秒；没有这个提示，
        // 用户会以为按钮没反应。
        if state.read().streaming {
            return;
        }
        state.write().messages.push(("user".into(), text.clone()));
        state.write().input.clear();
        state.write().streaming = true;
        // 留痕：从这里到「streaming=false」之间的墙钟时间，就是用户
        // 感知到的等待时长。与日志里的 route elapsed 对照，可区分
        // 「逻辑慢」与「事件/渲染慢」。
        eprintln!("[sky] send begin: text={:?}", text);

        let pipeline = pipeline.read().clone();
        spawn(async move {
            // 只调 run() 一次——它内部已经包含完整路由（含 LLM 规划）。
            // 曾经的实现先调 route_only() 再调 run()，导致探索路径
            // 触发两次 LLM 调用，实测耗时从 7 秒翻倍到 14 秒。
            let started = std::time::Instant::now();
            // 用 RealRunner 而非 EchoRunner：未接入的能力会明确报错，
            // 而不是假装成功。这样 UI 显示的状态与真实发生的事一致。
            let result = pipeline.run(&text, &RealRunner::new()).await;
            // 计时留痕：确定性路径设计上应是微秒级，若这里出现数秒，
            // 说明实际走的是 explore（调了 LLM）。用户报告「转 pdf 也要
            // 五六秒」时，端到端耗时与 route_source 一起看才有判断依据。
            eprintln!(
                "[sky] route_source={} elapsed={:?} planner_calls={} steps={}",
                result.route_source,
                started.elapsed(),
                pipeline.planner_call_count(),
                result.plan.steps.len()
            );

            let trace = RouteTrace {
                source: result.route_source.clone(),
                confidence: result.route_confidence,
                steps: result.plan.steps.iter().map(|s| s.tool.clone()).collect(),
            };

            let reply = if result.outcomes.is_empty() {
                format!(
                    "路由命中「{}」，置信度 {:.2}。该计划无执行步骤。",
                    trace.source, trace.confidence
                )
            } else {
                // 如实呈现每一行的真实状态。
                // 此前用 EchoRunner 对一切都返回 Ok("已执行 xxx")，
                // 于是「能力未接入」被显示成「已执行」——用户以为文件已转换，
                // 去目标目录却找不到。系统不能撒谎，所以这里按 status
                // 分别渲染：成功、失败（含未接入）必须一眼可辨。
                let lines: Vec<String> = result
                    .outcomes
                    .iter()
                    .map(|o| {
                        if let Some(err) = &o.error {
                            format!("✗ 步骤 {}：{}", o.step, err)
                        } else {
                            o.result
                                .clone()
                                .unwrap_or_else(|| format!("步骤 {} 无输出", o.step))
                        }
                    })
                    .collect();
                let failed = result.outcomes.iter().filter(|o| !o.is_success()).count();
                let header = if failed == 0 {
                    format!(
                        "路由命中「{}」，置信度 {:.2}。",
                        trace.source, trace.confidence
                    )
                } else {
                    format!(
                        "路由命中「{}」，置信度 {:.2}。\n\
                         ⚠ {} 个步骤未完成（{}/{} 成功）。",
                        trace.source,
                        trace.confidence,
                        failed,
                        result.outcomes.len() - failed,
                        result.outcomes.len()
                    )
                };
                format!("{header}\n执行情况：\n{}", lines.join("\n"))
            };

            state.write().route_trace.push(trace);
            state.write().messages.push(("assistant".into(), reply));
            state.write().streaming = false;
        });
    });

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
                        // 处理中提示。探索路径要调 LLM，实测约 7 秒——
                        // 没有这条，用户会以为发送没反应。
                        if state.read().streaming {
                            div {
                                style: "font-size: 13px; color: #888; font-style: italic;",
                                "处理中…（正在生成计划，约需数秒）"
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
                            onkeydown: move |e| {
                                // Enter 发送。但中文输入法选词时按 Enter 是确认候选词，
                                // 必须跳过——否则刚打完拼音就误发了半截内容。
                                if e.key() == Key::Enter && !e.is_composing() {
                                    submit.call(());
                                }
                            },
                        }
                        button {
                            style: "padding: 8px 20px; font-size: 14px; cursor: pointer;",
                            disabled: state.read().streaming,
                            onclick: move |_| submit.call(()),
                            if state.read().streaming { "处理中…" } else { "发送" }
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
