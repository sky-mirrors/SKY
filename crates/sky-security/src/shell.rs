//! shell 命令安全。
//!
//! 对应现状 `electron/shell-security.ts`（537 行）。
//!
//! **必须保留的历史修复**（均为实际攻防迭代，回归即漏洞）：
//! - **P0-1**：cmd.exe 元字符黑名单。`%` 与**内嵌**换行一律拒绝
//!   （`%VAR%` 展开后的 `&` 仍是分隔符）；`& | < > ^` 仅在双引号外拒绝。
//! - **V2-R15**：**先 trim 再扫描**——只有内嵌换行构成注入面，
//!   尾随 `\n`（模型输出常带）不改变执行语义，此前误判整体拒绝。
//! - **2026-10-10 加固**：反引号与 `$(` 在双引号内仍会展开，故不设引号门槛；
//!   `;` 在引号外拒绝。
//! - **A-05**：`node -e` 必须从**原始串**提取代码做校验，
//!   不得校验 lowercase 副本（校验输入与执行输入必须一致）。

/// shell 命令白名单。对应 `shell-security.ts:4-17`。
pub const SHELL_ALLOWED_COMMANDS: &[&str] = &[
    "npm install",
    "dir ",
    "ls",
    "cat ",
    "echo ",
    "type ",
    "mkdir ",
    "copy ",
    "cp ",
    "cd ",
    "pwd",
    "pip install",
];

/// 查找 shell 元字符，返回命中的字符（无则 None）。
///
/// 对应 `shell-security.ts:22` `findShellMetacharacter`。
///
/// 扫描顺序与现状一致；注意 `trim()` 在扫描**之前**（V2-R15）。
pub fn find_shell_metacharacter(command: &str) -> Option<char> {
    let trimmed = command.trim();

    let mut in_quote = false;
    for ch in trimmed.chars() {
        if ch == '"' {
            in_quote = !in_quote;
            continue;
        }
        // % 一律拒绝（%VAR% 展开后的 & 仍是命令分隔符）
        if ch == '%' {
            return Some('%');
        }
        // 内嵌换行一律拒绝
        if ch == '\n' {
            return Some('\n');
        }
        if ch == '\r' {
            return Some('\r');
        }
        // 引号外的 cmd.exe 元字符
        if !in_quote && matches!(ch, '&' | '|' | '<' | '>' | '^') {
            return Some(ch);
        }
        // 反引号在双引号内仍会展开 → 不设引号门槛
        if ch == '`' {
            return Some('`');
        }
        // 分号仅引号外拒绝
        if !in_quote && ch == ';' {
            return Some(';');
        }
    }

    // 引号未闭合
    if in_quote {
        return Some('"');
    }

    // 命令替换在双引号内也会展开 → 独立判定
    if trimmed.contains("$(") {
        return Some('$');
    }

    None
}

/// shell 命令裁决。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellDecision {
    Allowed,
    Denied(String),
}

impl ShellDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, ShellDecision::Allowed)
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            ShellDecision::Denied(r) => Some(r),
            ShellDecision::Allowed => None,
        }
    }
}

/// 校验 shell 命令是否允许执行。
///
/// 对应 `shell-security.ts:429` `isShellCommandAllowed`。
///
/// **fail-closed**：任何未匹配白名单的形态一律拒绝。
pub fn is_shell_command_allowed(command: &str) -> ShellDecision {
    // 1) 元字符先行
    if let Some(m) = find_shell_metacharacter(command) {
        return ShellDecision::Denied(format!(
            "命令包含shell元字符 '{m}'，被安全策略拒绝"
        ));
    }

    let trimmed = command.trim().to_lowercase();

    // 2) node -e 受限模式
    if trimmed.starts_with("node -e ") || trimmed.starts_with("node -e\"") {
        // A-05：从原始串提取，不得用小写副本
        let code = extract_node_e_code(command);
        if let Some(danger) = find_dangerous_node_pattern(&code) {
            return ShellDecision::Denied(format!(
                "node -e 代码包含危险模式（{danger}），被安全策略拒绝"
            ));
        }
        return ShellDecision::Allowed;
    }

    // 3) npx 仅允许经 MCP spawn
    if trimmed.starts_with("npx ") {
        return ShellDecision::Denied("npx命令仅允许通过MCP spawn执行，被安全策略拒绝".into());
    }

    // 4) node 脚本执行仅允许 MCP spawn
    if trimmed.starts_with("node ") && !trimmed.starts_with("node -e") {
        return ShellDecision::Denied(
            "node脚本执行仅允许通过MCP spawn或node -e受限模式，被安全策略拒绝".into(),
        );
    }

    // 5) 白名单前缀匹配
    for allowed in SHELL_ALLOWED_COMMANDS {
        if trimmed.starts_with(&allowed.to_lowercase()) {
            return ShellDecision::Allowed;
        }
    }

    ShellDecision::Denied(format!("命令不在白名单内，被安全策略拒绝: {trimmed}"))
}

/// 从原始命令串提取 `node -e` 的代码内容。
/// A-05：必须用**原始串**，不得用小写副本。
fn extract_node_e_code(raw: &str) -> String {
    let t = raw.trim();
    let rest = if let Some(r) = strip_prefix_ci(t, "node -e ") {
        r
    } else if let Some(r) = strip_prefix_ci(t, "node -e\"") {
        r
    } else {
        return String::new();
    };
    rest.trim_end_matches('"').to_string()
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&s[prefix.len()..])
    } else {
        None
    }
}

/// `node -e` 危险模式检测。
/// 对应 `shell-security.ts:46` `NODE_E_DANGEROUS_PATTERNS`（取核心子集）。
///
/// 同时匹配原始串与小写串，堵死大小写规避（对齐现状 `shell-security.ts:449`）。
const DANGEROUS_NODE_PATTERNS: &[&str] = &[
    "child_process",
    "process.exit",
    "process.kill",
    "process.binding",
    "process.mainmodule",
    "eval(",
    "function(",
    ".exec(",
    ".spawn(",
    ".execfile(",
    ".execsync(",
    ".spawnsync(",
    ".unlink(",
    ".unlinksync(",
    "import(",
];

fn find_dangerous_node_pattern(code: &str) -> Option<&'static str> {
    let lowered = code.to_lowercase();
    DANGEROUS_NODE_PATTERNS
        .iter()
        .find(|p| lowered.contains(*p))
        .copied()
}
