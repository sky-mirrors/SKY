//! sky-security 测试。
//!
//! 安全层要求**双向覆盖**：该拒的必须拒（拒绝用例），该放的必须放（放行用例）。
//! 只测一侧的安全测试是假保护。

use sky_core::WriteDecision;
use sky_security::*;
use std::path::PathBuf;

fn dirs() -> Vec<PathBuf> {
    vec![PathBuf::from("C:\\Users\\test\\Desktop")]
}

// ==================== 元字符（拒绝侧） ====================

#[test]
fn rejects_percent_always() {
    assert_eq!(find_shell_metacharacter("echo %PATH%"), Some('%'));
    // 引号内也拒绝
    assert_eq!(find_shell_metacharacter("echo \"%PATH%\""), Some('%'));
}

#[test]
fn rejects_ampersand_outside_quotes() {
    assert_eq!(find_shell_metacharacter("ls & whoami"), Some('&'));
}

#[test]
fn rejects_pipe_outside_quotes() {
    assert_eq!(find_shell_metacharacter("ls | grep x"), Some('|'));
}

#[test]
fn rejects_redirect_outside_quotes() {
    assert_eq!(find_shell_metacharacter("ls > out.txt"), Some('>'));
    assert_eq!(find_shell_metacharacter("ls < in.txt"), Some('<'));
}

#[test]
fn rejects_caret_outside_quotes() {
    assert_eq!(find_shell_metacharacter("ls ^ x"), Some('^'));
}

#[test]
fn rejects_semicolon_outside_quotes() {
    assert_eq!(find_shell_metacharacter("ls ; whoami"), Some(';'));
}

/// 2026-10-10 加固：反引号在双引号内仍会展开。
#[test]
fn rejects_backtick_even_inside_quotes() {
    assert_eq!(find_shell_metacharacter("echo `whoami`"), Some('`'));
    assert_eq!(find_shell_metacharacter("echo \"`whoami`\""), Some('`'));
}

/// 2026-10-10 加固：命令替换在双引号内也会展开。
#[test]
fn rejects_command_substitution_inside_quotes() {
    assert_eq!(find_shell_metacharacter("echo \"$(whoami)\""), Some('$'));
}

#[test]
fn rejects_embedded_newline() {
    assert_eq!(find_shell_metacharacter("ls\nrm -rf /"), Some('\n'));
}

#[test]
fn rejects_unclosed_quote() {
    assert_eq!(find_shell_metacharacter("echo \"unclosed"), Some('"'));
}

// ==================== 元字符（放行侧） ====================

/// V2-R15 回归：尾随换行不构成注入面，不得误拒。
#[test]
fn allows_trailing_newline() {
    assert_eq!(find_shell_metacharacter("ls\n"), None);
    assert_eq!(find_shell_metacharacter("ls   \n  "), None);
}

#[test]
fn allows_plain_command() {
    assert_eq!(find_shell_metacharacter("ls -la"), None);
    assert_eq!(find_shell_metacharacter("echo hello"), None);
}

/// 引号内的 & | < > ^ 是字面量，应放行。
#[test]
fn allows_metachars_inside_quotes() {
    assert_eq!(find_shell_metacharacter("echo \"a & b\""), None);
    assert_eq!(find_shell_metacharacter("echo \"a | b\""), None);
}

// ==================== shell 白名单 ====================

#[test]
fn allows_whitelisted_commands() {
    assert!(is_shell_command_allowed("ls").is_allowed());
    assert!(is_shell_command_allowed("ls -la").is_allowed());
    assert!(is_shell_command_allowed("echo hello").is_allowed());
    assert!(is_shell_command_allowed("pwd").is_allowed());
    assert!(is_shell_command_allowed("cat file.txt").is_allowed());
}

#[test]
fn allows_whitelisted_case_insensitively() {
    assert!(is_shell_command_allowed("LS -LA").is_allowed());
    assert!(is_shell_command_allowed("Echo hi").is_allowed());
}

/// 拒绝用例：不在白名单的命令。
#[test]
fn denies_non_whitelisted_command() {
    let d = is_shell_command_allowed("rm -rf /");
    assert!(matches!(d, ShellDecision::Denied(_)));
}

/// 拒绝用例：npx 必须经 MCP。
#[test]
fn denies_npx_direct() {
    assert!(is_shell_command_allowed("npx something").reason().is_some());
}

/// 拒绝用例：node 脚本必须经 MCP。
#[test]
fn denies_node_script() {
    assert!(is_shell_command_allowed("node script.js").reason().is_some());
}

/// 拒绝用例：元字符先于白名单判定。
#[test]
fn denies_metachar_before_whitelist() {
    // ls 在白名单内，但含 & 必须拒
    let d = is_shell_command_allowed("ls & whoami");
    assert!(matches!(d, ShellDecision::Denied(_)));
}

// ==================== node -e ====================

