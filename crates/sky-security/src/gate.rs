//! 单一安全 chokepoint。
//!
//! 设计目标：**所有副作用必须穿过本模块**。
//!
//! 三条不变量：
//! 1. **单一入口**——shell / 文件写 / 网络 / MCP 四个副作用面全部经
//!    `Security::authorize` 裁决，不存在第二条判定路径。
//!    对齐现状 `writeGate.ts:126-133` 的自述：「这是 O10 的唯一裁决入口」。
//! 2. **默认拒绝**（fail-closed）——任何判定失败路径（超时、无法规范化、
//!    未匹配白名单）一律 `Deny`。
//! 3. **写操作唯一裁决入口**——不允许绕开 `authorize` 直接执行写操作。

use crate::path::{validate_open_path, validate_read_path, validate_write_path, PathCheck};
use crate::shell::{is_shell_command_allowed, ShellDecision};
use sky_core::WriteDecision;
use std::path::PathBuf;

/// 副作用动作。
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// 执行 shell 命令。
    Shell { command: String },
    /// 写文件。
    FileWrite { path: String },
    /// 读文件。
    FileRead { path: String },
    /// 打开文件（交给系统默认程序）。
    FileOpen { path: String },
    /// 网络请求。
    Http { url: String, method: String },
    /// MCP 子进程。
    McpSpawn { command: String },
}

impl Action {
    pub fn kind(&self) -> &'static str {
        match self {
            Action::Shell { .. } => "shell",
            Action::FileWrite { .. } => "file_write",
            Action::FileRead { .. } => "file_read",
            Action::FileOpen { .. } => "file_open",
            Action::Http { .. } => "http",
            Action::McpSpawn { .. } => "mcp_spawn",
        }
    }

    /// 该动作是否属于「写」类（需要用户授权）。
    pub fn is_write(&self) -> bool {
        matches!(self, Action::FileWrite { .. } | Action::Shell { .. })
    }
}

/// 裁决结果。
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// 允许执行。
    Allow,
    /// 需要用户确认（写类动作）。
    NeedsApproval,
    /// 拒绝。
    Deny(String),
}

impl Verdict {
    pub fn is_allow(&self) -> bool {
        matches!(self, Verdict::Allow)
    }

    pub fn is_deny(&self) -> bool {
        matches!(self, Verdict::Deny(_))
    }
}

/// 安全策略配置。
#[derive(Debug, Clone)]
pub struct SecurityPolicy {
    /// 允许读写的目录。**空表示全部拒绝**（fail-closed）。
    pub allowed_dirs: Vec<PathBuf>,
    /// 是否要求写类动作经用户授权。
    pub require_approval_for_writes: bool,
    /// 已授予「始终允许」的路径前缀。
    pub always_allow_prefixes: Vec<String>,
    /// 允许的 HTTP 方法。
    pub http_allowed_methods: Vec<String>,
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            allowed_dirs: Vec::new(),
            require_approval_for_writes: true,
            always_allow_prefixes: Vec::new(),
            http_allowed_methods: vec![
                "GET".into(),
                "POST".into(),
                "PUT".into(),
                "PATCH".into(),
                "DELETE".into(),
                "HEAD".into(),
            ],
        }
    }
}

/// 安全 chokepoint。
pub struct Security {
    policy: SecurityPolicy,
}

impl Security {
    pub fn new(policy: SecurityPolicy) -> Self {
        Self { policy }
    }

    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    /// 唯一裁决入口。
    ///
    /// **fail-closed**：任何无法判定的情形返回 `Deny`。
    pub fn authorize(&self, action: &Action) -> Verdict {
        match action {
            Action::Shell { command } => self.authorize_shell(command),

            Action::FileWrite { path } => {
                let chk = validate_write_path(path, &self.policy.allowed_dirs);
                if !chk.safe {
                    return Verdict::Deny(chk.reason.unwrap_or_else(|| "路径校验失败".into()));
                }
                if self.is_always_allowed(path) {
                    return Verdict::Allow;
                }
                if self.policy.require_approval_for_writes {
                    Verdict::NeedsApproval
                } else {
                    Verdict::Allow
                }
            }

            Action::FileRead { path } => {
                let chk = validate_read_path(path, &self.policy.allowed_dirs);
                to_verdict(chk)
            }

            Action::FileOpen { path } => {
                let chk = validate_open_path(path, &self.policy.allowed_dirs);
                to_verdict(chk)
            }

            Action::Http { url, method } => self.authorize_http(url, method),

            Action::McpSpawn { command } => {
                // MCP 子进程同样受 shell 白名单约束
                self.authorize_shell(command)
            }
        }
    }

    fn authorize_shell(&self, command: &str) -> Verdict {
        match is_shell_command_allowed(command) {
            ShellDecision::Allowed => {
                if self.policy.require_approval_for_writes {
                    Verdict::NeedsApproval
                } else {
                    Verdict::Allow
                }
            }
            ShellDecision::Denied(r) => Verdict::Deny(r),
        }
    }

    fn authorize_http(&self, url: &str, method: &str) -> Verdict {
        let m = method.to_uppercase();
        if !self
            .policy
            .http_allowed_methods
            .iter()
            .any(|a| a.eq_ignore_ascii_case(&m))
        {
            return Verdict::Deny(format!("HTTP 方法不在允许列表内: {method}"));
        }

        // 仅允许 http/https
        let lower = url.to_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Verdict::Deny(format!("仅允许 http/https 协议: {url}"));
        }

        Verdict::Allow
    }

    fn is_always_allowed(&self, path: &str) -> bool {
        let p = path.replace('/', "\\").to_lowercase();
        self.policy
            .always_allow_prefixes
            .iter()
            .any(|pre| p.starts_with(&pre.replace('/', "\\").to_lowercase()))
    }

    /// 应用用户裁决结果。
    ///
    /// - `Deny` → 拒绝
    /// - `Once` → 仅本次放行
    /// - `Always` → 记入 always_allow 前缀（取父目录）
    pub fn apply_decision(&mut self, action: &Action, decision: WriteDecision) -> Verdict {
        match decision {
            WriteDecision::Deny => Verdict::Deny("用户拒绝".into()),
            WriteDecision::Once => Verdict::Allow,
            WriteDecision::Always => {
                if let Action::FileWrite { path } = action {
                    if let Some(parent) = parent_of(path) {
                        self.policy.always_allow_prefixes.push(parent);
                    }
                }
                Verdict::Allow
            }
        }
    }
}

fn to_verdict(chk: PathCheck) -> Verdict {
    if chk.safe {
        Verdict::Allow
    } else {
        Verdict::Deny(chk.reason.unwrap_or_else(|| "路径校验失败".into()))
    }
}

fn parent_of(path: &str) -> Option<String> {
    let normalized = path.replace('/', "\\");
    let idx = normalized.rfind('\\')?;
    if idx == 0 {
        return None;
    }
    Some(normalized[..idx].to_string())
}

/// 便捷函数：默认策略（无允许目录）下的裁决。
/// 用于验证 fail-closed 行为。
pub fn deny_all_security() -> Security {
    Security::new(SecurityPolicy::default())
}
