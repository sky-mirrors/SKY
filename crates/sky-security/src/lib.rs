//! SKY 安全层。
//!
//! 四合一单一 chokepoint，对应现状：
//! - `electron/shell-security.ts`（537 行）→ `shell`
//! - `electron/pathValidator.ts`（269 行）→ `path`
//! - `src/services/writeGate.ts`（153 行）→ `gate`
//! - `src/services/deliverableCheck.ts`（288 行）→ 待 Wave 4b
//!
//! 三条不变量见 `gate` 模块文档。

pub mod gate;
pub mod path;
pub mod shell;
pub mod task_gate;

pub use gate::{deny_all_security, Action, Security, SecurityPolicy, Verdict};
pub use task_gate::{
    check_task_shell, TaskShellVerdict, DESTRUCTIVE_PATTERNS, DANGEROUS_SUBCOMMANDS,
    TASK_SHELL_ALLOWED, UNEXPLAINABLE_CONSTRUCTS,
};
pub use path::{
    get_safe_extension, has_suspicious_basename, has_traversal_segment, is_within, validate_open_path,
    validate_path, validate_read_path, validate_write_path, PathCheck, DANGEROUS_EXTENSIONS,
    SAFE_OPEN_EXTENSIONS,
};
pub use shell::{
    find_shell_metacharacter, is_shell_command_allowed, ShellDecision, SHELL_ALLOWED_COMMANDS,
};