#[test]
fn allows_safe_node_e() {
    assert!(is_shell_command_allowed("node -e \"console.log(1)\"").is_allowed());
}

/// 拒绝用例：危险模块。
#[test]
fn denies_node_e_child_process() {
    let d = is_shell_command_allowed("node -e \"require('child_process')\"");
    assert!(matches!(d, ShellDecision::Denied(_)), "得到 {d:?}");
}

#[test]
fn denies_node_e_eval() {
    let d = is_shell_command_allowed("node -e \"eval('x')\"");
    assert!(matches!(d, ShellDecision::Denied(_)));
}

/// A-05：大小写规避必须被堵死（校验原始串而非仅小写副本）。
#[test]
fn denies_node_e_case_variant() {
    let d = is_shell_command_allowed("node -e \"require('Child_Process')\"");
    assert!(matches!(d, ShellDecision::Denied(_)), "大小写变体必须拒");
}

#[test]
fn denies_node_e_process_exit() {
    let d = is_shell_command_allowed("node -e \"process.exit(1)\"");
    assert!(matches!(d, ShellDecision::Denied(_)));
}

// ==================== 路径穿越 ====================

#[test]
fn detects_traversal_segment() {
    assert!(has_traversal_segment("out\\..\\..\\Windows\\evil.md"));
    assert!(has_traversal_segment("../etc/passwd"));
    assert!(!has_traversal_segment("out\\safe\\file.md"));
}

/// V2-S04 回归：归一化后看似合法、实则穿越的路径必须拒。
#[test]
fn rejects_traversal_even_if_normalized_stays_inside() {
    let chk = validate_write_path("C:\\Users\\test\\Desktop\\out\\..\\..\\Windows\\evil.md", &dirs());
    assert!(!chk.safe, "含 .. 段必须拒，即便归一化后仍在允许目录");
}

#[test]
fn rejects_empty_path() {
    assert!(!validate_path("", &dirs()).safe);
}

/// fail-closed：无允许目录时一律拒绝。
#[test]
fn rejects_when_no_allowed_dirs() {
    let chk = validate_path("C:\\Users\\test\\Desktop\\a.txt", &[]);
    assert!(!chk.safe, "无允许目录必须 fail-closed");
}

#[test]
fn rejects_outside_allowed_dirs() {
    let chk = validate_read_path("C:\\Windows\\System32\\config\\SAM", &dirs());
    assert!(!chk.safe);
}

#[test]
fn allows_inside_allowed_dirs() {
    let chk = validate_read_path("C:\\Users\\test\\Desktop\\notes.txt", &dirs());
    assert!(chk.safe, "允许目录内应放行，理由 {:?}", chk.reason);
}

// ==================== 可疑文件名（A-20 对称） ====================

#[test]
fn detects_suspicious_basename() {
    assert!(has_suspicious_basename("file.txt."));
    assert!(has_suspicious_basename("file.txt "));
    assert!(has_suspicious_basename("file.txt:stream"));
    assert!(!has_suspicious_basename("file.txt"));
}

/// A-20：读路径同样拒绝 ADS 冒号。
#[test]
fn read_path_rejects_ads_colon() {
    let chk = validate_read_path("C:\\Users\\test\\Desktop\\file.txt:hidden", &dirs());
    assert!(!chk.safe, "读路径必须与写路径对称地拒绝 ADS");
}

// ==================== 危险扩展名（P0-6） ====================

#[test]
fn write_rejects_executable_extension() {
    for ext in [".exe", ".bat", ".cmd", ".ps1", ".dll", ".vbs"] {
        let p = format!("C:\\Users\\test\\Desktop\\evil{ext}");
        let chk = validate_write_path(&p, &dirs());
        assert!(!chk.safe, "{ext} 必须拒绝写入");
    }
}

#[test]
fn write_allows_safe_extension() {
    for ext in [".txt", ".md", ".json", ".csv"] {
        let p = format!("C:\\Users\\test\\Desktop\\ok{ext}");
        let chk = validate_write_path(&p, &dirs());
        assert!(chk.safe, "{ext} 应允许写入，理由 {:?}", chk.reason);
    }
}

#[test]
fn write_rejects_system_dirs() {
    let chk = validate_write_path("C:\\Windows\\evil.txt", &dirs());
    assert!(!chk.safe);
}

// ==================== 打开路径（E-2 白名单兜底） ====================

#[test]
fn open_allows_whitelisted_extension() {
    let chk = validate_open_path("C:\\Users\\test\\Desktop\\doc.pdf", &dirs());
    assert!(chk.safe, "pdf 应允许打开，理由 {:?}", chk.reason);
}

#[test]
fn open_rejects_dangerous_extension() {
    let chk = validate_open_path("C:\\Users\\test\\Desktop\\evil.exe", &dirs());
    assert!(!chk.safe);
}

