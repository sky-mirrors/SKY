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
use crate::pipeline::{plan_write_targets, PreparedRequest, Pipeline};

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

/// 待审批的写门请求——审批卡数据源（fail-closed：出现即等用户裁决）。
#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub tool_name: String,
    pub operation: String,
    pub target: String,
    /// 审批期间的已路由请求，裁决后原样执行（不重跑路由）。
    pub prepared: PreparedRequest,
}

/// 应用全局状态——单一真相源。
#[derive(Debug, Clone, PartialEq)]
pub struct AppState {
    pub input: String,
    pub messages: Vec<(String, String)>,
    pub route_trace: Vec<RouteTrace>,
    pub streaming: bool,
    /// 当前视图：core（对话主控）/ chem（化学工作台）/ paper（论文精读）。
    /// 领域工作台是对话主控的**子视图**——从包栏/功能卡进入，返回键回 core。
    pub active_view: &'static str,
    /// 写门待审批请求。非空时对话输入禁用，直到用户三态裁决。
    pub pending_approval: Option<PendingApproval>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            input: String::new(),
            messages: Vec::new(),
            route_trace: Vec::new(),
            streaming: false,
            active_view: "core",
            pending_approval: None,
        }
    }
}

/// 把执行结果拼成回复文本——如实呈现每一步状态（成功/失败/未接入可辨）。
///
/// 此前 EchoRunner 对一切都返回 Ok，于是「能力未接入」被显示成
/// 「已执行」——用户以为文件已转换，去目标目录却找不到。
/// 系统不能撒谎，按 status 分别渲染。
fn format_reply(result: &crate::pipeline::PipelineResult) -> String {
    if result.outcomes.is_empty() {
        return format!(
            "路由命中「{}」，置信度 {:.2}。该计划无执行步骤。",
            result.route_source, result.route_confidence
        );
    }
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
            result.route_source, result.route_confidence
        )
    } else {
        format!(
            "路由命中「{}」，置信度 {:.2}。\n⚠ {} 个步骤未完成（{}/{} 成功）。",
            result.route_source,
            result.route_confidence,
            failed,
            result.outcomes.len() - failed,
            result.outcomes.len()
        )
    };
    format!("{header}\n执行情况：\n{}", lines.join("\n"))
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
            // 把已接入的工具清单交给 pipeline → 再交给 LLM 规划器。
            // 不给清单时实测 LLM 会发明「终端」「ls」等不存在的工具名，
            // 导致每一步都执行失败。
            let tools: Vec<String> = crate::tools::register_all()
                .available_tools()
                .iter()
                .map(|s| s.to_string())
                .collect();
            Arc::new(Pipeline::with_planner(planner).with_tools(tools))
        } else {
            Arc::new(Pipeline::new())
        }
    });

    // 论文阅读台样板（95 册 §9.7）：动作按钮走 dispatch_work_action
    // （规范化键缓存），minimap 段落条提供动作槽位。
    let reader = use_signal(crate::paper_reader::ReaderState::default);
    let mut reader_current = use_signal(|| 1u32);

    // 化学工作台（§9.7 化学与化工）：SMILES 机器验证。
    let mut chem = use_signal(crate::smiles::ChemLabState::default);

    let work_trigger = use_callback(move |(name, no): (&'static str, u32)| {
        let mut reader = reader;
        let pipeline = pipeline.read().clone();
        spawn(async move {
            let section = crate::paper_reader::default_sections()
                .into_iter()
                .find(|s| s.no == no)
                .expect("段落号来自 minimap，必存在");
            reader.write().trigger(&pipeline, name, &section).await;
        });
    });

    // 审批卡三态裁决（写门 fail-closed：拒绝=整请求不执行）。
    // 裁决复用挂起的 prepared——路由（含 LLM 规划）不重跑。
    let resolve_approval = use_callback(move |decision: bool| {
        let mut state = state;
        let Some(pending) = state.write().pending_approval.take() else {
            return;
        };
        let decision_enum = if decision {
            sky_core::WriteDecision::Once
        } else {
            sky_core::WriteDecision::Deny
        };
        let pipeline = pipeline.read().clone();
        state.write().streaming = true;
        spawn(async move {
            let result = pipeline
                .run_prepared(&pending.prepared, &crate::tools::register_all(), Some(decision_enum))
                .await;
            let reply = if !decision {
                format!(
                    "已拒绝——{} → {} 未执行。fail-closed：没有授权就没有动作。",
                    pending.tool_name, pending.target
                )
            } else {
                format_reply(&result)
            };
            let trace = RouteTrace {
                source: result.route_source.clone(),
                confidence: result.route_confidence,
                steps: result.plan.steps.iter().map(|s| s.tool.clone()).collect(),
            };
            state.write().route_trace.push(trace);
            state.write().messages.push(("assistant".into(), reply));
            state.write().streaming = false;
        });
    });

    // 发送逻辑。不接收事件参数，鼠标点击与回车键共用。
    // 用 use_callback 而非裸闭包——裸 FnMut 被两处 move 捕获会冲突，
    // 而复制两份逻辑正是上次「run 与 route_only 分叉」bug 的来源。
    let submit = use_callback(move |_: ()| {        let text = state.read().input.clone();
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
            // prepare → 写门检查 → run_prepared：
            // 路由（含可能的 LLM 规划）只跑一次；计划含写类步骤时
            // 不执行，挂起等用户审批卡裁决（fail-closed）。
            let prepared = pipeline.prepare(&text).await;
            let write_reqs = plan_write_targets(&prepared.plan);
            let decision = if write_reqs.is_empty() {
                None
            } else {
                // 挂起审批：route_trace 也要记录（用户能看到路由已发生）
                let trace = RouteTrace {
                    source: prepared.route_source.clone(),
                    confidence: prepared.route_confidence,
                    steps: prepared.plan.steps.iter().map(|s| s.tool.clone()).collect(),
                };
                state.write().route_trace.push(trace);
                state.write().pending_approval = Some(PendingApproval {
                    tool_name: write_reqs[0].tool_name.clone(),
                    operation: write_reqs[0].operation.clone(),
                    target: write_reqs[0].target.clone(),
                    prepared,
                });
                state.write().streaming = false;
                eprintln!(
                    "[sky] write-gate pending: {} → {} (elapsed={:?})",
                    write_reqs[0].tool_name,
                    write_reqs[0].target,
                    started.elapsed()
                );
                return; // 审批卡回调里继续
            };
            let result = pipeline
                .run_prepared(&prepared, &crate::tools::register_all(), decision)
                .await;
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

            let reply = format_reply(&result);

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

            // 主体：领域包侧栏 + 主区（对话/工作台）+ 路由面板
            div {
                style: "display: flex; flex: 1; min-height: 0;",

                // 领域包侧栏——热插拔的可见表达（§9.7：换域即换工作台）
                div {
                    style: "width: 200px; border-right: 1px solid #e0e0e0; background: #fafafa; padding: 10px 8px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;",
                    div {
                        style: "font-size: 11px; color: #888; padding: 0 6px 6px; font-weight: 600;",
                        "领域包"
                    }
                    div {
                        style: if state.read().active_view == "core" {
                            "border: 1px solid #2563eb; background: #eff6ff; border-radius: 4px; padding: 8px 10px; cursor: pointer;"
                        } else {
                            "border: 1px dashed #e0e0e0; border-radius: 4px; padding: 8px 10px; cursor: pointer;"
                        },
                        onclick: move |_| state.write().active_view = "core",
                        div { style: "font-size: 12.5px; font-weight: 600;", "SKY 核心" }
                        div { style: "font-size: 10px; color: #888; margin-top: 2px;", "对话 · 规则路由 · 任务书引擎" }
                    }
                    div {
                        style: if state.read().active_view == "chem" {
                            "border: 1px solid #2563eb; background: #eff6ff; border-radius: 4px; padding: 8px 10px; cursor: pointer;"
                        } else {
                            "border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px 10px; cursor: pointer; background: white;"
                        },
                        onclick: move |_| state.write().active_view = "chem",
                        div {
                            style: "font-size: 12.5px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;",
                            "化学与化工"
                            span {
                                style: "font-size: 9px; padding: 1px 6px; border-radius: 8px; background: #f0fdf4; color: #16a34a; font-weight: 400;",
                                "已挂载"
                            }
                        }
                        div { style: "font-size: 10px; color: #888; margin-top: 2px;", "SMILES 解析 · Origin/ChemDraw 桥" }
                    }
                    div {
                        style: if state.read().active_view == "paper" {
                            "border: 1px solid #2563eb; background: #eff6ff; border-radius: 4px; padding: 8px 10px; cursor: pointer;"
                        } else {
                            "border: 1px solid #e0e0e0; border-radius: 4px; padding: 8px 10px; cursor: pointer; background: white;"
                        },
                        onclick: move |_| state.write().active_view = "paper",
                        div {
                            style: "font-size: 12.5px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;",
                            "科学研究"
                            span {
                                style: "font-size: 9px; padding: 1px 6px; border-radius: 8px; background: #f0fdf4; color: #16a34a; font-weight: 400;",
                                "已挂载"
                            }
                        }
                        div { style: "font-size: 10px; color: #888; margin-top: 2px;", "双语精读 · 标注 · 知识检索" }
                    }
                    div {
                        style: "margin-top: auto; padding: 8px 6px 0; font-size: 9.5px; color: #888; border-top: 1px dashed #e0e0e0; line-height: 1.5;",
                        "加领域 = 加 JSON："
                        div { style: "font-family: Consolas, monospace; font-size: 9px; color: #2563eb;", "config/l2_manifests/" }
                    }
                }

                // 对话区
                div {
                    style: "flex: 1; display: flex; flex-direction: column; min-width: 0;",

                    // 面包屑：进入领域工作台后显示，返回键回对话主控
                    if state.read().active_view != "core" {
                        div {
                            style: "display: flex; align-items: center; gap: 8px; padding: 8px 20px; border-bottom: 1px solid #e0e0e0; font-size: 12px; background: #fafafa;",
                            a {
                                style: "color: #2563eb; cursor: pointer;",
                                onclick: move |_| state.write().active_view = "core",
                                "← 对话主控"
                            }
                            span { style: "color: #888;", "/" }
                            span { style: "font-weight: 600;",
                                if state.read().active_view == "chem" { "化学与化工工作台" } else { "科学研究工作台" }
                            }
                        }
                    }

                    // ===== 对话主控视图（core）=====
                    if state.read().active_view == "core" {
                    div {
                        style: "flex: 1; overflow-y: auto; padding: 16px;",

                        // 领域功能卡——领域包功能的入口（点击进工作台）
                        div {
                            style: "display: flex; gap: 10px; padding: 4px 0 14px; flex-wrap: wrap;",
                            div {
                                style: "border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 14px; font-size: 12px; cursor: pointer; background: #fafafa; min-width: 150px;",
                                onclick: move |_| state.write().active_view = "chem",
                                div { style: "font-weight: 600; margin-bottom: 2px;", "化学结构验证" }
                                div { style: "color: #888; font-size: 11px;", "SMILES → 分子式/分子量 · 0 token" }
                            }
                            div {
                                style: "border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 14px; font-size: 12px; cursor: pointer; background: #fafafa; min-width: 150px;",
                                onclick: move |_| state.write().active_view = "paper",
                                div { style: "font-weight: 600; margin-bottom: 2px;", "论文精读" }
                                div { style: "color: #888; font-size: 11px;", "双语对照 · 段落问答 · 动作缓存" }
                            }
                        }

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
                        // 写门审批卡——fail-closed：出现即等裁决，期间禁输入
                        if let Some(p) = state.read().pending_approval.clone() {
                            div {
                                style: "border: 1px solid #b45309; background: #fffbeb; border-radius: 6px; padding: 12px 14px; margin: 10px 0; max-width: 560px;",
                                div {
                                    style: "font-size: 12.5px; font-weight: 700; color: #b45309; margin-bottom: 8px;",
                                    "写操作需要授权 —— 写门 fail-closed"
                                }
                                div {
                                    style: "font-family: Consolas, monospace; font-size: 12px; background: #f5f5f5; border-radius: 4px; padding: 8px 10px; white-space: pre-wrap; margin-bottom: 10px;",
                                    "{p.tool_name}\n操作：{p.operation}\n目标：{p.target}"
                                }
                                div {
                                    style: "display: flex; gap: 8px;",
                                    button {
                                        style: "padding: 6px 14px; font-size: 12.5px; cursor: pointer; background: #16a34a; color: white; border: none; border-radius: 4px; font-weight: 600;",
                                        onclick: move |_| resolve_approval.call(true),
                                        "允许一次"
                                    }
                                    button {
                                        style: "padding: 6px 14px; font-size: 12.5px; cursor: pointer; color: #dc2626; border: 1px solid #e5e7eb; background: white; border-radius: 4px;",
                                        onclick: move |_| resolve_approval.call(false),
                                        "拒绝"
                                    }
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
                    } // ===== end if core =====

                    // ===== 化学工作台视图（chem）——复用 ChemLabState =====
                    if state.read().active_view == "chem" {
                        div {
                            style: "flex: 1; overflow-y: auto; padding: 16px;",
                            div {
                                style: "font-size: 12px; color: #888; margin-bottom: 10px; line-height: 1.5;",
                                "粘贴 SMILES，本地解析分子式与分子量——解析失败即幻觉拦截，全程 0 token。"
                                div { style: "font-size: 10px; color: #aaa; margin-top: 2px;",
                                    "支持：有机主族 / 分支 / 环编号 / 双三键；立体@与电荷形态走 RDKit 通道（未接入）。"
                                }
                            }
                            div {
                                style: "display: flex; gap: 8px; margin-bottom: 10px;",
                                input {
                                    style: "flex: 1; padding: 7px 10px; font-family: Consolas, monospace; font-size: 13px; border: 1px solid #ccc; border-radius: 4px;",
                                    placeholder: "例：CC(=O)OC1=CC=CC=C1C(=O)O",
                                    value: "{chem.read().input}",
                                    oninput: move |e| chem.write().input = e.value(),
                                    onkeydown: move |e| {
                                        if e.key() == Key::Enter && !e.is_composing() {
                                            chem.write().analyze();
                                        }
                                    },
                                }
                                button {
                                    style: "padding: 7px 16px; font-size: 12.5px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: 600;",
                                    onclick: move |_| chem.write().analyze(),
                                    "解析验证"
                                }
                            }
                            if let Some((formula, mw, atoms)) = chem.read().last_result.clone() {
                                div {
                                    style: "border: 1px solid #e0e0e0; border-radius: 4px; padding: 14px; margin-bottom: 10px;",
                                    div { style: "font-family: Consolas, monospace; font-size: 22px; font-weight: 700;", "{formula}" }
                                    div { style: "display: flex; gap: 20px; margin-top: 6px; font-size: 12px;",
                                        span { style: "font-family: Consolas, monospace;", "{mw:.2} g/mol" }
                                        span { style: "font-family: Consolas, monospace;", "{atoms} 原子" }
                                        span { style: "font-family: Consolas, monospace; color: #16a34a;", "0 token" }
                                    }
                                    div { style: "font-size: 11px; color: #16a34a; margin-top: 8px;", "✓ 机器验证通过（本地解析器，非 LLM）" }
                                }
                            }
                            div { style: "font-size: 12px; color: #888; margin-bottom: 6px; font-weight: 600;", "事件流（驯化闸门记录）" }
                            if chem.read().events.is_empty() {
                                div { style: "font-size: 12px; color: #aaa;", "暂无记录——输入 SMILES 开始" }
                            }
                            for (i, ev) in chem.read().events.iter().cloned().enumerate() {
                                div {
                                    key: "{i}",
                                    style: if ev.is_alert() {
                                        "padding: 6px 10px; margin-bottom: 5px; background: #fafafa; border-left: 3px solid #b45309; border-radius: 4px; font-size: 12px;"
                                    } else {
                                        "padding: 6px 10px; margin-bottom: 5px; background: #fafafa; border-left: 3px solid #16a34a; border-radius: 4px; font-size: 12px;"
                                    },
                                    if ev.is_alert() { "⚠ 幻觉拦截" } else { "✓ 验证通过" }
                                    " · {ev.summary()}"
                                }
                            }
                        }
                    }

                    // ===== 论文精读视图（paper）——复用 ReaderState =====
                    if state.read().active_view == "paper" {
                        div {
                            style: "flex: 1; overflow-y: auto; padding: 16px;",
                            div {
                                style: "font-size: 12px; color: #888; margin-bottom: 10px;",
                                "段落点选 → 动作按钮（规范化键缓存，同段同动作第二次 0 token）"
                            }
                            div {
                                style: "display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;",
                                for sec in crate::paper_reader::default_sections() {
                                    button {
                                        key: "{sec.no}",
                                        style: if reader_current.read().to_string() == sec.no.to_string() {
                                            "padding: 3px 10px; font-size: 11px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 3px;"
                                        } else {
                                            "padding: 3px 10px; font-size: 11px; cursor: pointer; background: #e5e7eb; border: none; border-radius: 3px;"
                                        },
                                        onclick: move |_| reader_current.set(sec.no),
                                        "§{sec.no} {sec.digest}"
                                    }
                                }
                            }
                            div {
                                style: "display: flex; gap: 8px; margin-bottom: 10px;",
                                button {
                                    style: "padding: 4px 12px; font-size: 12px; cursor: pointer;",
                                    onclick: move |_| {
                                        let no = reader_current.read().to_string().parse::<u32>().unwrap_or(1);
                                        work_trigger.call(("summarize", no));
                                    },
                                    "摘要本段"
                                }
                                button {
                                    style: "padding: 4px 12px; font-size: 12px; cursor: pointer;",
                                    onclick: move |_| {
                                        let no = reader_current.read().to_string().parse::<u32>().unwrap_or(1);
                                        work_trigger.call(("ask", no));
                                    },
                                    "问答本段"
                                }
                            }
                            div { style: "font-size: 12px; color: #888; margin-bottom: 6px; font-weight: 600;", "产出" }
                            if reader.read().outputs.is_empty() {
                                div { style: "font-size: 12px; color: #aaa;", "选段后点动作按钮" }
                            }
                            for (i, (name, no, text, hit)) in reader.read().outputs.iter().cloned().enumerate() {
                                div {
                                    key: "{i}",
                                    style: "padding: 6px 10px; margin-bottom: 5px; background: #fafafa; border-radius: 4px; font-size: 12px;",
                                    div { style: "color: #888; font-size: 11px; margin-bottom: 2px;",
                                        if hit { "⚡ 缓存回放" } else { "首次执行" }
                                        " · {name} · §{no}"
                                    }
                                    "{text}"
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
