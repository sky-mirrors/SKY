//! SKY 领域包宿主。
//!
//! 对应现状 `src/host/pack/loader.ts`（487 行）+ `dsl.ts`（316 行）。
//!
//! **与现状的一处结构性差异（有意为之）**：
//! 现状 `loader.ts:123` 用 `import.meta.glob` 在**编译期**收集内置包——
//! 那是 Vite 专有机制，Rust 侧没有对应物。本实现改为通过 `PackSource`
//! trait 在**运行时**读取，内置包与用户包走同一条路径。
//! 这也顺带解决了现状的缺口：`listEvaluators` 恒为空（编译期模块无法运行时加载）。

pub mod dsl;
pub mod loader;
pub mod workmode;

pub use dsl::{
    evaluate_constraints, validate_all, validate_pack_constraint, Applicability, ConstraintResult,
    PackConstraint, Reliability, SchemaValidationError,
};
pub use loader::{
    KnowledgeEntry, MountError, MountFailReason, MountPhase, MountResult, MountedPack, PackExecution,
    PackHost, PackManifest, PackSource, PackStep,
};
pub use workmode::{WorkAction, WorkMode};
