//! SKY 核心 crate。
//!
//! 纯逻辑，无 GUI 依赖——可独立 `cargo test`。
//! 端口契约对应 `src/kernel/types.ts` 的 `PersistencePort` / `IOPort` / `LLMPort`。

pub mod manifest;
pub mod manifest_builtin;
pub mod model;
pub mod port;

pub use manifest::{
    parse_all, referenced_tools, Binding, CacheMeta, DagPlan, DagStep, DirectCall, Execution,
    Identity, L2Manifest, ManifestFailure, ManifestLoad, ParamMapping, Routing, Slot,
};
pub use manifest_builtin::{load_builtin, BUILTIN_SOURCES};
pub use model::{
    BudgetMode, ChatMessage, DetectedDomain, ModelTier, PlanStep, RouteInput, RouteResult,
    TaskComplexity, TaskPlan,
};
pub use port::{Io, Llm, Persistence, ShellOut, UiBridge, WriteDecision, WriteRequest};
