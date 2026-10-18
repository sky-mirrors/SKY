//! 任务书 `shell_exec` 闸门——从 `sky-app\src\tools.rs` 上移的单一事实源。
//!
//! **为什么单独一套**（而不是复用 [`crate::shell`] 的 TS 对齐闸门）：
//! `SHELL_ALLOWED_COMMANDS`（12 条，对齐 `shell-security.ts`）含 `npm install` /
//! `mkdir` / `cp` 等**写类**命令，直接换用会放松任务书执行器的安全姿态。
//! 两套语义不同：TS 闸门守的是「聊天界面里用户可见的 shell」，本闸门守的是
//! 「任务书 DAG 里的无人值守 shell」——后者必须更严。
//!
//! **为什么上移到 sky-security**：白名单/危险模式两处并存时，改一处漏一处
//! （HANDOFF §9.2）。收敛后任务书闸门只有一个定义点，规则变更单点生效。
//!
//! 闸门序列与拒绝语义**逐字保留**自 sky-app 原实现（含 5 道顺序），
//! 现有 sky-app 测试（拒绝理由断言）继续锁定行为。

/// 任务书 shell 白名单——15 条，只读/低风险。
///
/// 保守清单：写类操作（mv/rm/cp/mkdir）应由专用工具（`file_move` 等）
/// 完成，它们有参数校验与拒绝覆盖逻辑。
pub const TASK_SHELL_ALLOWED: &[&str] = &[
    "ls", "dir", "cat", "type", "head", "tail", "wc", "find", "grep", "rg", "echo", "pwd",
    "date", "whoami", "git",
];

/// 危险子命令模式（白名单内命令的破坏性用法）。
pub const DANGEROUS_SUBCOMMANDS: &[&str] = &[
    "git clean",
    "git reset --hard",
    "git reset --mixed",
    "git checkout --",
    "git restore",
    "git branch -d",
    "git branch -D",
    "git push -f",
    "git push --force",
    "git stash drop",
    "-delete",
    "-exec",
    "--exec",
    "find / -",
];

/// 破坏性模式（任意命令形态）。
pub const DESTRUCTIVE_PATTERNS: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "rm -r",
    "del /f",
    "del /q",
    "rmdir /s",
    "format ",
    "mkfs",
    "dd of=",
    "> /dev/sd",
    ":(){",
    "shutdown",
    "reboot",
    "chmod -R 777",
    "> /dev/null 2>&1 &",
];

/// 无法静态解释的复合结构（结构 → 人话名）。
pub const UNEXPLAINABLE_CONSTRUCTS: &[(&str, &str)] = &[
    ("|", "管道"),
    (">", "输出重定向"),
    ("<", "输入重定向"),
    ("`", "命令替换"),
    ("$(", "命令替换"),
    ("&&", "命令串联"),
    ("||", "命令串联"),
    (";", "命令串联"),
];

/// 闸门裁决。
#[derive(Debug, Clone, PartialEq)]
pub enum TaskShellVerdict {
    /// 通过全部闸门，可执行。
    Allowed,
    /// 被某道闸门拒绝，携带人话理由。
    Denied(String),
}

/// 任务书 shell 闸门：5 道顺序检查（fail-closed）。
///
/// 1. 破坏性模式（任意位置命中即拒）
/// 2. 复合结构（管道/重定向/命令替换/串联 → 无法静态判断影响）
/// 3. 程序名带路径（白名单只认裸名，防「以某名字结尾」类未来绕过）
/// 4. 白名单内命令的危险子命令（git clean / find -delete 等）
/// 5. 程序名白名单
pub fn check_task_shell(command: &str) -> TaskShellVerdict {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return TaskShellVerdict::Denied("命令为空".into());
    }

    // 闸门 1：破坏性模式
    if let Some(hit) = destructive_pattern(trimmed) {
        return TaskShellVerdict::Denied(format!(
            "shell_exec 拒绝执行：命令含破坏性模式「{hit}」。\
             如需执行请由用户手动确认后运行。命令：{trimmed}"
        ));
    }

    // 闸门 2：复合命令不可解释 → 拒绝
    if let Some(hit) = unexplainable_shell_construct(trimmed) {
        return TaskShellVerdict::Denied(format!(
            "shell_exec 拒绝执行：命令含「{hit}」等复合结构，\
             无法静态判断其影响。如需执行请由用户手动确认。命令：{trimmed}"
        ));
    }

    // 闸门 3：程序名必须是纯裸名
    let prog = trimmed.split_whitespace().next().unwrap_or("");
    if prog.contains('/') || prog.contains('\\') {
        return TaskShellVerdict::Denied(format!(
            "shell_exec 拒绝执行：程序名不能带路径「{prog}」。\
             请用裸名（如 cat 而非 /bin/cat）。如需执行请由用户手动确认。"
        ));
    }

    // 闸门 4：白名单内命令的危险子命令
    let lower = trimmed.to_lowercase();
    if let Some(hit) = dangerous_subcommand(&lower) {
        return TaskShellVerdict::Denied(format!(
            "shell_exec 拒绝执行：命令含危险子操作「{hit}」。\
             如需执行请由用户手动确认后运行。命令：{trimmed}"
        ));
    }

    // 闸门 5：白名单
    if !TASK_SHELL_ALLOWED.contains(&prog) {
        return TaskShellVerdict::Denied(format!(
            "shell_exec 拒绝执行：命令「{prog}」不在允许清单内。\
             允许：{}。如需执行请由用户手动确认。",
            TASK_SHELL_ALLOWED.join(", ")
        ));
    }

    TaskShellVerdict::Allowed
}

