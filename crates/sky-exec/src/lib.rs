//! SKY 执行层。
//!
//! 对应现状 `src/services/macroExecutor.ts`（2043 行）。
//!
//! 注意：`src/composables/useDagEngine.ts`（601 行）经核实是 **canvas 画布渲染**
//! （`drawGrid` / `drawNode` / `hitTest*` / `onMouseDown`），不是执行引擎——
//! 它属于 UI 层，将在 Wave 6 由 Dioxus 侧承接，不进本 crate。

pub mod condition;
pub mod engine;

pub use condition::evaluate_condition;
pub use engine::{
    execute_plan, should_run_step, topological_order, ExecError, ExecEvent, ExecOptions,
    MacroRunResult, StepOutcome, StepRunner, StepStatus,
};
