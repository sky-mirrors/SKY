//! SKY 应用外壳。
//!
//! 承接现状：
//! - `electron/window-manager.ts`（8 个 BrowserWindow）→ `window`
//! - `electron/main.ts`（284 行）→ `ui` 的启动入口
//! - `electron/preload.ts`（393 行）+ 65 个 IPC channel → 由 Dioxus 单进程内直调取代
//! - `src/domains/dialog/handlers.ts` 的 core→UI 反向调用 → `bridge`
//!
//! **本 crate 是唯一依赖 Dioxus 的 crate**——其余 8 个 crate 均为纯逻辑，
//! 可脱离 GUI 单测（`cargo test -p sky-core` 等）。

pub mod app_automation;
pub mod artifact;
pub mod bridge;
pub mod paper_reader;
pub mod pipeline;
pub mod planner;
pub mod real_runner;
pub mod smiles;
pub mod tools;
pub mod ui;
pub mod window;

pub use artifact::{
    compose_document, pick_final_output, write_artifact, ArtifactConfig, ArtifactOutcome,
};
pub use bridge::{AutoDenyBridge, FrameCoalescer, ProgressEvent, DEFAULT_TIMEOUT_MS, FRAME_COALESCE_MS};
pub use pipeline::{assistant_message, EchoRunner, Pipeline, PipelineResult, RouteOutcome};
pub use planner::{parse_plan, LlmPlanner, PlanOutcome, PLANNER_SYSTEM_PROMPT};
pub use real_runner::{RealRunner, ToolFuture, ToolImpl};
pub use tools::register_all;
pub use window::{OpenAction, WindowId, WindowRegistry};