/// E-2 fail-closed：未知扩展名拒绝。
#[test]
fn open_rejects_unknown_extension() {
    let chk = validate_open_path("C:\\Users\\test\\Desktop\\weird.xyz", &dirs());
    assert!(!chk.safe, "未知扩展名必须 fail-closed");
}

/// E-2 fail-closed：无扩展名拒绝。
#[test]
fn open_rejects_no_extension() {
    let chk = validate_open_path("C:\\Users\\test\\Desktop\\noext", &dirs());
    assert!(!chk.safe);
}

// ==================== 扩展名提取 ====================

#[test]
fn extension_is_lowercased() {
    assert_eq!(
        get_safe_extension("C:\\a\\B.TXT"),
        Some(".txt".to_string())
    );
}

#[test]
fn extension_none_for_no_dot() {
    assert_eq!(get_safe_extension("C:\\a\\noext"), None);
}

#[test]
fn extension_none_for_ads() {
    assert_eq!(get_safe_extension("C:\\a\\file.txt:stream"), None);
}

// ==================== 单一 chokepoint ====================

fn sec_with_desktop() -> Security {
    Security::new(SecurityPolicy {
        allowed_dirs: dirs(),
        require_approval_for_writes: true,
        always_allow_prefixes: vec![],
        http_allowed_methods: vec!["GET".into(), "POST".into()],
    })
}

#[test]
fn authorize_shell_allowed_needs_approval() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::Shell {
        command: "ls".into(),
    });
    assert_eq!(v, Verdict::NeedsApproval);
}

#[test]
fn authorize_shell_denied_is_deny() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::Shell {
        command: "rm -rf /".into(),
    });
    assert!(v.is_deny());
}

#[test]
fn authorize_read_is_allow_without_approval() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::FileRead {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    });
    assert_eq!(v, Verdict::Allow, "读不需授权");
}

#[test]
fn authorize_write_needs_approval() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    });
    assert_eq!(v, Verdict::NeedsApproval);
}

#[test]
fn authorize_write_outside_dirs_denied() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::FileWrite {
        path: "C:\\Windows\\a.txt".into(),
    });
    assert!(v.is_deny());
}

#[test]
fn authorize_http_rejects_disallowed_method() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::Http {
        url: "https://x.com".into(),
        method: "DELETE".into(),
    });
    assert!(v.is_deny(), "DELETE 不在允许列表");
}

#[test]
fn authorize_http_rejects_non_http_scheme() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::Http {
        url: "file:///etc/passwd".into(),
        method: "GET".into(),
    });
    assert!(v.is_deny(), "仅允许 http/https");
}

#[test]
fn authorize_http_allows_valid() {
    let s = sec_with_desktop();
    let v = s.authorize(&Action::Http {
        url: "https://api.example.com/v1".into(),
        method: "GET".into(),
    });
    assert_eq!(v, Verdict::Allow);
}

#[test]
fn mcp_spawn_subject_to_shell_rules() {
    let s = sec_with_desktop();
    let bad = s.authorize(&Action::McpSpawn {
        command: "rm -rf /".into(),
    });
    assert!(bad.is_deny(), "MCP spawn 同样受白名单约束");
}

// ==================== 用户裁决 ====================

#[test]
fn apply_deny_blocks() {
    let mut s = sec_with_desktop();
    let a = Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    };
    assert!(s.apply_decision(&a, WriteDecision::Deny).is_deny());
}

#[test]
fn apply_once_allows_this_time() {
    let mut s = sec_with_desktop();
    let a = Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    };
    assert_eq!(s.apply_decision(&a, WriteDecision::Once), Verdict::Allow);
    // 未记入 always_allow，下次仍需授权
    assert_eq!(s.authorize(&a), Verdict::NeedsApproval);
}

#[test]
fn apply_always_remembers_prefix() {
    let mut s = sec_with_desktop();
    let a = Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    };
    assert_eq!(s.apply_decision(&a, WriteDecision::Always), Verdict::Allow);
    // 同目录下次直接 Allow
    let b = Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\b.txt".into(),
    };
    assert_eq!(s.authorize(&b), Verdict::Allow, "always 应记住目录前缀");
}

/// fail-closed 基线：默认策略下写操作一律拒（无允许目录）。
#[test]
fn deny_all_security_denies_writes() {
    let s = deny_all_security();
    let v = s.authorize(&Action::FileWrite {
        path: "C:\\Users\\test\\Desktop\\a.txt".into(),
    });
    assert!(v.is_deny(), "默认策略必须 fail-closed");
}

// ==================== is_within ====================

#[test]
fn is_within_matches_prefix_and_self() {
    let d = PathBuf::from("C:\\Users\\test\\Desktop");
    assert!(is_within(&PathBuf::from("C:\\Users\\test\\Desktop\\a.txt"), &d));
    assert!(is_within(&d, &d));
    assert!(!is_within(&PathBuf::from("C:\\Users\\test\\Desktop2\\a.txt"), &d));
}