fn dangerous_subcommand(lower: &str) -> Option<&'static str> {
    DANGEROUS_SUBCOMMANDS
        .iter()
        .find(|p| lower.contains(&p.to_lowercase()))
        .copied()
}

fn destructive_pattern(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_lowercase();
    DESTRUCTIVE_PATTERNS
        .iter()
        .find(|p| lower.contains(&p.to_lowercase()))
        .copied()
}

fn unexplainable_shell_construct(cmd: &str) -> Option<&'static str> {
    UNEXPLAINABLE_CONSTRUCTS
        .iter()
        .find(|(p, _)| cmd.contains(p))
        .map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 行为不变量：原 sky-app 测试锁定的拒绝理由必须逐字保留。
    #[test]
    fn destructive_patterns_denied() {
        for cmd in ["rm -rf /tmp/x", "del /f a.txt", "format c:", "dd of=/dev/sda"] {
            let v = check_task_shell(cmd);
            let TaskShellVerdict::Denied(r) = v else {
                panic!("{cmd} 应被拒绝");
            };
            assert!(r.contains("破坏性模式"), "{cmd} 的理由应提破坏性模式：{r}");
        }
    }

    #[test]
    fn composite_constructs_denied() {
        for (cmd, name) in [
            ("ls | wc", "管道"),
            ("cat f > out", "输出重定向"),
            ("cat f < in", "输入重定向"),
            ("a && b", "命令串联"),
        ] {
            let v = check_task_shell(cmd);
            let TaskShellVerdict::Denied(r) = v else {
                panic!("{cmd} 应被拒绝");
            };
            assert!(r.contains(name), "{cmd} 的理由应提「{name}」：{r}");
        }
    }

    #[test]
    fn pathed_program_denied() {
        let v = check_task_shell("/bin/cat file");
        let TaskShellVerdict::Denied(r) = v else {
            panic!("带路径程序名应被拒绝");
        };
        assert!(r.contains("不能带路径"), "{r}");
    }

    #[test]
    fn dangerous_subcommands_denied() {
        for cmd in ["git clean -fdx", "git reset --hard", "find . -delete", "find / -name x"] {
            let v = check_task_shell(cmd);
            let TaskShellVerdict::Denied(r) = v else {
                panic!("{cmd} 应被拒绝");
            };
            assert!(r.contains("危险子操作"), "{cmd} 的理由应提危险子操作：{r}");
        }
    }

    #[test]
    fn allowlist_enforced() {
        let v = check_task_shell("curl http://evil");
        let TaskShellVerdict::Denied(r) = v else {
            panic!("白名单外命令应被拒绝");
        };
        assert!(r.contains("不在允许清单"), "{r}");
        assert!(r.contains("ls"), "拒绝消息应列白名单");
    }

    #[test]
    fn readonly_commands_allowed() {
        for cmd in ["ls", "cat a.txt", "grep -r todo .", "git log --oneline", "pwd"] {
            assert_eq!(check_task_shell(cmd), TaskShellVerdict::Allowed, "{cmd} 应放行");
        }
    }

    #[test]
    fn empty_command_denied() {
        assert!(matches!(check_task_shell("   "), TaskShellVerdict::Denied(_)));
    }
}
